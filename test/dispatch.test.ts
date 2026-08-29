import { describe, expect, it } from 'vitest';
import { clearRegistryForTests, dispatch, defineToolFromRow, listRegisteredTools, replaceToolHandlerForTests } from '../src/tools.ts';
import { routingTable } from '../src/routing.ts';
import { LeaseManager } from '../src/lease.ts';
import { registerPhase0Tools } from '../src/registrations.ts';
import { createServerState } from '../src/server.ts';
import { AlloyError } from '../src/errors.ts';
import { makeFakeResolvedEngines, installFakeEngineAClient } from './contract.helpers.ts';

function freshDeps() {
  clearRegistryForTests();
  installFakeEngineAClient();
  const state = createServerState();
  state.resolved = makeFakeResolvedEngines();
  registerPhase0Tools({ state });
  return { state, deps: { leases: new LeaseManager(), adapters: {} } };
}

describe('dispatch choke point', () => {
  it('unknown tool → TOOL_NOT_FOUND', async () => {
    const { deps } = freshDeps();
    const r = await dispatch('alloy_nope', {}, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TOOL_NOT_FOUND');
  });
  it('invalid input → VALIDATION_FAILED with reasons', async () => {
    const { deps } = freshDeps();
    const r = await dispatch('alloy_devices', { action: 'boot' }, deps); // missing udid
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION_FAILED');
      expect(r.error.details?.reason).toContain('udid');
    }
  });
  it('unknown keys rejected', async () => {
    const { deps } = freshDeps();
    const r = await dispatch('alloy_devices', { action: 'list', bogus: 1 }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });
  it('valid input passes to handler', async () => {
    const { deps } = freshDeps();
    const r = await dispatch('alloy_devices', { action: 'list' }, deps);
    expect(r.ok).toBe(true);
  });
  it('held-lease tool acquires and releases on error (alloy_flow stub)', async () => {
    const { deps } = freshDeps();
    replaceToolHandlerForTests('alloy_flow', async () => {
      throw new Error('flow exploded');
    });
    const r = await dispatch('alloy_flow', { udid: 'u1', flowPath: '/tmp/f.yaml' }, deps);
    expect(r.ok).toBe(false);
    expect(deps.leases.snapshot().has('u1')).toBe(false);
  });
  it('held lease blocks cross-engine tool', async () => {
    const { deps } = freshDeps();
    deps.leases.acquireHeld('u1', 'alloy_apps', 'A');
    // alloy_flow is engine B; cross-engine while A holds → LEASE_HELD
    const r = await dispatch('alloy_flow', { udid: 'u1', flowPath: '/tmp/f.yaml' }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('LEASE_HELD');
  });
  it('zod default applied (interactiveOnly default true)', async () => {
    const { deps } = freshDeps();
    const r = await dispatch('alloy_snapshot', { udid: 'u1' }, deps);
    expect(r.ok).toBe(true);
    // default reached the engine: fake recorded interactiveOnly true
    const { calls } = await import('./contract.helpers.ts');
    const snap = calls.find((c) => c.method === 'snapshot')?.args as { interactiveOnly?: boolean };
    expect(snap?.interactiveOnly).toBe(true);
  });
});

describe('registration', () => {
  it('registering same tool twice throws', () => {
    freshDeps();
    const row = routingTable.find((r) => r.tool === 'alloy_health')!;
    expect(() => defineToolFromRow(row, async () => 1)).toThrowError(AlloyError);
  });
  it('every routing row is registered (production registration path)', async () => {
    // createRuntime performs the production registration; verify via a fresh runtime
    const { createRuntime } = await import('../src/server.ts');
    const runtime = await createRuntime('/nonexistent/config.json');
    const registered = new Set(listRegisteredTools().map((t) => t.row.tool));
    for (const r of routingTable) expect(registered.has(r.tool), r.tool).toBe(true);
    expect(runtime.state.configError).toBeTruthy();
  });
});

describe('dispatch-level lease enforcement (B4 regression)', () => {
  it('per-call tool auto-releases lease through dispatch', async () => {
    const { deps } = freshDeps();
    const r = await dispatch('alloy_snapshot', { udid: 'uX' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.leases.snapshot().has('uX')).toBe(false);
  });
  it('held lease on device blocks cross-engine per-call tool via dispatch', async () => {
    const { deps } = freshDeps();
    deps.leases.acquireHeld('uY', 'alloy_apps', 'A');
    const r = await dispatch('alloy_measure', { udid: 'uY' }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('LEASE_HELD');
  });
  it('same-engine per-call proceeds while same engine holds lease', async () => {
    const { deps } = freshDeps();
    deps.leases.acquireHeld('uZ', 'alloy_apps', 'A');
    const r = await dispatch('alloy_snapshot', { udid: 'uZ' }, deps);
    expect(r.ok).toBe(true);
    // held lease untouched
    expect(deps.leases.snapshot().get('uZ')?.holder).toBe('alloy_apps');
  });
});
