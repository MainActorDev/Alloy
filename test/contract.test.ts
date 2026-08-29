/**
 * Contract tests: every routing row dispatches against a FAKE engine A module and
 * returns the fake's recorded calls. Proves adapter wiring per row without a device.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearRegistryForTests, dispatch } from '../src/tools.ts';
import { LeaseManager } from '../src/lease.ts';
import { registerPhase0Tools } from '../src/registrations.ts';
import { createServerState } from '../src/server.ts';
import { routingTable } from '../src/routing.ts';
import { resetEngineACacheForTests } from '../src/adapter-a.ts';
import { resetEngineBCacheForTests } from '../src/adapter-b.ts';
import {
  calls,
  makeFakeResolvedEngines,
  installFakeEngineAClient,
  fakeEngineAClient,
} from './contract.helpers.ts';

function freshRuntime() {
  clearRegistryForTests();
  resetEngineACacheForTests();
  resetEngineBCacheForTests();
  installFakeEngineAClient();
  calls.length = 0;
  const state = createServerState();
  state.resolved = makeFakeResolvedEngines();
  registerPhase0Tools({ state });
  // Production wiring: dispatch and state share ONE lease manager (see createRuntime)
  const leases = new LeaseManager();
  state.leases = leases;
  return { state, deps: { leases, adapters: {} } };
}

const VALID_INPUTS: Record<string, unknown> = {
  alloy_health: {},
  alloy_devices: { action: 'list' },
  alloy_apps: { action: 'list' },
  alloy_release: { udid: 'SIM-1' },
  alloy_snapshot: { udid: 'SIM-1' },
  alloy_act: { udid: 'SIM-1', action: 'press', target: '@e5' },
  alloy_find: { udid: 'SIM-1', by: 'text', value: 'Masuk', action: 'tap' },
  alloy_alert: { udid: 'SIM-1', action: 'accept' },
  alloy_settings: { udid: 'SIM-1', area: 'airplane', values: { state: 'on' } },
  alloy_measure: { udid: 'SIM-1' },
  alloy_native_tree: { udid: 'SIM-1' },
  alloy_flow: { udid: 'SIM-1', flowPath: '/tmp/proj/flows/smoke.yaml' },
  alloy_video: { udid: 'SIM-1', action: 'start' },
  alloy_screenshot_diff: { baselinePath: '/tmp/a.png', currentPath: '/tmp/b.png' },
  alloy_flow_report: {},
  alloy_network: { udid: 'SIM-1' },
  alloy_logs: { udid: 'SIM-1', action: 'capture' },
  alloy_perf: { udid: 'SIM-1', area: 'frames' },
  alloy_push: { udid: 'SIM-1', app: 'com.example.app', payload: { aps: { alert: 'hi' } } },
  alloy_js_debug: { udid: 'SIM-1', action: 'status' },
  alloy_replay: { udid: 'SIM-1', scriptPath: '/tmp/session.ad' },
};

describe('routing table contract (generated)', () => {
  beforeEach(() => {
    freshRuntime();
  });

  it('every row accepts its valid input and dispatches ok', async () => {
    for (const row of routingTable) {
      const input = VALID_INPUTS[row.tool];
      expect(input, `valid input fixture for ${row.tool}`).toBeDefined();
      const rt = freshRuntime();
      const r = await dispatch(row.tool, input, rt.deps);
      expect(r.ok, `${row.tool}: ${r.ok ? '' : JSON.stringify(r.error)}`).toBe(true);
    }
  });

  it('engine-A rows hit the fake engine (adapter wiring live)', async () => {
    const rt = freshRuntime();
    await dispatch('alloy_snapshot', { udid: 'SIM-1' }, rt.deps);
    await dispatch('alloy_find', { udid: 'SIM-1', by: 'text', value: 'OK', action: 'tap' }, rt.deps);
    await dispatch('alloy_settings', { udid: 'SIM-1', area: 'airplane', values: { state: 'on' } }, rt.deps);
    const sigs = calls.map((c) => `${c.ns}.${c.method}`);
    expect(sigs).toContain('capture.snapshot');
    expect(sigs).toContain('interactions.find');
    expect(sigs).toContain('settings.update');
  });

  it('target mapping: @ref → ref target; text → selector', async () => {
    const rt = freshRuntime();
    await dispatch('alloy_act', { udid: 'SIM-1', action: 'press', target: '@e12' }, rt.deps);
    await dispatch('alloy_act', { udid: 'SIM-1', action: 'press', target: 'Sign In' }, rt.deps);
    const pressCalls = calls.filter((c) => c.method === 'press');
    const first = pressCalls[0]?.args as { target: { kind: string } } | undefined;
    const second = pressCalls[1]?.args as { target: { kind: string } } | undefined;
    expect(first?.target).toMatchObject({ kind: 'ref', ref: '@e12' });
    expect(second?.target.kind).toBe('selector');
  });

  it('find maps by/value → engine query with first:true; tap → action:click', async () => {
    const rt = freshRuntime();
    await dispatch('alloy_find', { udid: 'SIM-1', by: 'text', value: 'OK', action: 'tap' }, rt.deps);
    const args = calls.find((c) => c.method === 'find')?.args as { query: string; first: boolean; action?: string };
    expect(args.query).toBe('text="OK"');
    expect(args.first).toBe(true);
    expect(args.action).toBe('click');
  });

  it('apps.open maps launchArgs and returns session fields', async () => {
    const rt = freshRuntime();
    const r = await dispatch(
      'alloy_apps',
      { action: 'open', app: 'com.example.app', udid: 'SIM-1', launchArgs: ['-mock-data', 'x'] },
      rt.deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const res = r.result as { session: string; appBundleId: string };
      expect(res.session).toBe('alloy');
      expect(res.appBundleId).toBe('com.example.app');
    }
    const open = calls.find((c) => c.method === 'open')?.args as { app: string; launchArgs?: string[]; foreground?: boolean };
    expect(open.app).toBe('com.example.app');
    expect(open.launchArgs).toEqual(['-mock-data', 'x']);
    expect(open.foreground).toBe(true);
  });

  it('open acquires held lease; release clears it and closes engine session', async () => {
    const rt = freshRuntime();
    await dispatch(
      'alloy_apps',
      { action: 'open', app: 'com.example.app', udid: 'SIM-1' },
      rt.deps,
    );
    expect(rt.state.leases.snapshot().get('SIM-1')?.holder).toBe('alloy_apps');
    const r = await dispatch('alloy_release', { udid: 'SIM-1' }, rt.deps);
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.method === 'close')).toBe(true);
    expect(rt.state.leases.snapshot().has('SIM-1')).toBe(false);
  });

  it('release swallows SESSION_NOT_FOUND from the engine', async () => {
    const rt = freshRuntime();
    const g = fakeEngineAClient();
    const orig = g.sessions.close;
    g.sessions.close = (() => {
      const e = new Error('no session') as Error & { code: string };
      e.code = 'SESSION_NOT_FOUND';
      return Promise.reject(e);
    }) as typeof orig;
    const r = await dispatch('alloy_release', { udid: 'SIM-9' }, rt.deps);
    expect(r.ok).toBe(true);
    g.sessions.close = orig;
  });

  it('engine typed errors normalize (DEVICE_IN_USE keeps code + details)', async () => {
    const rt = freshRuntime();
    const g = fakeEngineAClient();
    const orig = g.capture.snapshot;
    g.capture.snapshot = (() => {
      const e = new Error('device busy') as Error & { code: string; details: Record<string, unknown> };
      e.code = 'DEVICE_IN_USE';
      e.details = { retriable: true, reason: 'DEVICE_CLAIM_LIVE_OWNER', hint: 'close --session' };
      return Promise.reject(e);
    }) as typeof orig;
    const r = await dispatch('alloy_snapshot', { udid: 'SIM-1' }, rt.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('DEVICE_IN_USE');
      expect(r.error.engine).toBe('A');
      expect(r.error.details?.retriable).toBe(true);
      expect(r.error.details?.reason).toBe('DEVICE_CLAIM_LIVE_OWNER');
    }
    g.capture.snapshot = orig;
  });

  it('unknown engine code falls to UNKNOWN_ENGINE_CODE (default branch)', async () => {
    const rt = freshRuntime();
    const g = fakeEngineAClient();
    const orig = g.capture.snapshot;
    g.capture.snapshot = (() => {
      const e = new Error('weird') as Error & { code: string };
      e.code = 'SOMETHING_NEW_2099';
      return Promise.reject(e);
    }) as typeof orig;
    const r = await dispatch('alloy_snapshot', { udid: 'SIM-1' }, rt.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('UNKNOWN_ENGINE_CODE');
      expect(r.error.details?.engineCode).toBe('SOMETHING_NEW_2099');
    }
    g.capture.snapshot = orig;
  });
});

describe('freshness gate (Phase 5a, dispatch-level)', () => {
  it('stale srcPath → STALE_ARTIFACT and the engine never sees install', async () => {
    const rt = freshRuntime();
    const srcDir = mkdtempSync(join(tmpdir(), 'alloy-src-'));
    writeFileSync(join(srcDir, 'Main.swift'), 'let x = 1\n');
    utimesSync(join(srcDir, 'Main.swift'), T_FUTURE, T_FUTURE); // newer than artifact
    const art = join(srcDir, 'Old.app');
    writeFileSync(art, 'bin');
    utimesSync(art, T_PAST, T_PAST);
    calls.length = 0;
    const r = await dispatch(
      'alloy_apps',
      { action: 'install', path: art, srcPath: srcDir, app: 'com.example.app', udid: 'SIM-1' },
      rt.deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('STALE_ARTIFACT');
      expect(r.error.details?.retriable).toBe(true);
      expect(r.error.details?.newestSourcePath).toContain('Main.swift');
    }
    expect(calls.some((c) => c.method === 'install')).toBe(false); // engine untouched
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('fresh srcPath → install proceeds to the engine', async () => {
    const rt = freshRuntime();
    const srcDir = mkdtempSync(join(tmpdir(), 'alloy-src-'));
    writeFileSync(join(srcDir, 'Main.swift'), 'let x = 1\n');
    utimesSync(join(srcDir, 'Main.swift'), T_PAST, T_PAST); // older than artifact
    const art = join(srcDir, 'Fresh.app');
    writeFileSync(art, 'bin');
    utimesSync(art, T_FUTURE, T_FUTURE);
    calls.length = 0;
    const r = await dispatch(
      'alloy_apps',
      { action: 'install', path: art, srcPath: srcDir, app: 'com.example.app', udid: 'SIM-1' },
      rt.deps,
    );
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.method === 'install')).toBe(true);
    rmSync(srcDir, { recursive: true, force: true });
  });
});

const T_PAST = Date.parse('2026-01-01T00:00:00Z') / 1000;
const T_FUTURE = Date.parse('2027-01-01T00:00:00Z') / 1000;

describe('A4: hold:false (session without lease)', () => {
  it('open with hold:false does NOT acquire the lease', async () => {
    const rt = freshRuntime();
    const r = await dispatch('alloy_apps', { action: 'open', app: 'com.example.app', udid: 'SIM-1', hold: false }, rt.deps);
    expect(r.ok).toBe(true);
    expect(rt.state.leases.snapshot().has('SIM-1')).toBe(false);
    // engine open was still called
    expect(calls.some((c) => c.method === 'open')).toBe(true);
  });
  it('open with hold:false then B-flow is allowed (no cross-engine conflict)', async () => {
    const rt = freshRuntime();
    await dispatch('alloy_apps', { action: 'open', app: 'com.example.app', udid: 'SIM-1', hold: false }, rt.deps);
    const flow = await dispatch('alloy_flow', { udid: 'SIM-1', flowPath: '/tmp/proj/flows/smoke.yaml' }, rt.deps);
    expect(flow.ok).toBe(true);
    // flow is per-call: lease auto-released after execution
    expect(rt.state.leases.snapshot().has('SIM-1')).toBe(false);
  });
  it('default open still acquires (back-compat)', async () => {
    const rt = freshRuntime();
    await dispatch('alloy_apps', { action: 'open', app: 'com.example.app', udid: 'SIM-1' }, rt.deps);
    expect(rt.state.leases.snapshot().get('SIM-1')?.holder).toBe('alloy_apps');
  });
  it('release closes session even when hold:false', async () => {
    const rt = freshRuntime();
    await dispatch('alloy_apps', { action: 'open', app: 'com.example.app', udid: 'SIM-1', hold: false }, rt.deps);
    const rel = await dispatch('alloy_release', { udid: 'SIM-1' }, rt.deps);
    expect(rel.ok).toBe(true);
    expect(calls.some((c) => c.ns === 'sessions' && c.method === 'close')).toBe(true);
  });
});

describe('holdsWhen: only open-style calls hold', () => {
  it('install does NOT acquire the lease → engine-B flow afterwards is allowed', async () => {
    const rt = freshRuntime();
    const inst = await dispatch('alloy_apps', { action: 'install', path: '/tmp/a.app', app: 'x', udid: 'SIM-1' }, rt.deps);
    expect(inst.ok).toBe(true);
    expect(rt.state.leases.snapshot().has('SIM-1')).toBe(false);
    const flow = await dispatch('alloy_flow', { udid: 'SIM-1', flowPath: '/tmp/proj/flows/smoke.yaml' }, rt.deps);
    expect(flow.ok).toBe(true);
  });
  it('open still acquires (default path unchanged)', async () => {
    const rt = freshRuntime();
    await dispatch('alloy_apps', { action: 'open', app: 'x', udid: 'SIM-1' }, rt.deps);
    expect(rt.state.leases.snapshot().get('SIM-1')?.holder).toBe('alloy_apps');
  });
});
