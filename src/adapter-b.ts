/**
 * Engine B adapter. Loads the tool-registry engine's tools client through runtime
 * resolution and drives its persistent HTTP tool server (same server its CLI uses).
 * Tool names/args below mirror the engine's advertised contracts structurally.
 */
import { join } from 'node:path';
import type { ResolvedEngines } from './engines.ts';
import { AlloyError } from './errors.ts';

export interface BToolMeta {
  name: string;
  description: string;
}

export interface BInvocationResult {
  data: unknown;
  note?: string;
}

export interface BPaths {
  bundlePath: string;
  simulatorServerDir: string;
  nativeDevtoolsDir: string;
}

export interface BToolsClient {
  fetchTools(): Promise<BToolMeta[]>;
  fetchTool(name: string): Promise<BToolMeta | null>;
  callTool(name: string, args: unknown): Promise<BInvocationResult>;
  baseUrl(): Promise<{ url: string; token: string }>;
}

export interface BEngineOptions {
  /** Where the engine's bundled runtime artifacts live (derived from workspace). */
  paths?: BPaths;
}

let cached: { key: string; client: BToolsClient } | null = null;

export async function loadEngineBClient(
  resolved: ResolvedEngines['engineB'],
): Promise<BToolsClient> {
  if (cached && cached.key === resolved.importUrl) return cached.client;
  const mod = (await import(resolved.importUrl)) as Record<string, unknown>;
  const factoryName = resolved.clientFactory ?? 'createClient';
  const factory = mod[factoryName];
  if (typeof factory !== 'function') {
    throw new AlloyError('ENGINE_UNAVAILABLE', 'engine B client factory missing at configured entry', { engine: 'B' });
  }
  // The engine's client spawns its persistent tool server from bundled runtime
  // artifacts (server bundle + native helper dirs). Without paths it refuses to
  // spawn — derive them from the configured runtime dir when present.
  const options: BEngineOptions = {};
  if (resolved.runtimeDir) {
    options.paths = {
      bundlePath: join(resolved.runtimeDir, 'dist', 'tool-server.cjs'),
      simulatorServerDir: join(resolved.runtimeDir, 'bin'),
      nativeDevtoolsDir: join(resolved.runtimeDir, 'dylibs'),
    };
  }
  const client = (factory as (options?: BEngineOptions) => BToolsClient)(options);
  cached = { key: resolved.importUrl, client };
  return client;
}

/** Call an engine-B tool; normalize its HTTP failure envelope into AlloyError. */
export async function callBTool(
  client: BToolsClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let result: BInvocationResult;
  try {
    result = await client.callTool(name, args);
  } catch (err) {
    // callTool rejects on transport errors; envelope failures come back in-band
    throw envelopeToAlloyError(err, name);
  }
  if (result && typeof result === 'object' && 'error_code' in result) {
    throw envelopeToAlloyError(result, name);
  }
  return result.data;
}

function envelopeToAlloyError(err: unknown, context: string): AlloyError {
  const e = err as { error_code?: unknown; message?: unknown; issues?: unknown; error?: { message?: unknown } };
  if (e && typeof e === 'object' && typeof e.error_code === 'string') {
    return new AlloyError('COMMAND_FAILED', `${context}: ${String(e.message ?? 'engine failure')}`, {
      details: { engineCode: e.error_code },
      engine: 'B',
      cause: err,
    });
  }
  const msg = e?.error?.message ?? (err instanceof Error ? err.message : String(err));
  return new AlloyError('COMMAND_FAILED', `${context}: ${String(msg)}`, { engine: 'B', cause: err });
}

export function resetEngineBCacheForTests(): void {
  cached = null;
}
