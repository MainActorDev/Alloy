/**
 * Unified error taxonomy. Every engine failure surfaces as a structured AlloyError —
 * never a raw string throw. Codes derive from the device engine's typed codes with a
 * default branch for unknown engine-originated codes (they arrive widened on the wire).
 */

export const ALLOY_ERROR_CODES = [
  // framework-level
  'VALIDATION_FAILED',
  'TOOL_NOT_FOUND',
  'LEASE_HELD',
  'ENGINE_UNAVAILABLE',
  'ENGINE_SKEWED',
  'CONFIG_MISSING',
  'UNSUPPORTED_OPERATION',
  // engine-mapped (default branch catches anything else)
  'INVALID_ARGS',
  'DEVICE_NOT_FOUND',
  'DEVICE_IN_USE',
  'SESSION_NOT_FOUND',
  'APP_NOT_INSTALLED',
  'AMBIGUOUS_MATCH',
  'COMMAND_FAILED',
  'UNKNOWN_ENGINE_CODE',
] as const;

export type AlloyErrorCode = (typeof ALLOY_ERROR_CODES)[number];

export interface AlloyErrorCandidate {
  ref?: string;
  role?: string;
  label?: string;
}

export interface AlloyErrorDetails {
  hint?: string;
  retriable?: boolean;
  reason?: string;
  holder?: string;
  candidates?: AlloyErrorCandidate[];
  engineCode?: string;
}

export interface AlloyErrorShape {
  code: AlloyErrorCode;
  message: string;
  details?: AlloyErrorDetails;
  engine: 'A' | 'B' | null;
}

/** Structured, serializable failure. Thrown by dispatch, caught at the MCP boundary. */
export class AlloyError extends Error {
  readonly code: AlloyErrorCode;
  readonly details: AlloyErrorDetails | undefined;
  readonly engine: 'A' | 'B' | null;

  constructor(code: AlloyErrorCode, message: string, options?: {
    details?: AlloyErrorDetails;
    engine?: 'A' | 'B' | null;
    cause?: unknown;
  }) {
    super(message, { cause: options?.cause });
    this.name = 'AlloyError';
    this.code = code;
    this.details = options?.details;
    this.engine = options?.engine ?? null;
  }

  toJSON(): AlloyErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      engine: this.engine,
    };
  }
}

/**
 * Map an engine-A-shaped failure into the taxonomy. Never parses message text.
 * DEVICE_IN_USE is the engine's own retriable code; preserved in details.retriable.
 */
export function normalizeEngineAError(err: unknown, context: string): AlloyError {
  const anyErr = err as { code?: unknown; message?: unknown; details?: Record<string, unknown> } | null | undefined;
  if (anyErr && typeof anyErr === 'object' && typeof anyErr.code === 'string') {
    const code = ALLOY_ERROR_CODES.includes(anyErr.code as AlloyErrorCode)
      ? (anyErr.code as AlloyErrorCode)
      : 'UNKNOWN_ENGINE_CODE';
    const rawDetails = (anyErr.details ?? {}) as Record<string, unknown>;
    const details: AlloyErrorDetails = {
      ...(typeof rawDetails.hint === 'string' ? { hint: rawDetails.hint } : {}),
      ...('retriable' in rawDetails ? { retriable: Boolean(rawDetails.retriable) } : {}),
      ...(typeof rawDetails.reason === 'string' ? { reason: rawDetails.reason } : {}),
      ...(Array.isArray(rawDetails.devices) ? { candidates: rawDetails.devices as AlloyErrorCandidate[] } : {}),
      engineCode: anyErr.code,
    };
    return new AlloyError(code, `${context}: ${String(anyErr.message ?? 'engine failure')}`, {
      details,
      engine: 'A',
      cause: err,
    });
  }
  return new AlloyError('COMMAND_FAILED', `${context}: ${errText(err)}`, { engine: 'A', cause: err });
}

/** Map an engine-B-shaped failure (HTTP failure envelope) into the taxonomy. */
export function normalizeEngineBError(err: unknown, context: string): AlloyError {
  const anyErr = err as {
    error_code?: unknown;
    message?: unknown;
    issues?: Array<{ path?: string[]; message?: string }>;
    error?: { message?: unknown };
  } | null | undefined;
  if (anyErr && typeof anyErr === 'object') {
    if (typeof anyErr.error_code === 'string') {
      const code = ALLOY_ERROR_CODES.includes(anyErr.error_code as AlloyErrorCode)
        ? (anyErr.error_code as AlloyErrorCode)
        : 'UNKNOWN_ENGINE_CODE';
      return new AlloyError(code, `${context}: ${String(anyErr.message ?? 'engine failure')}`, {
        details: { engineCode: anyErr.error_code },
        engine: 'B',
        cause: err,
      });
    }
    if (Array.isArray(anyErr.issues)) {
      return new AlloyError('VALIDATION_FAILED', `${context}: engine input rejected`, {
        details: { reason: anyErr.issues.map((i) => `${(i.path ?? []).join('.')}: ${i.message ?? ''}`).join('; ') },
        engine: 'B',
        cause: err,
      });
    }
  }
  return new AlloyError('COMMAND_FAILED', `${context}: ${errText(err)}`, { engine: 'B', cause: err });
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
