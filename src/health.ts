/**
 * Startup + on-demand health. Fail-closed: any unresolved prerequisite degrades the
 * server to listing ONLY alloy_health. No engine names leak — statuses are neutral.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedEngines } from './engines.ts';

export interface EngineHealth {
  resolved: boolean;
  importable: boolean;
  versionReported: string | null;
  versionPinned: string | null;
  skew: boolean;
  prerequisiteErrors: string[];
  warm: boolean | null; // null = unknown/not applicable
}

export interface HealthReport {
  ok: boolean;
  degraded: boolean;
  engines: { A: EngineHealth; B: EngineHealth };
  leases: Array<{ udid: string; engine: 'A' | 'B'; holder: string; since: number }>;
}

function dirRequirementsOk(dir: string, errors: string[]): void {
  if (!existsSync(dir)) {
    errors.push(`path does not exist: ${dir}`);
    return;
  }
  const nm = join(dir, 'node_modules');
  if (!existsSync(nm)) errors.push(`dependency tree missing at ${nm}`);
}

export function checkEngineADirs(e: ResolvedEngines['engineA']): string[] {
  const errors: string[] = [];
  dirRequirementsOk(e.module, errors);
  const entryFile = join(e.module, e.entry);
  if (!existsSync(entryFile)) errors.push(`entry file missing: ${entryFile}`);
  return errors;
}

export function checkEngineBDirs(e: ResolvedEngines['engineB']): string[] {
  const errors: string[] = [];
  dirRequirementsOk(e.workspace, errors);
  const entryFile = join(e.workspace, e.entry);
  if (!existsSync(entryFile)) errors.push(`entry file missing: ${entryFile}`);
  return errors;
}

/** Import engine modules through their resolved URLs; report, never crash. */
export async function probeImports(
  engines: ResolvedEngines,
): Promise<{
  A: { importable: boolean; versionReported: string | null; error?: string };
  B: { importable: boolean; error?: string };
}> {
  const out: {
    A: { importable: boolean; versionReported: string | null; error?: string };
    B: { importable: boolean; error?: string };
  } = {
    A: { importable: false, versionReported: null },
    B: { importable: false },
  };
  try {
    const mod = (await import(engines.engineA.importUrl)) as Record<string, unknown>;
    const factory = engines.engineA.clientFactory ?? 'createClient';
    out.A.importable = typeof mod[factory] === 'function';
    if (!out.A.importable) out.A.error = 'client factory not found at entry';
    out.A.versionReported = readEngineVersion(engines.engineA.module);
  } catch (err) {
    out.A.error = err instanceof Error ? err.message : String(err);
  }
  try {
    const mod = (await import(engines.engineB.importUrl)) as Record<string, unknown>;
    const factory = engines.engineB.clientFactory ?? 'createClient';
    out.B.importable = typeof mod[factory] === 'function';
    if (!out.B.importable) out.B.error = 'tools client factory not found at entry';
  } catch (err) {
    out.B.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}

/** Engine version from its package.json (engines don't export version constants). */
function readEngineVersion(moduleDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(moduleDir, 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export function buildHealthReport(input: {
  resolved: ResolvedEngines | null;
  configError: string | null;
  probe: { A: { importable: boolean; versionReported: string | null }; B: { importable: boolean } } | null;
  leases: Array<{ udid: string; engine: 'A' | 'B'; holder: string; since: number }>;
}): HealthReport {
  const emptyEngine = (versionPinned: string | null): EngineHealth => ({
    resolved: false,
    importable: false,
    versionReported: null,
    versionPinned,
    skew: false,
    prerequisiteErrors: [],
    warm: null,
  });
  if (!input.resolved) {
    return {
      ok: false,
      degraded: true,
      engines: { A: emptyEngine(null), B: emptyEngine(null) },
      leases: input.leases,
    };
  }
  const aDirs = checkEngineADirs(input.resolved.engineA);
  const bDirs = checkEngineBDirs(input.resolved.engineB);
  const probe = input.probe ?? { A: { importable: false, versionReported: null }, B: { importable: false } };
  const aVersion = probe.A.versionReported;
  const aPinned = input.resolved.engineA.version;
  const aSkew = aVersion !== null && aPinned !== aVersion;
  const a: EngineHealth = {
    resolved: true,
    importable: probe.A.importable,
    versionReported: aVersion,
    versionPinned: aPinned,
    skew: aSkew,
    prerequisiteErrors: aDirs,
    warm: null,
  };
  const b: EngineHealth = {
    resolved: true,
    importable: probe.B.importable,
    versionReported: null,
    versionPinned: null,
    skew: false,
    prerequisiteErrors: bDirs,
    warm: null,
  };
  const ok = a.importable && b.importable && aDirs.length === 0 && bDirs.length === 0 && !aSkew;
  return { ok, degraded: !ok, engines: { A: a, B: b }, leases: input.leases };
}
