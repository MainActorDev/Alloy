#!/usr/bin/env node
/** Phase-3 live gate: diagnostics during a real session. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const UDID = '5640A847-E6A8-4293-A139-066B11F2CEA6';
const proc = spawn('node', ['bin/alloy.mjs'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let nextId = 1;
proc.stdout.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!l) continue;
    try {
      const m = JSON.parse(l);
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    } catch { /* ignore */ }
  }
});
const rpc = (method, params) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const notify = (m) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: m, params: {} }) + '\n');
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  try { return JSON.parse(r.content?.[0]?.text ?? '{}'); } catch { return { raw: r.content?.[0]?.text }; }
};
const pass = [], fail = [];
const step = async (label, name, args, check) => {
  try {
    const r = await call(name, args);
    const ok = check ? check(r) : true;
    (ok ? pass : fail).push(label);
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ' — ' + JSON.stringify(r).slice(0, 240)}`);
    return r;
  } catch (e) {
    fail.push(label);
    console.log(`✗ ${label} — ${e.message.slice(0, 200)}`);
    return null;
  }
};

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p3', version: '0' } });
notify('notifications/initialized');

await step('health ok', 'alloy_health', {}, (r) => r.ok === true);
await step('open Settings', 'alloy_apps', { action: 'open', app: 'com.apple.Preferences', udid: UDID }, (r) => r.opened === 'com.apple.Preferences');

// logs: start → mark → capture (stop last — a stop timeout can kill the session)
await step('logs start', 'alloy_logs', { udid: UDID, action: 'start' }, (r) => r && !r.code);
await step('logs mark', 'alloy_logs', { udid: UDID, action: 'mark', message: 'before-submit' }, (r) => r && !r.code);
const logs = await step('logs capture', 'alloy_logs', { udid: UDID, action: 'capture' }, (r) => r && !r.code);
if (logs) console.log('   logs sample:', JSON.stringify(logs).slice(0, 160));

// network + perf while the session is definitely alive
const net = await step('network dump', 'alloy_network', { udid: UDID, limit: 10 }, (r) => r && !r.code);
if (net) console.log('   network sample:', JSON.stringify(net).slice(0, 140));
await step('perf frames sample', 'alloy_perf', { udid: UDID, area: 'frames' }, (r) => r && !r.code);
await step('perf memory sample (ps snapshot)', 'alloy_perf', { udid: UDID, area: 'memory' }, (r) => r && !r.code);

// logs stop — tolerate one timeout (transient runner kill invalidates nothing else now)
{
  let r = await call('alloy_logs', { udid: UDID, action: 'stop' });
  if (r.code === 'COMMAND_FAILED' && /timed out/i.test(String(r.message))) {
    console.log('   logs stop timed out — retrying once');
    await new Promise((res) => setTimeout(res, 1500));
    r = await call('alloy_logs', { udid: UDID, action: 'stop' });
  }
  const ok = !r.code;
  (ok ? pass : fail).push('logs stop');
  console.log(`${ok ? '✓' : '✗'} logs stop`);
}

// js_debug: Settings is NOT a JS app — connect must fail with STRUCTURED error, not crash
await step('js_debug connect fails structurally (not RN app)', 'alloy_js_debug', { udid: UDID, action: 'connect' }, (r) => typeof r.code === 'string' && typeof r.message === 'string');

// replay: nonexistent script must fail with structured error
await step('replay missing script fails structurally', 'alloy_replay', { udid: UDID, scriptPath: '/tmp/does-not-exist.ad' }, (r) => typeof r.code === 'string');

await step('release', 'alloy_release', { udid: UDID }, () => true);

console.log(`\nGATE-P3: ${pass.length} passed, ${fail.length} failed`);
proc.kill();
process.exit(fail.length === 0 ? 0 : 2);
