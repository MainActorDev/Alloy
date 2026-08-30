/**
 * Routing table — the single source of truth. MCP registration, contract tests, docs,
 * and dispatch all derive from this frozen table. Engine identities are neutral (A/B).
 */
import { z } from 'zod';

export type EngineId = 'A' | 'B';
export type LeaseMode = 'per-call' | 'held';

export interface RoutingRow {
  tool: string;
  engine: EngineId;
  lease: LeaseMode;
  summary: string;
  schema: z.ZodType<unknown>;
  /**
   * Held tools only: predicate on the PARSED input deciding whether THIS call
   * acquires the lease. Default (absent): every call acquires. Used by
   * multi-action tools where only one action is genuinely session-holding
   * (e.g. open) — install/reinstall/list are one-shot and must not hold.
   */
  holdsWhen?: (input: Record<string, unknown>) => boolean;
}

const deviceRef = z
  .string()
  .min(1)
  .describe('target device id (udid/serial) — from alloy_devices or alloy_apps output');

export const routingTable: readonly RoutingRow[] = [
  {
    tool: 'alloy_health',
    engine: 'A',
    lease: 'per-call',
    summary: 'Engine resolution, versions, liveness, and prerequisite report',
    schema: z.object({}).strict(),
  },
  {
    tool: 'alloy_apps',
    engine: 'A',
    lease: 'held',
    holdsWhen: (v) => v['action'] === 'open',
    summary: 'Open an app (with launch args; holds device lease), install, reinstall, or list apps',
    schema: z
      .object({
        action: z.enum(['open', 'install', 'reinstall', 'list']).describe('app operation (open acquires the device lease; list/install do not)'),
        app: z.string().min(1).optional().describe('app id / bundle id'),
        launchArgs: z.array(z.string().min(1)).optional().describe('process launch arguments forwarded verbatim'),
        path: z.string().min(1).optional().describe('app binary path for install/reinstall'),
        srcPath: z
          .string()
          .min(1)
          .optional()
          .describe('source root for the freshness gate: install refuses with STALE_ARTIFACT if any source file is newer than the artifact'),
        hold: z
          .boolean()
          .optional()
          .describe('false = open an engine session WITHOUT acquiring the device lease (session-only; release still closes it). Default true.'),
        udid: deviceRef.optional(),
      })
      .strict()
      .superRefine((v, ctx) => {
        if (v.action !== 'list' && !v.app) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'app is required unless action=list' });
        }
        if ((v.action === 'install' || v.action === 'reinstall') && !v.path) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'path is required for install/reinstall' });
        }
      }),
  },
  {
    tool: 'alloy_devices',
    engine: 'A',
    lease: 'per-call',
    summary: 'List devices/simulators; boot or shut one down',
    schema: z
      .object({
        action: z.enum(['list', 'boot', 'shutdown']).default('list'),
        udid: deviceRef.optional(),
      })
      .strict()
      .superRefine((v, ctx) => {
        if (v.action !== 'list' && !v.udid) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'udid is required unless action=list' });
        }
      }),
  },
  {
    tool: 'alloy_release',
    engine: 'A',
    lease: 'per-call',
    summary: 'Release a held device lease and end the engine session on it',
    schema: z.object({ udid: deviceRef }).strict(),
  },
  {
    tool: 'alloy_snapshot',
    engine: 'A',
    lease: 'per-call',
    summary: 'Token-lean visible UI snapshot with stable refs (explore)',
    schema: z.object({ udid: deviceRef, interactiveOnly: z.boolean().default(true) }).strict(),
  },
  {
    tool: 'alloy_stream',
    engine: 'B',
    lease: 'per-call',
    summary: 'Live MJPEG screen-stream URL for a booted simulator (watch = read-only, no lease)',
    schema: z.object({ udid: deviceRef }).strict(),
  },
  {
    tool: 'alloy_screenshot',
    engine: 'A',
    lease: 'per-call',
    summary: 'Capture a screenshot PNG of the device screen',
    schema: z
      .object({
        udid: deviceRef,
        outPath: z.string().min(1).optional().describe('where to save the PNG (engine default temp dir if omitted)'),
      })
      .strict(),
  },
  {
    tool: 'alloy_act',
    engine: 'A',
    lease: 'per-call',
    summary: 'Press, click, fill, scroll, or long-press with post-action settle diff',
    schema: z
      .object({
        udid: deviceRef,
        action: z.enum(['press', 'fill', 'scroll', 'longpress']),
        target: z
          .union([
            z.string().min(1),
            z.object({ x: z.number().finite(), y: z.number().finite() }),
          ])
          .optional()
          .describe('ref (@e12), selector key=value, label text, or {x,y} point'),
        text: z.string().optional().describe('text for fill'),
        direction: z.enum(['up', 'down', 'left', 'right']).optional(),
        settle: z.boolean().default(true),
      })
      .strict()
      .superRefine((v, ctx) => {
        if (v.action === 'fill' && typeof v.text !== 'string') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'text is required for fill' });
        }
        if (v.action === 'scroll' && !v.direction) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'direction is required for scroll' });
        }
        if (v.action !== 'scroll' && !v.target) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'target is required unless action=scroll' });
        }
      }),
  },
  {
    tool: 'alloy_find',
    engine: 'A',
    lease: 'per-call',
    summary: 'Locate an element by text/label/role/id and optionally act on it',
    schema: z
      .object({
        udid: deviceRef,
        by: z.enum(['text', 'label', 'role', 'id']),
        value: z.string().min(1),
        action: z.enum(['none', 'tap']).default('none'),
      })
      .strict(),
  },
  {
    tool: 'alloy_alert',
    engine: 'A',
    lease: 'per-call',
    summary: 'Inspect, accept, or dismiss a platform alert',
    schema: z
      .object({
        udid: deviceRef,
        action: z.enum(['inspect', 'accept', 'dismiss']).default('inspect'),
      })
      .strict(),
  },
  {
    tool: 'alloy_settings',
    engine: 'A',
    lease: 'per-call',
    summary: 'Change device settings such as permissions or airplane mode',
    schema: z
      .object({
        udid: deviceRef,
        area: z.string().min(1).describe('settings area, e.g. permissions, airplane'),
        values: z.record(z.string()).optional(),
      })
      .strict(),
  },
  {
    tool: 'alloy_measure',
    engine: 'B',
    lease: 'per-call',
    summary: 'Complete-coordinate measurement tree for parity/layout validation',
    schema: z.object({ udid: deviceRef }).strict(),
  },
  {
    tool: 'alloy_native_tree',
    engine: 'B',
    lease: 'per-call',
    summary: 'Native view hierarchy deep-dive with hit-test verification',
    schema: z
      .object({
        udid: deviceRef,
        query: z.enum(['hierarchy', 'find-views', 'interactable-at']).default('hierarchy'),
        className: z.string().min(1).optional(),
        id: z.string().min(1).optional(),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
      })
      .strict()
      .superRefine((v, ctx) => {
        if (v.query === 'find-views' && !v.className && !v.id) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'className or id required for find-views' });
        }
        if (v.query === 'interactable-at' && (v.x === undefined || v.y === undefined)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'x and y required for interactable-at' });
        }
      }),
  },
  {
    tool: 'alloy_flow',
    engine: 'B',
    lease: 'per-call',
    summary: 'Run a declarative flow (E2E verification) with launch-arg preconditions',
    schema: z
      .object({
        udid: deviceRef,
        flowPath: z.string().min(1).describe('path to the flow YAML file'),
        updateBaselines: z
          .boolean()
          .optional()
          .describe('write/refresh screenshot baselines for snapshot steps instead of diffing against them'),
      })
      .strict(),
  },
  {
    tool: 'alloy_video',
    engine: 'B',
    lease: 'per-call',
    summary: 'Start/stop screen recording with playable-artifact validation',
    schema: z
      .object({
        udid: deviceRef,
        action: z.enum(['start', 'stop']),
        label: z.string().min(1).optional(),
      })
      .strict(),
  },
  {
    tool: 'alloy_screenshot_diff',
    engine: 'B',
    lease: 'per-call',
    summary: 'Compare two screenshots into a compact visual-diff summary',
    schema: z
      .object({
        baselinePath: z.string().min(1),
        currentPath: z.string().min(1).optional(),
        auto: z.boolean().default(false).describe('capture current screenshot automatically'),
        udid: deviceRef.optional(),
      })
      .strict()
      .superRefine((v, ctx) => {
        if (!v.auto && !v.currentPath) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'currentPath required unless auto=true' });
        }
        if (v.auto && !v.udid) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'udid required when auto=true' });
        }
      }),
  },
  {
    tool: 'alloy_flow_report',
    engine: 'B',
    lease: 'per-call',
    summary: 'Structured per-scenario report of the last flow run',
    schema: z.object({}).strict(),
  },
  {
    tool: 'alloy_network',
    engine: 'A',
    lease: 'per-call',
    summary: 'Parsed network request dump for the session',
    schema: z
      .object({
        udid: deviceRef,
        limit: z.number().int().positive().max(500).default(25),
        include: z.enum(['none', 'headers', 'bodies', 'all']).optional(),
      })
      .strict(),
  },
  {
    tool: 'alloy_logs',
    engine: 'A',
    lease: 'per-call',
    summary: 'Mark or capture app logs for the session',
    schema: z
      .object({
        udid: deviceRef,
        action: z.enum(['mark', 'capture', 'start', 'stop', 'clear']).default('capture'),
        message: z.string().optional(),
      })
      .strict()
      .superRefine((v, ctx) => {
        if (v.action === 'mark' && typeof v.message !== 'string') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'message is required for mark' });
        }
      }),
  },
  {
    tool: 'alloy_perf',
    engine: 'A',
    lease: 'per-call',
    summary: 'Performance evidence: frames, memory, cpu, or trace sampling',
    schema: z
      .object({
        udid: deviceRef,
        area: z.enum(['frames', 'memory', 'cpu', 'trace']),
        action: z.enum(['sample', 'snapshot', 'start', 'stop', 'report']).default('sample'),
      })
      .strict(),
  },
  {
    tool: 'alloy_push',
    engine: 'A',
    lease: 'per-call',
    summary: 'Deliver a push notification payload to an app',
    schema: z
      .object({
        udid: deviceRef,
        app: z.string().min(1),
        payload: z.record(z.unknown()),
      })
      .strict(),
  },
  {
    tool: 'alloy_js_debug',
    engine: 'B',
    lease: 'per-call',
    summary: 'JS runtime introspection: connect/status/evaluate/component tree',
    schema: z
      .object({
        udid: deviceRef,
        action: z.enum(['connect', 'status', 'evaluate', 'component-tree']),
        expression: z.string().optional(),
        port: z.number().int().default(8081),
      })
      .strict()
      .superRefine((v, ctx) => {
        if (v.action === 'evaluate' && typeof v.expression !== 'string') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expression required for evaluate' });
        }
      }),
  },
  {
    tool: 'alloy_replay',
    engine: 'A',
    lease: 'held',
    summary: 'Replay a recorded session script deterministically',
    schema: z
      .object({
        udid: deviceRef,
        scriptPath: z.string().min(1),
        timeoutMs: z.number().int().positive().max(600000).optional(),
      })
      .strict(),
  },
] as const;

export function getRoutingRow(tool: string): RoutingRow | undefined {
  return routingTable.find((r) => r.tool === tool);
}

export const routingToolNames: readonly string[] = routingTable.map((r) => r.tool);
