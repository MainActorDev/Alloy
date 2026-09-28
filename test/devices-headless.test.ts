/** alloy_devices boot input threading: headless reaches the engine-A client. */
import { describe, expect, it } from 'vitest';
import { clearRegistryForTests, dispatch } from '../src/tools.ts';
import { registerPhase0Tools } from '../src/registrations.ts';
import { createServerState } from '../src/server.ts';
import { LeaseManager } from '../src/lease.ts';
import {
  calls,
  installFakeEngineAClient,
  makeFakeResolvedEngines,
} from './contract.helpers.ts';

function freshDeps() {
  clearRegistryForTests();
  installFakeEngineAClient();
  const state = createServerState();
  state.resolved = makeFakeResolvedEngines();
  registerPhase0Tools({ state });
  return { state, deps: { leases: new LeaseManager(), adapters: {} } };
}

describe('alloy_devices headless boot', () => {
  it('boot with headless forwards the option to the engine client', async () => {
    const { deps } = freshDeps();
    calls.length = 0;
    const r = await dispatch('alloy_devices', { action: 'boot', udid: 'SIM-1', headless: true }, deps);
    expect(r.ok).toBe(true);
    const bootCall = calls.find((c) => c.ns === 'devices' && c.method === 'boot');
    expect(bootCall).toBeTruthy();
    expect(bootCall?.args).toEqual({ udid: 'SIM-1', headless: true });
  });

  it('boot without headless forwards only the udid (default GUI behavior)', async () => {
    const { deps } = freshDeps();
    calls.length = 0;
    const r = await dispatch('alloy_devices', { action: 'boot', udid: 'SIM-1' }, deps);
    expect(r.ok).toBe(true);
    const bootCall = calls.find((c) => c.ns === 'devices' && c.method === 'boot');
    expect(bootCall?.args).toEqual({ udid: 'SIM-1' });
  });
});
