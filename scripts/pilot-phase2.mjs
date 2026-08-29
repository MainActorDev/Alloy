#!/usr/bin/env node
/** Phase-2 live pilot: measurement, native tree, flow w/ launch-args, video — real engines. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const UDID = process.argv[2] ?? '5640A847-E6A8-4293-A139-066B11F2CEA6';
const proc = spawn('node', ['bin/alloy.mjs'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();
let nextId = 1;
proc.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* ignore */ }
  }
});
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.content?.[0]?.text ?? '{}';
  try { return JSON.parse(text); } catch { return { raw: text }; }
};

const pass = [];
const fail = [];
const step = async (label, name, args, check) => {
  try {
    const r = await call(name, args);
    const ok = check ? check(r) : true;
    (ok ? pass : fail).push(label);
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ' — ' + JSON.stringify(r).slice(0, 260)}`);
    return r;
  } catch (e) {
    fail.push(label);
    console.log(`✗ ${label} — ${e.message.slice(0, 220)}`);
    return null;
  }
};

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pilot2', version: '0' } });
notify('notifications/initialized', {});

// 0. health
await step('health ok', 'alloy_health', {}, (r) => r.ok === true);

// 1. lease: engine A opens Settings
await step('apps open Settings', 'alloy_apps', { action: 'open', app: 'com.apple.Preferences', udid: UDID }, (r) => r.opened === 'com.apple.Preferences');

// 2. measure — engine B while engine A HOLDS the lease? Same device: B is cross-engine → expect LEASE_HELD first
await step('measure blocked while A holds lease', 'alloy_measure', { udid: UDID }, (r) => r.code === 'LEASE_HELD');

// 3. release → measure now works (handoff!)
await step('release A lease', 'alloy_release', { udid: UDID }, (r) => r.udid === UDID);
const measure = await step(
  'measure (B describe passthrough)',
  'alloy_measure',
  { udid: UDID },
  (r) => typeof r.description === 'string' && r.description.includes('AXGroup'),
);

// 4. golden identity: direct engine-B call vs alloy_measure output
if (measure) {
  const cfg = JSON.parse(readFileSync(join(process.env.HOME ?? '', '.alloy', 'engines.local.json'), 'utf8'));
  const runtimeDir = cfg.engineB.runtimeDir;
  const clientEntry = join(cfg.engineB.workspace, cfg.engineB.entry);
  const direct = JSON.parse(
    execFileSync(
      process.execPath,
      ['-e', `
      const { createToolsClient } = require(${JSON.stringify(clientEntry)});
      const c = createToolsClient({ paths: {
        bundlePath: ${JSON.stringify(join(runtimeDir, 'dist', 'tool-server.cjs'))},
        simulatorServerDir: ${JSON.stringify(join(runtimeDir, 'bin'))},
        nativeDevtoolsDir: ${JSON.stringify(join(runtimeDir, 'dylibs'))},
      } });
      c.callTool('describe', { udid: ${JSON.stringify(UDID)} }).then(r => { console.log(JSON.stringify(r.data)); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
      `],
      { env: process.env, cwd: repoRoot },
    ),
    'utf8',
  );
  // compare canonical JSON of description+source (the passthrough contract)
  const canon = (o) => JSON.stringify({ description: o.description, source: o.source });
  const same = canon(measure) === canon(direct);
  if (same) { pass.push('golden: alloy_measure ≡ direct engine call'); console.log('✓ golden: alloy_measure ≡ direct engine call'); }
  else { fail.push('golden mismatch'); console.log('✗ golden mismatch\n  alloy:', canon(measure).slice(0, 120), '\n  direct:', canon(direct).slice(0, 120)); }
}

// 5. video start → stop → verify playable MP4 (moov atom)
const vstart = await step('video start', 'alloy_video', { udid: UDID, action: 'start' }, (r) => r && !r.code);
await new Promise((r) => setTimeout(r, 2500));
if (vstart) {
  const vstop = await step('video stop', 'alloy_video', { udid: UDID, action: 'stop', label: 'alloy-p2-pilot' }, (r) => r && !r.code);
  if (vstop) {
    // find the video path from the result and check moov
    const vp = vstop.video?.hostPath ?? vstop.video?.path ?? vstop.video?.url ?? vstop.path ?? (typeof vstop === 'string' ? vstop : null);
    if (vp && existsSync(String(vp))) {
      const tail = readFileSync(String(vp)).slice(-65536);
      const playable = tail.includes('moov');
      (playable ? pass : fail).push(`video playable (moov) @ ${vp}`);
      console.log(`${playable ? '✓' : '✗'} video playable (moov) @ ${vp}`);
    } else {
      console.log('? video result shape:', JSON.stringify(vstop).slice(0, 200));
    }
  }
}

// 6. release everything
await step('final release', 'alloy_release', { udid: UDID }, () => true);

console.log(`\nPILOT2: ${pass.length} passed, ${fail.length} failed`);
proc.kill();
process.exit(fail.length === 0 ? 0 : 2);
