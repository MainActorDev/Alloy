import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHealthReport } from '../src/health.ts';
import type { ResolvedEngines } from '../src/engines.ts';

function makeFakeEngineDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `alloy-${prefix}-`));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'index.js'), 'export const ok = true;\n');
  return dir;
}

const fakeA = makeFakeEngineDir('a');
const fakeB = makeFakeEngineDir('b');

const resolved: ResolvedEngines = {
  engineA: { module: fakeA, entry: 'index.js', version: '1.0.0', importUrl: `file://${join(fakeA, 'index.js')}` },
  engineB: { workspace: fakeB, entry: 'index.js', importUrl: `file://${join(fakeB, 'index.js')}` },
};

describe('buildHealthReport (fail-closed)', () => {
  it('no resolution → degraded, both engines unresolved', () => {
    const r = buildHealthReport({ resolved: null, configError: 'missing', probe: null, leases: [] });
    expect(r.ok).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.engines.A.resolved).toBe(false);
    expect(r.engines.B.resolved).toBe(false);
  });
  it('full success → ok', () => {
    const r = buildHealthReport({
      resolved,
      probe: { A: { importable: true, versionReported: '1.0.0' }, B: { importable: true } },
      leases: [],
    });
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.engines.A.skew).toBe(false);
    expect(r.engines.A.prerequisiteErrors).toHaveLength(0);
    expect(r.engines.B.prerequisiteErrors).toHaveLength(0);
  });
  it('version skew → degraded', () => {
    const r = buildHealthReport({
      resolved,
      probe: { A: { importable: true, versionReported: '9.9.9' }, B: { importable: true } },
      leases: [],
    });
    expect(r.degraded).toBe(true);
    expect(r.engines.A.skew).toBe(true);
  });
  it('import failure → degraded', () => {
    const r = buildHealthReport({
      resolved,
      probe: { A: { importable: false, versionReported: null }, B: { importable: true } },
      leases: [],
    });
    expect(r.degraded).toBe(true);
    expect(r.ok).toBe(false);
  });
  it('missing node_modules → prerequisite errors listed', () => {
    const bare = mkdtempSync(join(tmpdir(), 'alloy-bare-'));
    const badResolved: ResolvedEngines = {
      engineA: { module: bare, entry: 'index.js', version: '1.0.0', importUrl: 'file:///nope' },
      engineB: { ...resolved.engineB },
    };
    const r = buildHealthReport({
      resolved: badResolved,
      probe: { A: { importable: true, versionReported: '1.0.0' }, B: { importable: true } },
      leases: [],
    });
    expect(r.degraded).toBe(true);
    expect(r.engines.A.prerequisiteErrors.join(' ')).toContain('node_modules');
  });
});
