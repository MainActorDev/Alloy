/**
 * Engine A adapter. Loads the device-control engine client through runtime
 * resolution (no engine names in this repo — shapes below mirror the engine's
 * published contracts structurally). All engine failures propagate as-is so the
 * dispatch normalizer can map typed codes; nothing here parses message text.
 */
import type { ResolvedEngines } from './engines.ts';
import { AlloyError } from './errors.ts';

/** Structural mirror of the engine's interaction target contract. */
export type ATarget =
  | { kind: 'ref'; ref: string; fallbackLabel?: string }
  | { kind: 'selector'; selector: string }
  | { kind: 'point'; x: number; y: number };

export interface ADevice {
  id: string;
  name?: string;
  state?: string;
  platform?: string;
}

export interface AClient {
  devices: {
    list(options?: { udid?: string }): Promise<ADevice[]>;
    boot(options?: { udid?: string }): Promise<unknown>;
    shutdown(options?: { udid?: string }): Promise<unknown>;
  };
  apps: {
    open(options: {
      app: string;
      udid?: string;
      launchArgs?: string[];
      foreground?: boolean;
      relaunch?: boolean;
    }): Promise<unknown>;
    install(options: { appPath: string; udid?: string; app?: string }): Promise<unknown>;
    reinstall(options: { app: string; appPath: string; udid?: string }): Promise<unknown>;
    list(options?: { udid?: string }): Promise<string[]>;
    close(options?: { shutdown?: boolean }): Promise<unknown>;
  };
  capture: {
    snapshot(options?: { udid?: string; interactiveOnly?: boolean }): Promise<unknown>;
  };
  interactions: {
    press(options: { target: ATarget; udid?: string; settle?: boolean }): Promise<unknown>;
    longPress(options: { target: ATarget; udid?: string; durationMs?: number }): Promise<unknown>;
    fill(options: { target: ATarget; text: string; udid?: string; settle?: boolean }): Promise<unknown>;
    scroll(options: { direction: string; udid?: string; settle?: boolean }): Promise<unknown>;
    find(options: { query: string; action?: string; value?: string; first?: boolean; udid?: string }): Promise<unknown>;
  };
  command: {
    alert(options?: { action?: string; udid?: string; timeoutMs?: number }): Promise<unknown>;
  };
  settings: {
    update(options: Record<string, unknown>): Promise<unknown>;
  };
  sessions: {
    close(options?: { shutdown?: boolean }): Promise<unknown>;
  };
}

let cached: { key: string; client: AClient } | null = null;

export async function loadEngineAClient(resolved: ResolvedEngines['engineA']): Promise<AClient> {
  if (cached && cached.key === resolved.importUrl) return cached.client;
  const mod = (await import(resolved.importUrl)) as Record<string, unknown>;
  const factoryName = resolved.clientFactory ?? 'createClient';
  const factory = mod[factoryName];
  if (typeof factory !== 'function') {
    throw new AlloyError('ENGINE_UNAVAILABLE', 'engine A client factory missing at configured entry', { engine: 'A' });
  }
  const client = (factory as (config?: { session?: string }) => AClient)({ session: 'alloy' });
  cached = { key: resolved.importUrl, client };
  return client;
}

/** Map an alloy target string to the engine's structured target (refs keep their @). */
export function toTarget(raw: string): ATarget {
  if (raw.startsWith('@')) return { kind: 'ref', ref: raw };
  if (/^[a-zA-Z-]+=.+$/.test(raw)) return { kind: 'selector', selector: raw };
  return { kind: 'selector', selector: `text=${JSON.stringify(raw)}` };
}

/** Map alloy_find inputs to the engine's find query. */
export function toFindQuery(by: 'text' | 'label' | 'role' | 'id', value: string): string {
  return `${by}=${JSON.stringify(value)}`;
}

const ALERT_ACTIONS: Record<string, string> = { inspect: 'get', accept: 'accept', dismiss: 'dismiss' };
export function toAlertAction(alloyAction: string): string {
  const mapped = ALERT_ACTIONS[alloyAction];
  if (!mapped) throw new AlloyError('INVALID_ARGS', `unsupported alert action: ${alloyAction}`);
  return mapped;
}

export function toSettingsOptions(
  area: string,
  values: Record<string, string> | undefined,
  udid?: string,
): Record<string, unknown> {
  const v = values ?? {};
  const opts: Record<string, unknown> = { setting: area, udid };
  if ('state' in v) opts['state'] = v['state'];
  if (area === 'location' && v['state'] === 'set') {
    const lat = Number(v['latitude']);
    const lon = Number(v['longitude']);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new AlloyError('INVALID_ARGS', 'location set requires numeric latitude/longitude');
    }
    opts['latitude'] = lat;
    opts['longitude'] = lon;
  }
  if ('app' in v) opts['app'] = v['app'];
  return opts;
}

export function resetEngineACacheForTests(): void {
  cached = null;
}
