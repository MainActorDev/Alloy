/**
 * Device lease state machine — pure functions, exhaustively tested (test/unit).
 * Invariant: one active engine per device. Held leases (alloy_apps open, flows,
 * replay) block the other engine; per-call leases acquire→dispatch→auto-release.
 * Release-on-error is mandatory and handled by dispatch().
 */
import { AlloyError } from './errors.ts';
import type { EngineId } from './routing.ts';

export interface LeaseEntry {
  engine: EngineId;
  holder: string; // tool that acquired the lease
  since: number; // epoch ms
}

export type LeaseMap = ReadonlyMap<string, LeaseEntry>;

export type LeaseDecision =
  | { type: 'grant' }
  | { type: 'refuse'; code: 'LEASE_HELD'; holder: string; engine: EngineId };

interface LeaseOptions {
  engine: EngineId;
  holder: string;
  mode: 'per-call' | 'held';
}

export function decideLease(map: LeaseMap, udid: string, opts: LeaseOptions): LeaseDecision {
  const existing = map.get(udid);
  if (!existing) return { type: 'grant' };
  if (existing.engine === opts.engine) return { type: 'grant' };
  return { type: 'refuse', code: 'LEASE_HELD', holder: existing.holder, engine: existing.engine };
}

export function acquireLease(map: Map<string, LeaseEntry>, udid: string, opts: LeaseOptions): void {
  const decision = decideLease(map, udid, opts);
  if (decision.type === 'refuse') {
    throw new AlloyError('LEASE_HELD', `device ${udid} is leased to engine ${decision.engine} by ${decision.holder}; call alloy_release first`, {
      details: { holder: decision.holder, reason: `engine-${decision.engine.toLowerCase()}-holds-lease`, retriable: false },
    });
  }
  map.set(udid, { engine: opts.engine, holder: opts.holder, since: Date.now() });
}

export function releaseLease(map: Map<string, LeaseEntry>, udid: string, holder?: string): boolean {
  const existing = map.get(udid);
  if (!existing) return false;
  if (holder !== undefined && existing.holder !== holder) return false;
  map.delete(udid);
  return true;
}

/** Adapter-facing wrapper around the machine (dispatch drives transitions). */
export class LeaseManager {
  private readonly map = new Map<string, LeaseEntry>();
  private readonly queues = new Map<string, Promise<unknown>>();

  async withPerCall<T>(udid: string, holder: string, engine: EngineId, fn: () => Promise<T>): Promise<T> {
    const gate = (this.queues.get(udid) ?? Promise.resolve()).catch(() => undefined);
    let releaseGate!: () => void;
    const done = new Promise<void>((r) => (releaseGate = r));
    this.queues.set(udid, gate.then(() => done));
    try {
      await gate;
      // Coexistence rules: cross-engine holders refuse; a same-engine held entry is
      // LEFT UNTOUCHED (never overwritten — a per-call must not steal or release a
      // lease it does not own). We only mark the map when the device is free.
      const existing = this.map.get(udid);
      if (existing && existing.engine !== engine) {
        throw new AlloyError('LEASE_HELD', `device ${udid} is leased to engine ${existing.engine} by ${existing.holder}; call alloy_release first`, {
          details: { holder: existing.holder, reason: `engine-${existing.engine.toLowerCase()}-holds-lease`, retriable: false },
        });
      }
      if (!existing) {
        this.map.set(udid, { engine, holder, since: Date.now() });
      }
      try {
        return await fn();
      } finally {
        const current = this.map.get(udid);
        // Delete only OUR per-call entry; a held entry (or an entry the handler
        // deliberately released) is left exactly as the handler left it.
        if (current && current.holder === holder && current !== existing) {
          this.map.delete(udid);
        }
      }
    } finally {
      releaseGate();
    }
  }

  acquireHeld(udid: string, holder: string, engine: EngineId): void {
    acquireLease(this.map, udid, { engine, holder, mode: 'held' });
  }

  releaseHeld(udid: string, holder: string): boolean {
    return releaseLease(this.map, udid, holder);
  }

  snapshot(): LeaseMap {
    return new Map(this.map);
  }
}
