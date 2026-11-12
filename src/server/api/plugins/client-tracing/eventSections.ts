import {
  normalizeTraceEventUsage,
  type NormalizedTraceEventUsage,
} from '@/lib/services/tracing/traceUsage';
import {
  buildResponseFormatSection,
  normalizeSectionListResponseFormat,
  RESPONSE_FORMAT_SECTION_KIND,
} from '@/lib/services/tracingResponseFormat';
import {
  buildToolDefinitionsSection,
  normalizeSectionListToolDefinitions,
  TOOL_DEFINITIONS_SECTION_KIND,
} from '@/lib/services/tracingToolDefinitions';
import {
  normalizeFinishReason,
} from '@/lib/shared/finishReason';
import type { TracingEventPayload, TracingUsage } from './payloadTypes';
import { toRecord } from './recordCoerce';

export function getEventSections(event: TracingEventPayload): Array<Record<string, unknown>> {
  const rawSections = Array.isArray(event.sections)
    ? event.sections
    : (Array.isArray(event.data?.sections) ? event.data.sections : []);

  // tool_definitions and response_format sections get the shared cap/shape
  // treatment whether the sender encoded the section itself or used the
  // first-class `toolDefinitions` / `responseFormat` event field (the fields
  // are normalized into sections so SDK senders don't need to know the
  // encoding). Malformed input is ignored silently.
  let sections = normalizeSectionListResponseFormat(
    normalizeSectionListToolDefinitions(rawSections.flatMap((section) => {
      const normalized = toRecord(section);
      return normalized ? [normalized] : [];
    })),
  );

  const menuFromField = buildToolDefinitionsSection(event.toolDefinitions);
  if (menuFromField && !sections.some((section) => section.kind === TOOL_DEFINITIONS_SECTION_KIND)) {
    sections = [...sections, menuFromField];
  }

  const formatFromField = buildResponseFormatSection(event.responseFormat);
  if (formatFromField && !sections.some((section) => section.kind === RESPONSE_FORMAT_SECTION_KIND)) {
    sections = [...sections, formatFromField];
  }

  return sections;
}

export function normalizeToolName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getSectionToolName(section: Record<string, unknown>): string | undefined {
  return normalizeToolName(section.tool)
    || normalizeToolName(section.toolName)
    || normalizeToolName(section.name);
}

export function getEventToolDetails(
  event: TracingEventPayload,
  sections: Array<Record<string, unknown>> = getEventSections(event),
): Record<string, unknown> | undefined {
  const candidates = [
    // Network payloads aren't trustworthy just because the TS type says
    // `toolDetails?: Record<string, unknown>` — a bad upstream serializer can
    // hand this the literal string "undefined" (see agent-sdk's
    // sanitizeTracePayload), and Boolean("undefined") is true, so an
    // unguarded string here survives `.find(Boolean)` and then gets
    // spread into single-character indexed keys below.
    toRecord(event.toolDetails),
    toRecord(event.metadata?.toolDetails),
    toRecord(event.data?.toolDetails),
    ...sections.map((section) => toRecord(section.toolDetails) || toRecord(section.details)),
  ];

  const details = candidates.find((candidate): candidate is Record<string, unknown> => Boolean(candidate));
  const name = normalizeToolName(details?.name)
    || normalizeToolName(event.toolName)
    || (event.actor?.scope === 'tool' ? normalizeToolName(event.actor?.name) : undefined)
    || sections.map(getSectionToolName).find(Boolean);

  if (!details && !name) {
    return undefined;
  }

  return {
    ...(details || {}),
    ...(name && !normalizeToolName(details?.name) ? { name } : {}),
  };
}

export function collectEventToolNames(event: TracingEventPayload): string[] {
  const names = new Set<string>();
  const sections = getEventSections(event);
  const toolDetails = getEventToolDetails(event, sections);
  const directNames = [
    normalizeToolName(event.toolName),
    event.actor?.scope === 'tool' ? normalizeToolName(event.actor.name) : undefined,
    normalizeToolName(toolDetails?.name),
    ...sections.map(getSectionToolName),
  ];

  for (const name of directNames) {
    if (name) names.add(name);
  }

  return Array.from(names);
}

