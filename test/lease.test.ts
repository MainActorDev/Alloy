import { describe, expect, it } from 'vitest';
import { acquireLease, decideLease, releaseLease, LeaseManager } from '../src/lease.ts';
import { AlloyError } from '../src/errors.ts';

const A = { engine: 'A' as const, holder: 'alloy_apps', mode: 'held' as const };
const B = { engine: 'B' as const, holder: 'alloy_flow', mode: 'held' as const };

describe('decideLease', () => {
  it('grants when free', () => {
    expect(decideLease(new Map(), 'u1', A)).toEqual({ type: 'grant' });
  });
  it('grants re-entrant same engine', () => {
    const m = new Map([['u1', { engine: 'A', holder: 'x', since: 1 }]]);
    expect(decideLease(m, 'u1', A).type).toBe('grant');
  });
  it('refuses cross-engine', () => {
    const m = new Map([['u1', { engine: 'A', holder: 'x', since: 1 }]]);
    const d = decideLease(m, 'u1', B);
    expect(d.type).toBe('refuse');
    if (d.type === 'refuse') expect(d.code).toBe('LEASE_HELD');
  });
});

describe('acquire/release', () => {
  it('acquire sets entry', () => {
    const m = new Map();
    acquireLease(m, 'u1', A);
    expect(m.get('u1')?.engine).toBe('A');
  });
  it('cross-engine acquire throws LEASE_HELD', () => {
    const m = new Map();
    acquireLease(m, 'u1', A);
    expect(() => acquireLease(m, 'u1', B)).toThrowError(AlloyError);
  });
  it('release by holder', () => {
    const m = new Map();
    acquireLease(m, 'u1', A);
    expect(releaseLease(m, 'u1', 'alloy_apps')).toBe(true);
    expect(m.has('u1')).toBe(false);
  });
  it('release wrong holder is a no-op', () => {
    const m = new Map();
    acquireLease(m, 'u1', A);
    expect(releaseLease(m, 'u1', 'someone-else')).toBe(false);
    expect(m.has('u1')).toBe(true);
  });
  it('handoff: release then other engine acquires', () => {
    const m = new Map();
    acquireLease(m, 'u1', A);
    releaseLease(m, 'u1', 'alloy_apps');
    expect(() => acquireLease(m, 'u1', B)).not.toThrow();
  });
});

describe('LeaseManager per-call', () => {
  it('auto-releases after fn', async () => {
    const lm = new LeaseManager();
    await lm.withPerCall('u1', 'alloy_snapshot', 'A', async () => 42);
    expect(lm.snapshot().has('u1')).toBe(false);
  });
  it('auto-releases on error', async () => {
    const lm = new LeaseManager();
    await expect(
      lm.withPerCall('u1', 'alloy_snapshot', 'A', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(lm.snapshot().has('u1')).toBe(false);
  });
  it('serializes same-device calls', async () => {
    const lm = new LeaseManager();
    const order: number[] = [];
    const t0 = lm.withPerCall('u1', 't1', 'A', async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
    });
    const t1 = lm.withPerCall('u1', 't2', 'A', async () => {
      order.push(3);
    });
    await Promise.all([t0, t1]);
    expect(order).toEqual([1, 2, 3]);
  });
});
