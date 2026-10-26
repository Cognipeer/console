/**
 * Canonical usage for externally ingested trace events (`/client/v1/tracing`).
 *
 * The console stores every usage number in ONE basis: `inputTokens` is all
 * prompt tokens (uncached + cache-read + cache-write) and `outputTokens` is all
 * generated tokens (visible + reasoning). The agent-sdk trace record carries its
 * provider's NATIVE counts plus `usageBasis` flags that say where they differ:
 *   - inputExcludesCache      (anthropic / bedrock): input excludes read + write
 *   - outputExcludesReasoning (vertex): output excludes reasoning
 * A record without flags is already inclusive and passes through untouched.
 *
 * Pure: no I/O, no config. Used by both the JSON batch path and the stream path
 * of client-tracing so the fold happens in exactly one place. Console-hosted
 * agent trace docs never go through this — their usage is already canonical.
 */

export interface TraceUsageBasis {
  inputExcludesCache?: boolean | null;
  outputExcludesReasoning?: boolean | null;
}

export interface RawTraceEventUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  /** Cache-READ subset. */
  cachedInputTokens?: unknown;
  /** Cache-WRITE subset (SDK wire name `cacheWriteTokens`). */
  cacheWriteTokens?: unknown;
  reasoningTokens?: unknown;
  totalTokens?: unknown;
  usageBasis?: unknown;
}

export interface NormalizedTraceEventUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  /** Cache-WRITE subset of inputTokens; only set when > 0. */
  cachedWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** True when the basis flags changed input and/or output. */
  adjusted: boolean;
  /** Tokens added to inputTokens / outputTokens by the fold (0 when none). */
  inputDelta: number;
  outputDelta: number;
}

/** Non-negative finite number, else undefined. Numeric strings are accepted. */
function count(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readBasis(value: unknown): TraceUsageBasis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const basis = value as Record<string, unknown>;
  return {
    inputExcludesCache: basis.inputExcludesCache === true,
    outputExcludesReasoning: basis.outputExcludesReasoning === true,
  };
}

export function normalizeTraceEventUsage(raw: RawTraceEventUsage): NormalizedTraceEventUsage {
  const basis = readBasis(raw.usageBasis);
  const read = count(raw.cachedInputTokens);
  const write = count(raw.cacheWriteTokens);
  const reasoning = count(raw.reasoningTokens);
  let inputTokens = count(raw.inputTokens);
  let outputTokens = count(raw.outputTokens);
  let inputDelta = 0;
  let outputDelta = 0;

  if (basis.inputExcludesCache && inputTokens !== undefined) {
    inputDelta = (read ?? 0) + (write ?? 0);
    inputTokens += inputDelta;
  }
  if (basis.outputExcludesReasoning && outputTokens !== undefined) {
    outputDelta = reasoning ?? 0;
    outputTokens += outputDelta;
  }

  const adjusted = inputDelta > 0 || outputDelta > 0;
  const totalTokens = adjusted
    ? (inputTokens ?? 0) + (outputTokens ?? 0)
    : count(raw.totalTokens);

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: read,
    cachedWriteTokens: write !== undefined && write > 0 ? write : undefined,
    reasoningTokens: reasoning,
    totalTokens,
    adjusted,
    inputDelta,
    outputDelta,
  };
}
