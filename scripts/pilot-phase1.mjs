#!/usr/bin/env node
/** Phase-1 live pilot: Settings.app home→search through ALLOY tools only. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

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
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ' — ' + JSON.stringify(r).slice(0, 220)}`);
    return r;
  } catch (e) {
    fail.push(label);
    console.log(`✗ ${label} — ${e.message.slice(0, 200)}`);
    return null;
  }
};

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pilot', version: '0' } });
notify('notifications/initialized', {});

// 1. health
await step('health ok', 'alloy_health', {}, (r) => r.ok === true);

// 2. devices list (engine A live)
const devs = await step('devices list', 'alloy_devices', { action: 'list' }, (r) => Array.isArray(r) && r.some((d) => d.id === UDID));
if (!devs) { proc.kill(); process.exit(1); }

// 3. open Settings (held lease; launchArgs verbatim)
await step(
  'apps open Settings',
  'alloy_apps',
  { action: 'open', app: 'com.apple.Preferences', udid: UDID },
  (r) => r.opened === 'com.apple.Preferences',
);

// 4. snapshot — nodes present
let snap = await step('snapshot interactive', 'alloy_snapshot', { udid: UDID }, (r) => Array.isArray(r.nodes) && r.nodes.length > 3);
if (!snap) { proc.kill(); process.exit(1); }

// 5. act — press a visible control by ref (first button-ish node)
const target = snap.nodes.find((n) => n.role === 'button') ?? snap.nodes.find((n) => n.ref);
if (target) {
  await step(
    `act press @${target.ref}`,
    'alloy_act',
    { udid: UDID, action: 'press', target: `@${target.ref}`, settle: false },
    (r) => r && !r.code,
  );
  // go back home for the next steps
  await call('alloy_act', { udid: UDID, action: 'press', target: '@e1', settle: false }).catch(() => {});
}

// 6. find — locate by text (exists)
await step('find General', 'alloy_find', { udid: UDID, by: 'text', value: 'General', action: 'none' }, (r) => r && !r.code);

// 7. release — lease cleared
await step('release', 'alloy_release', { udid: UDID }, (r) => r.leaseReleased === true || r.udid === UDID);

// 8. health shows no leases
await step('health: zero leases after release', 'alloy_health', {}, (r) => Array.isArray(r.leases) && r.leases.length === 0);

console.log(`\nPILOT: ${pass.length} passed, ${fail.length} failed`);
proc.kill();
process.exit(fail.length === 0 ? 0 : 2);
