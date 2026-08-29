/** Shared fake engine A for tests — recorded client + resolved engines config. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ResolvedEngines } from '../src/engines.ts';

export const calls: Array<{ ns: string; method: string; args: unknown }> = [];

function fakeClient() {
  const rec = (ns: string, method: string) => {
    return (args?: unknown) => {
      calls.push({ ns, method, args });
      if (method === 'list' && ns === 'devices')
        return Promise.resolve([{ id: 'SIM-1', name: 'Fake iPhone', state: 'Booted', platform: 'ios' }]);
      if (method === 'open')
        return Promise.resolve({
          session: 'alloy',
          appBundleId: 'com.example.app',
          device: { id: 'SIM-1' },
          selection: { reason: 'explicit-selector' },
        });
      return Promise.resolve({ ok: true, fake: `${ns}.${method}` });
    };
  };
  return {
    devices: { list: rec('devices', 'list'), boot: rec('devices', 'boot'), shutdown: rec('devices', 'shutdown') },
    apps: {
      open: rec('apps', 'open'),
      install: rec('apps', 'install'),
      reinstall: rec('apps', 'reinstall'),
      list: rec('apps', 'list'),
      close: rec('apps', 'close'),
      push: rec('apps', 'push'),
    },
    capture: {
      snapshot: rec('capture', 'snapshot'),
      screenshot: rec('capture', 'screenshot'),
    },
    interactions: {
      press: rec('interactions', 'press'),
      longPress: rec('interactions', 'longpress'),
      fill: rec('interactions', 'fill'),
      scroll: rec('interactions', 'scroll'),
      find: rec('interactions', 'find'),
    },
    command: { alert: rec('command', 'alert') },
    settings: { update: rec('settings', 'update') },
    sessions: { close: rec('sessions', 'close') },
    observability: {
      logs: rec('observability', 'logs'),
      network: rec('observability', 'network'),
      perf: rec('observability', 'perf'),
    },
    replay: { run: rec('replay', 'run') },
  };
}

export function installFakeEngineAClient(): void {
  (globalThis as Record<string, unknown>)['__alloyFakeA'] = fakeClient();
  (globalThis as Record<string, unknown>)['__alloyFakeB'] = fakeToolsClient();
}

function fakeToolsClient() {
  return {
    fetchTools: () => Promise.resolve([{ name: 'describe' }, { name: 'native-full-hierarchy' }, { name: 'flow-execute' }]),
    fetchTool: (name: string) => Promise.resolve({ name }),
    callTool: (name: string, args: unknown) => {
      calls.push({ ns: 'B', method: name, args });
      if (name === 'describe') return Promise.resolve({ data: { description: 'ROOT AXGroup (0,0,1,1)', source: 'ax' } });
      return Promise.resolve({ data: { ok: true, tool: name } });
    },
    baseUrl: () => Promise.resolve({ url: 'http://127.0.0.1:1', token: '' }),
  };
}

export function fakeEngineBClient() {
  return (globalThis as Record<string, unknown>)['__alloyFakeB'] as ReturnType<typeof fakeToolsClient>;
}

export function fakeEngineAClient() {
  return (globalThis as Record<string, unknown>)['__alloyFakeA'] as ReturnType<typeof fakeClient>;
}

export function makeFakeResolvedEngines(): ResolvedEngines {
  const dir = mkdtempSync(join(tmpdir(), 'alloy-fake-'));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'entry-a.mjs'), `export function createClient() { return globalThis.__alloyFakeA; }\n`);
  writeFileSync(join(dir, 'entry-b.mjs'), `export function createClient() { return globalThis.__alloyFakeB; }\n`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake-engine', version: '1.0.0' }));
  return {
    engineA: {
      module: dir,
      entry: 'entry-a.mjs',
      version: '1.0.0',
      importUrl: pathToFileURL(join(dir, 'entry-a.mjs')).href,
    },
    engineB: {
      workspace: dir,
      entry: 'entry-b.mjs',
      importUrl: pathToFileURL(join(dir, 'entry-b.mjs')).href,
    },
  };
}
