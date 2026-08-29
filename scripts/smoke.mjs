#!/usr/bin/env node
/** MCP smoke client: spawn the built server, tools/list, call alloy_health, verify. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const proc = spawn('node', ['bin/alloy.mjs'], {
  cwd: repoRoot,
  stdio: ['pipe', 'pipe', 'inherit'],
});

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
    } catch {
      /* non-JSON line on stdout — ignore */
    }
  }
});

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  });
  console.log('initialized:', init.serverInfo.name, init.serverInfo.version);
  notify('notifications/initialized', {});

  const tools = await rpc('tools/list', {});
  const names = tools.tools.map((t) => t.name);
  console.log('tools/list count:', names.length);
  console.log('tools:', names.join(', '));

  const health = await rpc('tools/call', { name: 'alloy_health', arguments: {} });
  const report = JSON.parse(health.content[0].text);
  console.log('health.ok:', report.ok, '| degraded:', report.degraded);
  console.log('engineA:', JSON.stringify(report.engines.A.importable), 'version:', report.engines.A.versionReported, 'skew:', report.engines.A.skew);
  console.log('engineB importable:', report.engines.B.importable);

  if (!report.ok) {
    console.log('DIAGNOSTICS:', JSON.stringify(report, null, 2).slice(0, 2000));
  }
  const pass = report.ok && report.engines.A.importable && report.engines.B.importable;
  console.log(pass ? 'SMOKE PASS' : 'SMOKE INCOMPLETE (see diagnostics)');
  proc.kill();
  process.exit(pass ? 0 : 2);
} catch (err) {
  console.error('SMOKE FAIL:', err.message);
  proc.kill();
  process.exit(1);
}
