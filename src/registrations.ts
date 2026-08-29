/**
 * Phase-1 tool registrations: engine-A-backed implementations for the exploration
 * surface. Engine failures propagate to dispatch's normalizer (typed codes only).
 */
import { defineToolFromRow, listRegisteredTools } from './tools.ts';
import { getRoutingRow } from './routing.ts';
import { buildHealthReport, probeImports, type HealthReport } from './health.ts';
import type { ServerState } from './server.ts';
import {
  loadEngineAClient,
  toTarget,
  toFindQuery,
  toAlertAction,
  toSettingsOptions,
} from './adapter-a.ts';
import { loadEngineBClient, callBTool } from './adapter-b.ts';
import { AlloyError } from './errors.ts';
import { basename, dirname } from 'node:path';

export interface StubDeps {
  state: ServerState;
}

function mustRow(tool: string) {
  const row = getRoutingRow(tool);
  if (!row) throw new Error(`routing row missing: ${tool}`);
  return row;
}

function requireEngineA(deps: StubDeps) {
  if (!deps.state.resolved) {
    throw new AlloyError('CONFIG_MISSING', 'engines config unresolved; run alloy_health', { engine: 'A' });
  }
  return deps.state.resolved;
}

function requireEngineB(deps: StubDeps) {
  if (!deps.state.resolved) {
    throw new AlloyError('CONFIG_MISSING', 'engines config unresolved; run alloy_health', { engine: 'B' });
  }
  return deps.state.resolved;
}

/** exactOptionalPropertyTypes-safe optional assignment. */
function opt<T extends object, K extends PropertyKey>(obj: T, key: K, value: unknown): void {
  if (value !== undefined) {
    (obj as Record<K, unknown>)[key] = value;
  }
}

