#!/usr/bin/env node
/** Phase-2 flow gate: run a real flow via alloy_flow. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const UDID = '5640A847-E6A8-4293-A139-066B11F2CEA6';
// Flow layout comes from the gitignored engines config — same as production.
const cfg = JSON.parse(readFileSync(join(process.env.HOME ?? '', '.alloy', 'engines.local.json'), 'utf8'));
const segs = cfg.engineB.flowsDirSegments ?? ['flows'];
const flowPath = join('/tmp/alloy-flow-proj', ...segs, 'alloy-p2-smoke.yaml');
const proc = spawn('node', ['bin/alloy.mjs'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let nextId = 1;
proc.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
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

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'flowgate', version: '0' } });
notify('notifications/initialized');

const r = await call('alloy_flow', { udid: UDID, flowPath });
console.log('flow result keys:', Object.keys(r));
const summary = { ok: r.ok, passed: r.passed, failed: r.failed, skipped: r.skipped, errored: r.errored, flow: r.flow };
console.log('summary:', JSON.stringify(summary));
if (r.steps) console.log('steps:', r.steps.map((s) => `${s.index}:${s.kind}:${s.status}`).join(' | '));
if (r.code) console.log('ERROR:', JSON.stringify(r).slice(0, 400));
const passOk = r.ok === true && (r.failed ?? 0) === 0 && (r.errored ?? 0) === 0;
console.log(passOk ? 'FLOW GATE: PASS' : 'FLOW GATE: FAIL');
proc.kill();
process.exit(passOk ? 0 : 2);
