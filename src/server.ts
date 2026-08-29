/**
 * MCP stdio server. Degraded mode: when health is not ok, ONLY alloy_health is listed.
 * Handlers route through dispatch() — the single choke point.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { buildHealthReport, probeImports, type HealthReport } from './health.ts';
import { resolveEngines, type ResolvedEngines } from './engines.ts';
import { dispatch, type DispatchDeps } from './tools.ts';
import { LeaseManager } from './lease.ts';
import { routingTable } from './routing.ts';

export interface ServerState {
  resolved: ResolvedEngines | null;
  configError: string | null;
  health: HealthReport | null;
  leases: LeaseManager;
}

export function createServerState(): ServerState {
  return { resolved: null, configError: null, health: null, leases: new LeaseManager() };
}

export async function refreshHealth(state: ServerState): Promise<HealthReport> {
  let probe = null;
  if (state.resolved) {
    probe = await probeImports(state.resolved);
  }
  const leases = [...state.leases.snapshot().entries()].map(([udid, entry]) => ({
    udid,
    engine: entry.engine,
    holder: entry.holder,
    since: entry.since,
  }));
  const report = buildHealthReport({
    resolved: state.resolved,
    configError: state.configError,
    probe,
    leases,
  });
  state.health = report;
  return report;
}

export interface Runtime {
  state: ServerState;
  deps: DispatchDeps;
}

export async function createRuntime(configPath?: string): Promise<Runtime> {
  const state = createServerState();
  const { enginesConfigPath, loadEnginesFile } = await import('./engines.ts');
  try {
    const path = enginesConfigPath(configPath);
    const file = loadEnginesFile(path);
    state.resolved = resolveEngines(file);
  } catch (err) {
    state.configError = err instanceof Error ? err.message : String(err);
  }
  const deps: DispatchDeps = { leases: state.leases, adapters: {} };
  // Production tool registration — the same path tests drive explicitly. Idempotent:
  // safe to call for every runtime (repeated createRuntime in one process).
  const { registerPhase0Tools } = await import('./registrations.ts');
  registerPhase0Tools({ state });
  return { state, deps };
}

export function toolNameList(health: HealthReport | null): string[] {
  if (!health || health.degraded) return ['alloy_health'];
  return routingTable.map((r) => r.tool);
}

function mcpErrorEnvelope(error: { code: string; message: string; engine?: string | null; details?: unknown }): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(error) }],
  };
}

export function createMcpServer(runtime: Runtime): Server {
  const server = new Server(
    { name: 'alloy', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const health = await refreshHealth(runtime.state);
    const names = toolNameList(health);
    const tools = routingTable
      .filter((r) => names.includes(r.tool))
      .map((r) => ({
        name: r.tool,
        description: r.summary,
        inputSchema: zodToMcpSchema(r.schema),
      }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    // alloy_health is always dispatchable, even degraded
    if (name === 'alloy_health') {
      const health = await refreshHealth(runtime.state);
      return { content: [{ type: 'text', text: JSON.stringify(health, null, 2) }] };
    }
    const result = await dispatch(name, request.params.arguments, runtime.deps);
    if (result.ok) {
      return {
        content: [{ type: 'text', text: typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2) }],
      };
    }
    return mcpErrorEnvelope(result.error);
  });

  return server;
}

/**
 * Convert a zod object schema into an MCP inputSchema. Honest minimal shape: the
 * authoritative validation contract is the zod schema in the routing table (dispatch
 * rejects unknown keys); per-tool JSON Schema generation lands in Phase 1.
 */
function zodToMcpSchema(_schema: z.ZodType<unknown>): Record<string, unknown> {
  return { type: 'object' };
}
export async function startServer(configPath?: string): Promise<void> {
  const runtime = await createRuntime(configPath);
  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