/**
 * Pull `finishReason` / `reasoningTokens` off a raw ingest event — they are
 * now first-class columns on `IAgentTracingEvent`, not metadata. Tolerant of
 * every shape a real producer SDK sends, because the fallbacks below each
 * correspond to one upstream integration that never populated the top-level
 * field:
 *   - `event.metadata.finish_reason` — Python-style SDKs that only ever wrote
 *     the snake_case form;
 *   - `event.metadata.stop_reason` — the Claude Agent SDK integration, which
 *     writes Anthropic's own vocabulary rather than normalizing it first;
 *   - `event.metadata.finishReasons` (plural) — the OTel exporter, which
 *     ships a JSON array or comma-joined string because a single export can
 *     bundle multiple choices; the first element wins;
 *   - `event.usage.completion_tokens_details.reasoning_tokens` /
 *     `.output_tokens_details.reasoning_tokens` — raw OpenAI/Azure and OTel
 *     GenAI usage payloads passed through verbatim instead of being
 *     flattened by the sender.
 */
export function extractTraceDiagnostics(event: TracingEventPayload): {
  finishReason?: string;
  reasoningTokens?: number;
} {
  const metadata = event.metadata;
  const usage = event.usage;

  const rawFinishReasons = metadata?.finishReasons;
  const firstOfFinishReasons = Array.isArray(rawFinishReasons)
    ? rawFinishReasons[0]
    : (typeof rawFinishReasons === 'string' ? rawFinishReasons.split(',')[0] : undefined);

  const finishReason = normalizeFinishReason(
    event.finishReason
      ?? metadata?.finishReason
      ?? metadata?.finish_reason
      ?? metadata?.stop_reason
      ?? firstOfFinishReasons,
  );

  const rawReasoningTokens = event.reasoningTokens
    ?? usage?.reasoningTokens
    ?? usage?.reasoning_tokens
    ?? usage?.completion_tokens_details?.reasoning_tokens
    ?? usage?.output_tokens_details?.reasoning_tokens
    ?? metadata?.reasoningTokens;
  const reasoningTokens = Number(rawReasoningTokens);

  return {
    finishReason,
    reasoningTokens: Number.isFinite(reasoningTokens) && reasoningTokens > 0 ? reasoningTokens : undefined,
  };
}

export function buildEventMetadata(event: TracingEventPayload, sections: Array<Record<string, unknown>>): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...(event.metadata || {}) };
  // finishReason / reasoningTokens are now first-class columns (see
  // extractTraceDiagnostics above) — strip the keys this used to fold them
  // from so the same value never gets persisted twice.
  delete metadata.finishReason;
  delete metadata.finish_reason;
  delete metadata.stop_reason;
  delete metadata.finishReasons;
  delete metadata.reasoningTokens;
  // Same for the cache-write count and the basis flags (see resolveTraceEventUsage).
  delete metadata.cacheWriteTokens;
  delete metadata.usageBasis;

  const toolDetails = getEventToolDetails(event, sections);
  if (toolDetails) {
    metadata.toolDetails = toolDetails;
  }
  return metadata;
}

function getEventUsage(event: TracingEventPayload): TracingUsage {
  return event.usage || event.metadata?.usage || {};
}

/**
 * Canonical usage of one ingested event: gathers the (top-level, `usage`,
 * `metadata`) spellings and folds the SDK's `usageBasis` through the shared
 * pure helper so stored events, session totals, pricing and metrics all see
 * inclusive input/output. Events without a basis flag pass through untouched.
 */
export function resolveTraceEventUsage(event: TracingEventPayload): NormalizedTraceEventUsage {
  const usage = getEventUsage(event);
  const diagnostics = extractTraceDiagnostics(event);
  return normalizeTraceEventUsage({
    inputTokens: event?.inputTokens ?? usage?.inputTokens ?? usage?.input_tokens,
    outputTokens: event?.outputTokens ?? usage?.outputTokens ?? usage?.output_tokens,
    cachedInputTokens:
      event?.cachedInputTokens
      ?? usage?.cachedInputTokens
      ?? usage?.cached_input_tokens
      ?? usage?.cacheReadInputTokens
      ?? usage?.cache_read_input_tokens,
    cacheWriteTokens:
      event?.cacheWriteTokens
      ?? usage?.cacheWriteTokens
      ?? usage?.cache_write_tokens
      ?? usage?.cacheCreationInputTokens
      ?? usage?.cache_creation_input_tokens
      ?? event?.metadata?.cacheWriteTokens,
    reasoningTokens: diagnostics.reasoningTokens,
    totalTokens: event?.totalTokens,
    usageBasis: event?.usageBasis ?? usage?.usageBasis ?? event?.metadata?.usageBasis,
  });
}
