/**
 * Tool definition surface. Tools register ONLY via defineTool — there is no second
 * path to an engine. dispatch() is the single choke point: zod-validate → lease →
 * adapter → error-normalize.
 */
import { AlloyError, normalizeEngineAError, normalizeEngineBError } from './errors.ts';
import type { EngineId, RoutingRow } from './routing.ts';
import type { LeaseManager } from './lease.ts';
export type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown> | unknown;

export interface ToolContext {
  engine: EngineId;
  tool: string;
}

export interface Adapter {
  readonly id: EngineId;
  invoke(tool: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface RegisteredTool {
  row: RoutingRow;
  handler: ToolHandler;
}

const registry = new Map<string, RegisteredTool>();

/** The only sanctioned way to bind a handler to a routing-table row (see scan). */
export function defineToolFromRow(row: RoutingRow, handler: ToolHandler): RegisteredTool {
  if (registry.has(row.tool)) throw new AlloyError('INVALID_ARGS', `tool ${row.tool} already registered`);
  const entry: RegisteredTool = { row, handler };
  registry.set(row.tool, entry);
  return entry;
}

export function listRegisteredTools(): RegisteredTool[] {
  return [...registry.values()];
}

export function clearRegistryForTests(): void {
  registry.clear();
}

/** Test-only: replace a registered handler without weakening uniqueness invariant. */
export function replaceToolHandlerForTests(tool: string, handler: ToolHandler): void {
  const entry = registry.get(tool);
  if (!entry) throw new AlloyError('TOOL_NOT_FOUND', `cannot replace unregistered tool: ${tool}`);
  entry.handler = handler;
}

function engineErrorNormalizer(engine: EngineId): (err: unknown, ctx: string) => AlloyError {
  return engine === 'A' ? normalizeEngineAError : normalizeEngineBError;
}

export interface DispatchDeps {
  leases: LeaseManager;
  adapters: Partial<Record<EngineId, Adapter>>;
}

/**
 * Single dispatch choke point. Phase 0: tools are stubs that report engine state —
 * Phase 1+ replaces stub bodies per routing row, dispatch itself does not change.
 */
export async function dispatch(
  tool: string,
  input: unknown,
  deps: DispatchDeps,
): Promise<{ ok: true; result: unknown } | { ok: false; error: ReturnType<AlloyError['toJSON']> }> {
  const entry = registry.get(tool);
  if (!entry) return { ok: false, error: new AlloyError('TOOL_NOT_FOUND', `unknown tool: ${tool}`).toJSON() };
  const { row, handler } = entry;

  const parsed = row.schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: new AlloyError('VALIDATION_FAILED', `invalid input for ${tool}`, {
        details: { reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
      }).toJSON(),
    };
  }
  const data = parsed.data as Record<string, unknown>;
  const udid = typeof data['udid'] === 'string' ? (data['udid'] as string) : undefined;

  // Per-call tools serialize through the lease manager: acquire → run → auto-release,
  // and cross-engine conflict on the same device is refused here (PLAN §5.1).
  if (row.lease === 'per-call' && udid !== undefined) {
    try {
      return await deps.leases.withPerCall(udid, row.tool, row.engine, async () => {
        try {
          const result = await handler(data, { engine: row.engine, tool: row.tool });
          return { ok: true, result } as const;
        } catch (err) {
          return { ok: false, error: toAlloyError(err, row.engine, row.tool).toJSON() } as const;
        }
      });
    } catch (err) {
      // withPerCall itself can refuse (LEASE_HELD) — surface as envelope, never a throw
      return { ok: false, error: toAlloyError(err, row.engine, row.tool).toJSON() };
    }
  }

  // A4 + holdsWhen: a held tool acquires ONLY when this specific call is
  // session-holding (open-style) and the input didn't opt out via hold:false.
  const wantsHold =
    row.lease === 'held' &&
    data['hold'] !== false &&
    (row.holdsWhen ? row.holdsWhen(data) : true);

  try {
    if (wantsHold && udid) deps.leases.acquireHeld(udid, row.tool, row.engine);
    const result = await handler(data, { engine: row.engine, tool: row.tool });
    return { ok: true, result };
  } catch (err) {
    const alloyErr = toAlloyError(err, row.engine, row.tool);
    // mandatory release-on-error for held leases we actually acquired
    if (wantsHold && udid) deps.leases.releaseHeld(udid, row.tool);
    return { ok: false, error: alloyErr.toJSON() };
  }
}

function toAlloyError(err: unknown, engine: EngineId, tool: string): AlloyError {
  return err instanceof AlloyError ? err : engineErrorNormalizer(engine)(err, tool);
}
