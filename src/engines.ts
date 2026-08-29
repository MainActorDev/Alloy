/**
 * Engine resolution. Concrete engine identities live ONLY in a gitignored local file
 * (never in this repo). Loading is JSONC-tolerant (comments allowed) and fail-closed:
 * missing/invalid config yields a structured CONFIG_MISSING / VALIDATION_FAILED state,
 * never a crash.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AlloyError } from './errors.ts';

export interface EngineAConfig {
  /** Absolute path to the installed engine package directory. */
  module: string;
  /** Entry file exporting the SDK client, relative to `module`. */
  entry: string;
  /** Exact version this integration was validated against. */
  version: string;
  /** Export name of the client factory on the entry module (neutral default). */
  clientFactory?: string;
}

export interface EngineBConfig {
  /** Absolute path to the engine monorepo root. */
  workspace: string;
  /** Entry file exporting the tools client, relative to `workspace`. */
  entry: string;
  /** Export name of the tools client factory on the entry module (neutral default). */
  clientFactory?: string;
  /** Absolute path to the engine's runtime package dir (bundle + native bins). */
  runtimeDir?: string;
  /** Path segments (relative to project root) where flows live, e.g. [".<name>","flows"]. */
  flowsDirSegments?: string[];
}

export interface EnginesFile {
  engineA: EngineAConfig;
  engineB: EngineBConfig;
}

export interface ResolvedEngineA extends EngineAConfig {
  importUrl: string;
}

export interface ResolvedEngineB extends EngineBConfig {
  importUrl: string;
}

export interface ResolvedEngines {
  engineA: ResolvedEngineA;
  engineB: ResolvedEngineB;
}

export function enginesConfigPath(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = process.env['ALLOY_ENGINES_CONFIG'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const home = process.env['HOME'];
  if (!home) throw new AlloyError('CONFIG_MISSING', 'HOME is not set; cannot locate engines config');
  return resolve(home, '.alloy', 'engines.local.json');
}

/** Strip //-comments then parse; tolerant of a leading BOM. Line-comments only:
 * config values never contain URLs (no string-awareness needed). */
export function parseJsonc(text: string): unknown {
  const stripped = text.replace(/^\uFEFF/, '').split('\n').map((line) => {
    const idx = line.indexOf('//');
    if (idx === -1) return line;
    // naive: no string-awareness; config files here never contain URLs with //
    return line.slice(0, idx);
  }).join('\n');
  return JSON.parse(stripped);
}

export function loadEnginesFile(path: string): EnginesFile {
  if (!existsSync(path)) {
    throw new AlloyError('CONFIG_MISSING', `engines config not found at ${path} (copy engines.local.example.jsonc and fill real paths)`);
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new AlloyError('VALIDATION_FAILED', `engines config at ${path} is not valid JSON/JSONC`, { cause });
  }
  return validateEnginesFile(parsed);
}

export function validateEnginesFile(parsed: unknown): EnginesFile {
  const fail = (msg: string): never => {
    throw new AlloyError('VALIDATION_FAILED', msg);
  };
  if (typeof parsed !== 'object' || parsed === null) fail('engines config must be an object');
  const obj = parsed as Record<string, unknown>;
  const a = obj['engineA'];
  const b = obj['engineB'];
  if (typeof a !== 'object' || a === null) fail('engines config missing engineA object');
  if (typeof b !== 'object' || b === null) fail('engines config missing engineB object');
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  if (typeof ao['module'] !== 'string' || !isAbsolute(ao['module'])) fail('engineA.module must be an absolute path');
  if (typeof ao['entry'] !== 'string' || ao['entry'].length === 0) fail('engineA.entry must be a non-empty string');
  if (typeof ao['version'] !== 'string') fail('engineA.version must be a string');
  if (typeof bo['workspace'] !== 'string' || !isAbsolute(bo['workspace'])) fail('engineB.workspace must be an absolute path');
  if (typeof bo['entry'] !== 'string' || bo['entry'].length === 0) fail('engineB.entry must be a non-empty string');
  return {
    engineA: {
      module: ao['module'] as string,
      entry: ao['entry'] as string,
      version: ao['version'] as string,
      ...(typeof ao['clientFactory'] === 'string' ? { clientFactory: ao['clientFactory'] } : {}),
    },
    engineB: {
      workspace: bo['workspace'] as string,
      entry: bo['entry'] as string,
      ...(typeof bo['clientFactory'] === 'string' ? { clientFactory: bo['clientFactory'] } : {}),
      ...(typeof bo['runtimeDir'] === 'string' ? { runtimeDir: bo['runtimeDir'] } : {}),
      ...(Array.isArray(bo['flowsDirSegments']) && bo['flowsDirSegments'].every((s) => typeof s === 'string')
        ? { flowsDirSegments: bo['flowsDirSegments'] as string[] }
        : {}),
    },
  };
}

function toImportUrl(base: string, rel: string): string {
  return pathToFileURL(resolve(base, rel)).href;
}

export function resolveEngines(file: EnginesFile): ResolvedEngines {
  return {
    engineA: { ...file.engineA, importUrl: toImportUrl(file.engineA.module, file.engineA.entry) },
    engineB: { ...file.engineB, importUrl: toImportUrl(file.engineB.workspace, file.engineB.entry) },
  };
}