export function registerPhase0Tools(deps: StubDeps): void {
  if (listRegisteredTools().length > 0) return; // idempotent: production + tests share one registry

  // ── health ────────────────────────────────────────────────────────────────
  defineToolFromRow(mustRow('alloy_health'), async () => {
    let probe = null;
    if (deps.state.resolved) probe = await probeImports(deps.state.resolved);
    const leases = [...deps.state.leases.snapshot().entries()].map(([udid, entry]) => ({
      udid,
      engine: entry.engine,
      holder: entry.holder,
      since: entry.since,
    }));
    const report: HealthReport = buildHealthReport({
      resolved: deps.state.resolved,
      configError: deps.state.configError,
      probe,
      leases,
    });
    deps.state.health = report;
    return report;
  });

  // ── engine A surface (Phase 1) ───────────────────────────────────────────
  defineToolFromRow(mustRow('alloy_devices'), async (input) => {
    const client = await loadEngineAClient(requireEngineA(deps).engineA);
    const d = input as { action: 'list' | 'boot' | 'shutdown'; udid?: string };
    if (d.action === 'list') return client.devices.list();
    if (d.action === 'boot') {
      const o: { udid?: string } = {};
      opt(o, 'udid', d.udid);
      return client.devices.boot(o);
    }
    const o: { udid?: string } = {};
    opt(o, 'udid', d.udid);
    return client.devices.shutdown(o);
  });

  defineToolFromRow(mustRow('alloy_apps'), async (input) => {
    const client = await loadEngineAClient(requireEngineA(deps).engineA);
    const d = input as {
      action: 'open' | 'install' | 'reinstall' | 'list';
      app?: string;
      path?: string;
      launchArgs?: string[];
      udid?: string;
    };
    if (d.action === 'list') {
      const o: { udid?: string } = {};
      opt(o, 'udid', d.udid);
      return client.apps.list(o);
    }
    if (d.action === 'install') {
      const o: { appPath: string; app?: string; udid?: string } = { appPath: d.path! };
      opt(o, 'app', d.app);
      opt(o, 'udid', d.udid);
      return client.apps.install(o);
    }
    if (d.action === 'reinstall') {
      const o: { app: string; appPath: string; udid?: string } = { app: d.app!, appPath: d.path! };
      opt(o, 'udid', d.udid);
      return client.apps.reinstall(o);
    }
    // open — the lease-holding action; dispatch acquired the held lease already
    const openOpts: Parameters<typeof client.apps.open>[0] = { app: d.app!, foreground: true };
    opt(openOpts, 'udid', d.udid);
    opt(openOpts, 'launchArgs', d.launchArgs);
    const r = (await client.apps.open(openOpts)) as {
      session?: string;
      appBundleId?: string;
      selection?: unknown;
      device?: { id?: string };
    };
    return {
      opened: d.app,
      session: r.session,
      appBundleId: r.appBundleId,
      device: r.device?.id,
      selection: r.selection,
    };
  });

  defineToolFromRow(mustRow('alloy_release'), async (input) => {
    const client = await loadEngineAClient(requireEngineA(deps).engineA);
    const d = input as { udid: string };
    // Release engine session (SESSION_NOT_FOUND means nothing to close — not an error)
    try {
      await client.sessions.close();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'SESSION_NOT_FOUND') throw err;
    }
    const released =
      deps.state.leases.releaseHeld(d.udid, 'alloy_apps') ||
      deps.state.leases.releaseHeld(d.udid, 'alloy_flow');
    return { udid: d.udid, leaseReleased: released };
  });

  defineToolFromRow(mustRow('alloy_snapshot'), async (input) => {
    const client = await loadEngineAClient(requireEngineA(deps).engineA);
    const d = input as { udid: string; interactiveOnly: boolean };
    return client.capture.snapshot({ udid: d.udid, interactiveOnly: d.interactiveOnly });
  });

  defineToolFromRow(mustRow('alloy_act'), async (input) => {
    const client = await loadEngineAClient(requireEngineA(deps).engineA);
    const d = input as {
      udid: string;
      action: 'press' | 'fill' | 'scroll' | 'longpress';
      target?: string;
      text?: string;
      direction?: 'up' | 'down' | 'left' | 'right';
      settle: boolean;
    };
    if (d.action === 'scroll') {
      return client.interactions.scroll({ direction: d.direction!, udid: d.udid, settle: d.settle });
    }
    const target = toTarget(d.target!);
    if (d.action === 'press') return client.interactions.press({ target, udid: d.udid, settle: d.settle });
    if (d.action === 'longpress') {
      const o: { target: typeof target; udid?: string } = { target };
      opt(o, 'udid', d.udid);
      return client.interactions.longPress(o);
    }
    return client.interactions.fill({ target, text: d.text!, udid: d.udid, settle: d.settle });
  });

  defineToolFromRow(mustRow('alloy_find'), async (input) => {
    const client = await loadEngineAClient(requireEngineA(deps).engineA);
    const d = input as { udid: string; by: 'text' | 'label' | 'role' | 'id'; value: string; action: 'none' | 'tap' };
    const o: Record<string, unknown> = {
      query: toFindQuery(d.by, d.value),
      first: true,
      udid: d.udid,
    };
    if (d.action === 'tap') o['action'] = 'click';
    return client.interactions.find(o as Parameters<typeof client.interactions.find>[0]);
  });

  defineToolFromRow(mustRow('alloy_alert'), async (input) => {
    const client = await loadEngineAClient(requireEngineA(deps).engineA);
    const d = input as { udid: string; action: 'inspect' | 'accept' | 'dismiss' };
    return client.command.alert({ action: toAlertAction(d.action), udid: d.udid });
  });

  defineToolFromRow(mustRow('alloy_settings'), async (input) => {
    const client = await loadEngineAClient(requireEngineA(deps).engineA);
    const d = input as { udid: string; area: string; values?: Record<string, string> };
    return client.settings.update(toSettingsOptions(d.area, d.values, d.udid));
  });

  // ── engine B surface (Phase 2) ───────────────────────────────────────────
  defineToolFromRow(mustRow('alloy_measure'), async (input) => {
    const client = await loadEngineBClient(requireEngineB(deps).engineB);
    const d = input as { udid: string };
    // Verbatim passthrough — measurement contract is consumed byte-identical by
    // downstream parity tooling. Do NOT transform.
    return callBTool(client, 'describe', { udid: d.udid });
  });

  defineToolFromRow(mustRow('alloy_native_tree'), async (input) => {
    const client = await loadEngineBClient(requireEngineB(deps).engineB);
    const d = input as {
      udid: string;
      query: 'hierarchy' | 'find-views' | 'interactable-at';
      className?: string;
      id?: string;
      x?: number;
      y?: number;
    };
    if (d.query === 'hierarchy') {
      return callBTool(client, 'native-full-hierarchy', { udid: d.udid });
    }
    if (d.query === 'find-views') {
      const args: Record<string, unknown> = { udid: d.udid, identifier: d.id, className: d.className };
      for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
      return callBTool(client, 'native-find-views', args);
    }
    return callBTool(client, 'native-user-interactable-view-at-point', {
      udid: d.udid,
      x: d.x!,
      y: d.y!,
    });
  });

  defineToolFromRow(mustRow('alloy_flow'), async (input) => {
    const client = await loadEngineBClient(requireEngineB(deps).engineB);
    const d = input as { udid: string; flowPath: string };
    const flowName = basename(d.flowPath).replace(/\.ya?ml$/, '');
    // The engine derives the flow file from project_root + configured segments.
    // Strip those segments off the given path to find the project root; refuse
    // paths that don't match the engine's canonical layout.
    const segs = requireEngineB(deps).engineB.flowsDirSegments ?? ['flows'];
    let dir = dirname(d.flowPath);
    for (let i = segs.length - 1; i >= 0; i--) {
      if (basename(dir) !== segs[i]) {
        throw new AlloyError('INVALID_ARGS', `flowPath must end with /${segs.join('/')}/<name>.yaml under a project root`);
      }
      dir = dirname(dir);
    }
    return callBTool(client, 'flow-execute', {
      name: flowName,
      project_root: dir,
      device: d.udid,
      prerequisiteAcknowledged: true,
    });
  });

  defineToolFromRow(mustRow('alloy_video'), async (input) => {
    const client = await loadEngineBClient(requireEngineB(deps).engineB);
    const d = input as { udid: string; action: 'start' | 'stop'; label?: string };
    if (d.action === 'start') {
      return callBTool(client, 'start-video-recording', { udid: d.udid, codec: 'h264' });
    }
    const args: Record<string, unknown> = { udid: d.udid };
    if (d.label !== undefined) args['label'] = d.label;
    return callBTool(client, 'stop-video-recording', args);
  });

  defineToolFromRow(mustRow('alloy_screenshot_diff'), async (input) => {
    const client = await loadEngineBClient(requireEngineB(deps).engineB);
    const d = input as {
      baselinePath?: string;
      currentPath?: string;
      auto?: boolean;
      udid?: string;
    };
    const args: Record<string, unknown> = { udid: d.udid! };
    if (d.auto === true) {
      args['captureCurrent'] = true;
    } else {
      args['currentPath'] = d.currentPath!;
    }
    if (d.baselinePath !== undefined) args['baselinePath'] = d.baselinePath;
    return callBTool(client, 'screenshot-diff', args);
  });

  defineToolFromRow(mustRow('alloy_flow_report'), async () => {
    // flow-execute returns the full per-step report in its result; the engine has
    // no separate report tool. This surface exists for future report persistence.
    return { note: 'flow-execute returns the full per-step report in its result' };
  });

  // ── Phase 3 stubs ────────────────────────────────────────────────────────
  const stub = (tool: string, note: string) => {
    defineToolFromRow(mustRow(tool), async (input) => ({
      tool,
      status: 'stub',
      note,
      echo: input,
    }));
  };
  stub('alloy_network', 'Phase 3: device engine network dump');
  stub('alloy_logs', 'Phase 3: device engine logs');
}
