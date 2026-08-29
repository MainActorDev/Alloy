#!/usr/bin/env node
/** Demo: alloy runs an app — install artifact → open (launch-args) → snapshot → find → release. */
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
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  try { return JSON.parse(r.content?.[0]?.text ?? '{}'); } catch { return { raw: r.content?.[0]?.text }; }
};

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo', version: '0' } });

const show = (label, r) => console.log(`${r.code ? '✗' : '✓'} ${label}`, r.code ? JSON.stringify(r).slice(0, 160) : '');

// 1. install the artifact (built OUTSIDE alloy — xcbuddy/xcodebuild's job)
const inst = await call('alloy_apps', { action: 'install', path: '/tmp/alloy-demo-app/LionParcel.app', udid: UDID, app: 'com.lionparcel.services.consumer-dev' });
show('alloy_apps install (LionParcel.app)', inst);

// 2. open with launch-args (mock precondition) — acquires the device lease
const open = await call('alloy_apps', { action: 'open', app: 'com.lionparcel.services.consumer-dev', udid: UDID, launchArgs: ['-mock-data', 'faq-no-link'] });
show('alloy_apps open + launchArgs', open);

// 3. verify it's running — snapshot the home screen
await new Promise((r) => setTimeout(r, 6000));
const snap = await call('alloy_snapshot', { udid: UDID });
const nodes = snap.nodes ?? [];
console.log(`✓ alloy_snapshot: ${nodes.length} nodes, app = ${snap.appBundleId ?? snap.appName ?? '?'}`);
const labels = nodes.map((n) => n.label).filter(Boolean).slice(0, 5);
console.log('  first labels:', JSON.stringify(labels));

// 4. find an element in the running app
const found = await call('alloy_find', { udid: UDID, by: 'text', value: 'Masuk', action: 'none' });
show('alloy_find "Masuk"', found);

// 5. release
const rel = await call('alloy_release', { udid: UDID });
show('alloy_release', rel);

proc.kill();
