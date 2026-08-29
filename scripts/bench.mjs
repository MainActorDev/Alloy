#!/usr/bin/env node
/**
 * Phase-4 bench: facade overhead per call — paired interleaved protocol (PLAN §8.4).
 * Alternates alloy_measure vs direct engine-B call on a settled screen; N pairs
 * after warmup; metric = median of per-pair deltas. Writes bench/baseline.json.
 * Usage: node scripts/bench.mjs [udid]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const UDID = process.argv[2] ?? '5640A847-E6A8-4293-A139-066B11F2CEA6';
const HOME = process.env.HOME;

// engine paths from gitignored config (same as production)
const cfgPath = join(HOME, '.alloy', 'engines.local.json');
const cfg = JSON.parse(require('node:fs').readFileSync(cfgPath, 'utf8'));

// ── direct client (engine B) ────────────────────────────────────────────────
const { createToolsClient } = require(join(cfg.engineB.workspace, cfg.engineB.entry));
const direct = createToolsClient({
  paths: {
    bundlePath: join(cfg.engineB.runtimeDir, 'dist', 'tool-server.cjs'),
    simulatorServerDir: join(cfg.engineB.runtimeDir, 'bin'),
    nativeDevtoolsDir: join(cfg.engineB.runtimeDir, 'dylibs'),
  },
});

// ── alloy via MCP stdio ─────────────────────────────────────────────────────
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

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bench', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

const alloyMeasure = async () => {
  const t0 = performance.now();
  const r = await rpc('tools/call', { name: 'alloy_measure', arguments: { udid: UDID } });
  const ms = performance.now() - t0;
  const parsed = JSON.parse(r.content[0].text);
  if (parsed.code) throw new Error('alloy_measure failed: ' + parsed.code);
  return ms;
};
const directMeasure = async () => {
  const t0 = performance.now();
  const r = await direct.callTool('describe', { udid: UDID });
  const ms = performance.now() - t0;
  if (!r || !r.data) throw new Error('direct describe failed');
  return ms;
};

// ensure a session exists (measure needs an open app for the AX tree)
// warmup: 3 rounds each, interleaved
for (let i = 0; i < 3; i++) {
  await directMeasure().catch(() => {});
  await alloyMeasure().catch(() => {});
}

const N = 30;
const deltas = [];
const alloyTimes = [];
const directTimes = [];
for (let i = 0; i < N; i++) {
  const d = await directMeasure();
  const a = await alloyMeasure();
  alloyTimes.push(a);
  directTimes.push(d);
  deltas.push(a - d);
}
proc.kill();

const sorted = [...deltas].sort((x, y) => x - y);
const median = sorted[Math.floor(sorted.length / 2)];
const p95 = sorted[Math.floor(sorted.length * 0.95)];
const result = {
  tool: 'alloy_measure',
  protocol: 'paired-interleaved',
  pairs: N,
  date: new Date().toISOString(),
  medianOverheadMs: Math.round(median * 10) / 10,
  p95OverheadMs: Math.round(p95 * 10) / 10,
  budget: { p95OverheadMs: 15 },
  medianAlloyMs: Math.round([...alloyTimes].sort((x, y) => x - y)[Math.floor(N / 2)]),
  medianDirectMs: Math.round([...directTimes].sort((x, y) => x - y)[Math.floor(N / 2)]),
};
mkdirSync(join(repoRoot, 'bench'), { recursive: true });
writeFileSync(join(repoRoot, 'bench', 'baseline.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
const pass = result.p95OverheadMs <= result.budget.p95OverheadMs;
console.log(pass ? 'BENCH PASS (p95 ≤ 15ms)' : 'BENCH FAIL (p95 > 15ms)');
process.exit(pass ? 0 : 2);
