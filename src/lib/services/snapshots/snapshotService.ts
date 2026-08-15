/**
 * Traffic Snapshots service — sample production traffic into an evaluation
 * dataset, behind a mandatory anonymization gate.
 *
 * Sources:
 *   - 'gateway' — model_usage_logs rows (providerRequest / providerResponse
 *     payloads recorded by the models service at serving time). The request's
 *     chat messages become DatasetItem.input, its tool definitions become
 *     DatasetItem.tools, the recorded assistant text becomes
 *     expected.reference and recorded tool_calls become expected.toolCalls
 *     (argsMatch 'subset').
 *   - 'tracing' — agent tracing sessions/events. Best effort: message-kind
 *     sections ({kind:'message', role, content}) are reconstructed into a
 *     conversation; sessions without such sections are skipped and counted.
 *     Each session emits up to MAX_ITEMS_PER_SESSION items — one per
 *     assistant action point (tool-call decisions + final answer) — with a
 *     tool menu attached to every item, so parity runs actually test tool
 *     decisions. The menu prefers RECORDED `tool_definitions` sections
 *     (carried per model-call event — the menu can change between turns, so
 *     each item gets the menu active at its action point) and falls back to
 *     definitions inferred from the observed calls.
 *
 * Determinism: a row is in the sample iff
 *   uint32BE(sha256(stableId)[0..4]) % 100 < samplePct
 * where stableId is requestId (gateway) / sessionId (tracing). The same
 * percentage always selects the same subset, and a smaller percentage selects
 * a strict subset of a larger one.
 *
 * Privacy gate: EVERY string destined for a dataset item first goes through
 * the persisted-log scrubber (`redactLogPayload` — sensitive key names +
 * size caps) and then through the PII anonymization pipeline
 * (`anonymizeText` / `anonymizeMessages`). `createSnapshotDataset` refuses to
 * run without valid anonymization options, and the recorded provenance
 * metadata never includes the salt.
 *
 * Persistence goes through the EXISTING evaluation dataset creation path
 * (`createDataset`, source 'generated') — no new collection.
 */

import { createHash } from 'node:crypto';
import { getDatabase } from '@/lib/database';
import type { IAgentTracingEvent, IAgentTracingSession, IModelUsageLog, IUsageDaily } from '@/lib/database';
import { createDataset } from '@/lib/services/evaluation/service';
import { toUtcDay } from '@/lib/services/usage/usageBreakdown';
import { anonymizeText, type AnonymizeOptions } from '@/lib/services/pii/anonymize';
import { redactLogPayload } from '@/lib/services/logRedaction';
import type {
  CreateSnapshotParams,
  CreateSnapshotResult,
  SnapshotBreakdownEntry,
  SnapshotContext,
  SnapshotDatasetItem,
  SnapshotFilters,
  SnapshotParams,
  SnapshotPreview,
  SnapshotSkipCounts,
  TracingSessionShape,
} from './types';

/** Hard cap on items a single snapshot may create. */
export const SNAPSHOT_HARD_LIMIT = 1000;
/** Byte budget for a snapshot's serialized items — one dataset is ONE Mongo
 *  document (16MB hard cap); tool-heavy trace conversations hit it fast. */
export const SNAPSHOT_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024;
/** Cap on rows/sessions enumerated per snapshot operation (bounds DB work). */
export const SNAPSHOT_SCAN_CAP = 5000;
/** Page size for DB enumeration (Mongo caps listModelUsageLogs at 200). */
const PAGE_SIZE = 200;

/** Tracing session statuses treated as 'error' for the status filter. */
const TRACING_ERROR_STATUSES = new Set(['error', 'failed']);

// ── Deterministic sampling ─────────────────────────────────────────────────

/**
 * Stable hash-based sample membership. Monotonic in samplePct: the pct=10
 * subset is contained in the pct=50 subset because bucket < 10 ⇒ bucket < 50.
 */
export function isSampled(stableId: string, samplePct: number): boolean {
  if (samplePct >= 100) return true;
  if (samplePct <= 0) return false;
  const digest = createHash('sha256').update(stableId).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < samplePct;
}

function normalizeSamplePct(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 100;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return SNAPSHOT_HARD_LIMIT;
  return Math.min(Math.floor(value), SNAPSHOT_HARD_LIMIT);
}

// ── Anonymization gate ─────────────────────────────────────────────────────

/** Throw unless the options describe a usable anonymization pass. */
export function assertAnonymizeOptions(opts: AnonymizeOptions | undefined): asserts opts is AnonymizeOptions {
  if (!opts || typeof opts !== 'object') {
    throw new Error('`anonymize` options are required — snapshots must pass the anonymization gate');
  }
  if (opts.strategy !== 'mask' && opts.strategy !== 'pseudonym') {
    throw new Error('`anonymize.strategy` must be "mask" or "pseudonym"');
  }
  if (typeof opts.salt !== 'string' || opts.salt.length === 0) {
    throw new Error('`anonymize.salt` is required');
  }
  const hasCategories = Array.isArray(opts.categories) && opts.categories.length > 0;
  const hasCustom = Array.isArray(opts.customPatterns) && opts.customPatterns.length > 0;
  if (!hasCategories && !hasCustom) {
    throw new Error('`anonymize.categories` must enable at least one category (or supply customPatterns)');
  }
}

/** Scrub (log-redaction) then anonymize a single string. */
/** Per-string ceiling — tool-heavy trace contents otherwise balloon a single
 *  message into megabytes and the dataset document past Mongo's 16MB cap. */
const MAX_ITEM_STRING_CHARS = 16_000;

function cleanText(text: string, opts: AnonymizeOptions, counter: { findings: number }): string {
  // redactLogPayload on a bare string applies the value-scrub path; key-name
  // scrubbing happens where whole payload objects are redacted before mapping.
  const scrubbed = redactLogPayload(text);
  const result = anonymizeText(scrubbed, opts);
  counter.findings += result.findings;
  return result.text.length > MAX_ITEM_STRING_CHARS
    ? `${result.text.slice(0, MAX_ITEM_STRING_CHARS)} …[truncated]`
    : result.text;
}

// ── Gateway payload mapping ────────────────────────────────────────────────

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

/**
 * Unwrap a persisted provider payload. Handles the two persisted shapes that
 * are NOT a plain object payload:
 *   - `{_truncated: true, preview}` — redaction size-cap marker;
 *   - `{value: '<json string>'}`    — usageLogger's toRecord() wrapper around
 *     a string payload (parse it; unparseable = truncated mid-JSON).
 * Returns undefined when the payload is unusable (counts as truncated).
 */
function unwrapPayload(payload: unknown): UnknownRecord | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  if (record._truncated === true) return undefined;
  if (typeof record.value === 'string' && Object.keys(record).length === 1) {
    try {
      return asRecord(JSON.parse(record.value));
    } catch {
      return undefined;
    }
  }
  return record;
}

/** Flatten OpenAI-style message content (string | parts[]) to plain text. */
function flattenContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((part) => {
        const record = asRecord(part);
        return record && typeof record.text === 'string' ? record.text : undefined;
      })
      .filter((text): text is string => typeof text === 'string');
    return texts.length > 0 ? texts.join('\n') : undefined;
  }
  return undefined;
}

/**
 * Normalise a recorded provider response to the OpenAI assistant-message
 * shape (`{content?, tool_calls?}`).
 *
 * Non-streamed calls are logged as the OpenAI envelope
 * (`{choices:[{message:{…}}]}`), but the streaming path logs the accumulated
 * LangChain `AIMessageChunk` instead — a serialised
 * `{lc, type, id, kwargs:{content, tool_calls}}` object with no `choices` at
 * all (see `inferenceService.ts`, `logStreamOutcome`). Reading only `choices`
 * meant every streamed request produced a dataset item with no reference and
 * no expected tool calls, which silently dragged down the pass rate of any
 * reference-based scorer. Streaming is the default for chat clients, so that
 * was most of a typical tenant's traffic.
 */
function extractAssistantMessage(response: Record<string, unknown> | undefined) {
  if (!response) return undefined;

  const choice = asRecord(Array.isArray(response.choices) ? response.choices[0] : undefined);
  const fromEnvelope = asRecord(choice?.message);
  if (fromEnvelope) return fromEnvelope;

  // Serialised LangChain message/chunk.
  const kwargs = asRecord(response.kwargs);
  if (kwargs && (kwargs.content !== undefined || Array.isArray(kwargs.tool_calls))) {
    // LangChain tool calls are `{name, args, id}`; the OpenAI envelope nests
    // them under `function: {name, arguments}`. Re-shape so the caller below
    // reads one format.
    const toolCalls = Array.isArray(kwargs.tool_calls)
      ? kwargs.tool_calls.map((call) => {
        const record = asRecord(call);
        if (!record) return call;
        if (asRecord(record.function)) return record;
        return {
          ...record,
          function: {
            name: record.name,
            arguments: record.args !== undefined ? JSON.stringify(record.args) : undefined,
          },
        };
      })
      : undefined;
    return { content: kwargs.content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
  }

  return undefined;
}

const EVAL_ROLES = new Set(['system', 'user', 'assistant']);

export type GatewayMapOutcome =
  | { kind: 'item'; item: SnapshotDatasetItem; findings: number }
  | { kind: 'skip'; reason: 'truncatedPayload' | 'missingMessages' };

/**
 * Map one model_usage_logs row to a dataset item. Pure — exported for tests.
 * The row's payloads are scrubbed (key-name + size redaction) before any
 * field is read, and every extracted string is anonymized.
 */
export function mapGatewayRow(row: IModelUsageLog, anonymize: AnonymizeOptions): GatewayMapOutcome {
  const request = unwrapPayload(redactLogPayload(row.providerRequest));
  if (!request) return { kind: 'skip', reason: 'truncatedPayload' };

  const messages = Array.isArray(request.messages) ? request.messages : undefined;
  if (!messages || messages.length === 0) return { kind: 'skip', reason: 'missingMessages' };

  const counter = { findings: 0 };
  const input: SnapshotDatasetItem['input'] = [];
  const toolResults: Record<string, unknown> = {};

  /** Parse recorded `tool_calls` on a history assistant turn (ids kept). */
  const parseHistoryToolCalls = (
    value: unknown,
  ): NonNullable<SnapshotDatasetItem['input'][number]['toolCalls']> => {
    const calls: NonNullable<SnapshotDatasetItem['input'][number]['toolCalls']> = [];
    if (!Array.isArray(value)) return calls;
    for (const entry of value) {
      const call = asRecord(entry);
      const fn = asRecord(call?.function);
      if (!fn || typeof fn.name !== 'string') continue;
      let args: Record<string, unknown> = {};
      if (typeof fn.arguments === 'string') {
        const cleaned = cleanText(fn.arguments, anonymize, counter);
        try {
          const parsed = JSON.parse(cleaned);
          args = asRecord(parsed) ?? { __raw: cleaned };
        } catch {
          args = { __raw: cleaned };
        }
      }
      calls.push({
        ...(typeof call?.id === 'string' ? { id: call.id } : {}),
        name: fn.name,
        args,
      });
    }
    return calls;
  };

  for (let i = 0; i < messages.length; i++) {
    const message = asRecord(messages[i]);
    if (!message) continue;
    const role = typeof message.role === 'string' ? message.role : '';
    const text = flattenContent(message.content);

    if (role === 'tool') {
      // Full fidelity: the tool response stays IN the conversation (replay
      // needs it) and ALSO rides along as toolResults for the trajectory mock.
      const key = typeof message.tool_call_id === 'string' ? message.tool_call_id : `tool_${i}`;
      const cleaned = text !== undefined ? cleanText(text, anonymize, counter) : '';
      toolResults[key] = cleaned;
      input.push({
        role: 'tool',
        content: cleaned,
        toolCallId: key,
        ...(typeof message.name === 'string' ? { name: message.name } : {}),
      });
      continue;
    }
    if (role === 'assistant') {
      // Keep the tool calls a history assistant turn issued — and keep the
      // turn itself even when it carried no text (tool-call-only turns).
      const toolCalls = parseHistoryToolCalls(message.tool_calls);
      if (text === undefined && toolCalls.length === 0) continue;
      input.push({
        role: 'assistant',
        content: text !== undefined ? cleanText(text, anonymize, counter) : '',
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      continue;
    }
    if (!EVAL_ROLES.has(role) || text === undefined) continue;
    input.push({ role: role as 'system' | 'user', content: cleanText(text, anonymize, counter) });
  }

  if (input.length === 0) return { kind: 'skip', reason: 'missingMessages' };

  // Tool definitions (OpenAI {type:'function', function:{...}}).
  const tools: SnapshotDatasetItem['tools'] = [];
  if (Array.isArray(request.tools)) {
    for (const entry of request.tools) {
      const fn = asRecord(asRecord(entry)?.function);
      if (!fn || typeof fn.name !== 'string') continue;
      tools.push({
        name: fn.name,
        description: typeof fn.description === 'string' ? cleanText(fn.description, anonymize, counter) : undefined,
        parameters: asRecord(fn.parameters),
      });
    }
  }

  // Expected output from the recorded provider response.
  const expected: Record<string, unknown> = {};
  const response = unwrapPayload(redactLogPayload(row.providerResponse));
  const assistant = extractAssistantMessage(response);
  if (assistant) {
    const referenceText = flattenContent(assistant.content);
    if (referenceText !== undefined && referenceText.length > 0) {
      expected.reference = cleanText(referenceText, anonymize, counter);
    }
    if (Array.isArray(assistant.tool_calls)) {
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const call of assistant.tool_calls) {
        const fn = asRecord(asRecord(call)?.function);
        if (!fn || typeof fn.name !== 'string') continue;
        let args: unknown;
        if (typeof fn.arguments === 'string') {
          const cleaned = cleanText(fn.arguments, anonymize, counter);
          try {
            args = JSON.parse(cleaned);
          } catch {
            args = cleaned; // keep the anonymized raw string when unparseable
          }
        }
        toolCalls.push({ name: fn.name, argsMatch: 'subset', ...(args !== undefined ? { args } : {}) });
      }
      if (toolCalls.length > 0) expected.toolCalls = toolCalls;
    }
  }

  const item: SnapshotDatasetItem = {
    id: `gw-${row.requestId}`,
    input,
    ...(Object.keys(expected).length > 0 ? { expected } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(Object.keys(toolResults).length > 0 ? { toolResults } : {}),
    tags: ['snapshot', 'gateway', `model:${row.modelKey}`],
  };
  return { kind: 'item', item, findings: counter.findings };
}

// ── Tracing mapping ────────────────────────────────────────────────────────

interface TracingMessage {
  role: 'system' | 'user' | 'assistant';
  text: string;
}

function normalizeTracingRole(role: unknown): TracingMessage['role'] | undefined {
  if (typeof role !== 'string') return undefined;
  const value = role.trim().toLowerCase();
  if (value === 'system') return 'system';
  if (value === 'user' || value === 'human') return 'user';
  if (value === 'assistant' || value === 'ai' || value === 'model') return 'assistant';
  return undefined;
}

export type TracingMapOutcome =
  | { kind: 'items'; items: SnapshotDatasetItem[]; findings: number; shape: TracingSessionShape }
  | { kind: 'skip'; shape: TracingSessionShape };

/**
 * Max dataset items one tracing session may emit: the final-answer item
 * (always included) plus the LAST up-to-3 tool actions — the decisions
 * closest to the answer carry the most signal.
 */
export const MAX_ITEMS_PER_SESSION = 4;

/** Map an observed JS value to a minimal JSON-schema type name. */
function inferJsonType(value: unknown): string | undefined {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (value !== null && typeof value === 'object') return 'object';
  return undefined; // null / undefined — key recorded, no type claim
}

/**
 * Infer a minimal JSON schema from the args objects observed for one tool:
 * properties = union of keys; a key gets a `type` only when every typed
 * observation agrees (conflicts → typeless key). No required list — recorded
 * traffic shows what WAS sent, not what MUST be.
 */
export function inferToolSchema(argsList: Array<Record<string, unknown>>): Record<string, unknown> {
  const observed = new Map<string, Set<string>>();
  for (const args of argsList) {
    for (const [key, value] of Object.entries(args)) {
      let types = observed.get(key);
      if (!types) {
        types = new Set<string>();
        observed.set(key, types);
      }
      const type = inferJsonType(value);
      if (type) types.add(type);
    }
  }
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [key, types] of observed) {
    properties[key] = types.size === 1 ? { type: [...types][0] } : {};
  }
  return { type: 'object', properties };
}

/**
 * Best-effort reconstruction of a conversation from a session's events.
 * Observed shape (custom JSON ingest and OTLP synthesis alike): events carry
 * `sections: Array<{kind, label, role?, content?}>`; message content lives in
 * sections with kind==='message', role + string content. Sessions with no
 * message sections at all are skipped and counted.
 *
 * A session yields MULTIPLE items — one per assistant ACTION point, so parity
 * runs test the tool DECISIONS and not just the final wording:
 *   - each run of consecutive tool_call turns is one tool action → item with
 *     `expected.toolCalls` (argsMatch 'subset'; unparseable args → name-only);
 *   - the final assistant message turn is the answer action → item with
 *     `expected.reference` (exactly the previous single-item behavior).
 * Every item of the session carries a tool menu (`item.tools`) — the
 * candidate needs the menu to make decisions. Menu precedence:
 *   1. RECORDED `tool_definitions` sections (contract in
 *      tracingToolDefinitions.ts) ride on the model-call events they apply
 *      to, and the menu CAN change between turns — a "current menu" is
 *      tracked as those sections stream by, and each item gets the menu
 *      active at its action point;
 *   2. tools the model demonstrably called around that point but the
 *      recorded menu lacks are merged in from the inferred definitions
 *      (defensive — the recorded menu must have been incomplete);
 *   3. no recorded definitions at all → the inferred menu, as before.
 * Capped at MAX_ITEMS_PER_SESSION (final answer always kept, then the LAST
 * tool actions). Sessions without tool actions yield the single reference
 * item exactly as before. Pure — exported for tests.
 */
export function mapTracingSession(
  session: IAgentTracingSession,
  events: IAgentTracingEvent[],
  anonymize: AnonymizeOptions,
): TracingMapOutcome {
  const ordered = [...events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  // Unified turn stream: message sections plus best-effort tool_call /
  // tool_result sections, so the reconstructed conversation keeps the tool
  // exchanges (replay is not faithful without them).
  type TracingTurn =
    | { kind: 'msg'; role: 'system' | 'user' | 'assistant'; text: string }
    | { kind: 'call'; name: string; argsText?: string }
    | { kind: 'result'; name?: string; text: string };
  const turns: TracingTurn[] = [];
  let messageSections = 0;

  const sectionToolName = (record: Record<string, unknown>, event: IAgentTracingEvent): string | undefined => {
    for (const value of [record.tool, record.toolName, record.name, event.toolName]) {
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return undefined;
  };
  const sectionText = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value.length > 0 ? value : undefined;
    if (value && typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  // Recorded tool menus: a `tool_definitions` section rides on the model-call
  // event it applies to. Each occurrence activates a new menu from that
  // event's first turn onward (`at` = turn position), so per-turn menu
  // changes map onto the turn stream. Entries stay raw here — descriptions
  // are cleaned later, once the shared findings counter exists.
  type RawRecordedTool = { name: string; description?: string; parameters?: Record<string, unknown> };
  const rawMenuChanges: Array<{ at: number; tools: RawRecordedTool[] }> = [];
  const parseRecordedToolDefinitions = (value: unknown): RawRecordedTool[] => {
    if (!Array.isArray(value)) return [];
    const tools: RawRecordedTool[] = [];
    for (const entry of value) {
      const record = asRecord(entry);
      if (!record || typeof record.name !== 'string' || record.name.length === 0) continue;
      const parameters = asRecord(record.parameters);
      tools.push({
        name: record.name,
        ...(typeof record.description === 'string' && record.description.length > 0
          ? { description: record.description }
          : {}),
        ...(parameters ? { parameters } : {}),
      });
    }
    return tools;
  };

  for (const event of ordered) {
    // Menu sections first, so the menu is active for the action this very
    // event produced (cut points at/after the event see it).
    for (const section of event.sections ?? []) {
      const record = asRecord(section);
      if (!record || record.kind !== 'tool_definitions') continue;
      const tools = parseRecordedToolDefinitions(record.tools);
      if (tools.length > 0) rawMenuChanges.push({ at: turns.length, tools });
    }
    for (const section of event.sections ?? []) {
      const record = asRecord(section);
      if (!record || record.kind === 'tool_definitions') continue;
      if (record.kind === 'message') {
        const role = normalizeTracingRole(record.role);
        if (!role || typeof record.content !== 'string' || record.content.length === 0) continue;
        messageSections += 1;
        turns.push({ kind: 'msg', role, text: record.content });
        continue;
      }
      if (record.kind === 'tool_call') {
        const name = sectionToolName(record, event);
        if (!name) continue;
        turns.push({
          kind: 'call',
          name,
          argsText: sectionText(record.args ?? record.input ?? record.arguments),
        });
        continue;
      }
      if (record.kind === 'tool_result') {
        // A result section whose content cannot be reconstructed still CLOSES
        // its call — dropping it would leave an unanswered tool_call, which
        // providers reject at replay time.
        const text = sectionText(record.result ?? record.output ?? record.content)
          ?? '[unreconstructable tool result]';
        turns.push({ kind: 'result', name: sectionToolName(record, event), text });
      }
    }
  }

  if (messageSections === 0) return { kind: 'skip', shape: 'none' };

  // Last assistant MESSAGE turn = the final-answer action point.
  let lastAssistant = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.kind === 'msg' && turn.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }

  // Convert EVERY turn once. converted[i] is turns[i] as an input message;
  // an item's input is a prefix slice, so the trcall id synthesis and the
  // call↔result pairing (both strictly sequential) stay consistent across
  // items, and each shared string is cleaned/counted exactly once.
  const counter = { findings: 0 };
  const converted: SnapshotDatasetItem['input'] = [];
  /** Per call-turn: turn index, tool name and the parsed args (only when the
   *  recorded argsText parsed to an object — drives expected/schema). */
  const callInfos: Array<{ index: number; name: string; parsedArgs?: Record<string, unknown> }> = [];
  let synthCall = 0;
  const openCallIds: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.kind === 'msg') {
      converted.push({ role: turn.role, content: cleanText(turn.text, anonymize, counter) });
      continue;
    }
    if (turn.kind === 'call') {
      const id = `trcall_${++synthCall}`;
      openCallIds.push(id);
      let args: Record<string, unknown> = {};
      let parsedArgs: Record<string, unknown> | undefined;
      if (turn.argsText !== undefined) {
        const cleaned = cleanText(turn.argsText, anonymize, counter);
        try {
          parsedArgs = asRecord(JSON.parse(cleaned));
        } catch {
          parsedArgs = undefined;
        }
        args = parsedArgs ?? { __raw: cleaned };
      }
      callInfos.push({ index: i, name: turn.name, ...(parsedArgs ? { parsedArgs } : {}) });
      converted.push({ role: 'assistant', content: '', toolCalls: [{ id, name: turn.name, args }] });
      continue;
    }
    const id = openCallIds.shift() ?? `trcall_${++synthCall}`;
    converted.push({
      role: 'tool',
      content: cleanText(turn.text, anonymize, counter),
      toolCallId: id,
      ...(turn.name ? { name: turn.name } : {}),
    });
  }

  // Inferred tool definitions — one per distinct tool name (first-seen order),
  // schema from the union of that tool's parsed args. A tool whose args never
  // parsed still appears with an empty schema: the menu must be complete.
  const argsByTool = new Map<string, Array<Record<string, unknown>>>();
  for (const call of callInfos) {
    const list = argsByTool.get(call.name) ?? [];
    if (call.parsedArgs) list.push(call.parsedArgs);
    argsByTool.set(call.name, list);
  }
  const sessionTools: NonNullable<SnapshotDatasetItem['tools']> = [...argsByTool.entries()].map(
    ([name, argsList]) => ({
      name,
      description: 'Inferred from recorded traffic',
      parameters: inferToolSchema(argsList),
    }),
  );

  // Recorded menus, cleaned: descriptions go through the scrub/anonymize
  // pipeline like every other persisted string; `parameters` (a JSON schema)
  // passes through raw, exactly as the gateway mapper treats it.
  const menuChanges = rawMenuChanges.map((change) => ({
    at: change.at,
    tools: change.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined
        ? { description: cleanText(tool.description, anonymize, counter) }
        : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
    })),
  }));

  /**
   * Tool menu for an item whose cut point is at turn `position`:
   * the LAST recorded menu activated at/before the position. Recorded wins;
   * tools the item demonstrably involves (calls in its input prefix plus its
   * own expected calls, `extraCallNames`) that the recorded menu lacks are
   * merged in from the inferred definitions — the model called them, so the
   * recorded menu must have been incomplete. Without any recorded menu the
   * inferred menu is used, as before.
   */
  const menuFor = (
    position: number,
    extraCallNames: string[] = [],
  ): NonNullable<SnapshotDatasetItem['tools']> | undefined => {
    let recorded: (typeof menuChanges)[number] | undefined;
    for (const change of menuChanges) {
      if (change.at <= position) recorded = change;
      else break;
    }
    if (!recorded) return sessionTools.length > 0 ? sessionTools : undefined;

    const recordedNames = new Set(recorded.tools.map((tool) => tool.name));
    const involvedNames = new Set([
      ...callInfos.filter((call) => call.index < position).map((call) => call.name),
      ...extraCallNames,
    ]);
    const missing = sessionTools.filter(
      (tool) => !recordedNames.has(tool.name) && involvedNames.has(tool.name),
    );
    return [...recorded.tools, ...missing];
  };

  // Tool actions: each run of CONSECUTIVE call turns is ONE action (parallel
  // calls issued together). Input = everything before the run's first call.
  const toolActions: Array<{ start: number; calls: typeof callInfos }> = [];
  for (const call of callInfos) {
    const current = toolActions[toolActions.length - 1];
    if (current && call.index === current.start + current.calls.length) {
      current.calls.push(call);
    } else {
      toolActions.push({ start: call.index, calls: [call] });
    }
  }

  const tags = ['snapshot', 'tracing', ...(session.agentName ? [`agent:${session.agentName}`] : [])];

  // Selection: final-answer item always; then the LAST up-to-3 tool actions.
  // Actions whose input would be empty (nothing before them) are skipped.
  const selectedActions = toolActions.filter((action) => action.start > 0).slice(-(MAX_ITEMS_PER_SESSION - 1));

  type PendingItem = { position: number; item: SnapshotDatasetItem };
  const pending: PendingItem[] = [];

  selectedActions.forEach((action, i) => {
    const actionTools = menuFor(action.start, action.calls.map((call) => call.name));
    pending.push({
      position: action.start,
      item: {
        id: `tr-${session.sessionId}#${i + 1}`,
        input: converted.slice(0, action.start),
        expected: {
          toolCalls: action.calls.map((call) => ({
            name: call.name,
            argsMatch: 'subset',
            ...(call.parsedArgs ? { args: call.parsedArgs } : {}),
          })),
        },
        ...(actionTools ? { tools: actionTools } : {}),
        tags,
      },
    });
  });

  // Final-answer item — exactly the previous single-item shape (plus tools):
  // input = everything before the last assistant message, reference = its
  // text. Sessions with messages but no assistant answer keep the whole
  // conversation as input with no expected, as before.
  const finalInput = lastAssistant >= 0 ? converted.slice(0, lastAssistant) : converted;
  if (finalInput.length > 0) {
    const reference = lastAssistant >= 0 ? turns[lastAssistant] : undefined;
    const finalPosition = lastAssistant >= 0 ? lastAssistant : turns.length;
    const finalTools = menuFor(finalPosition);
    pending.push({
      position: finalPosition,
      item: {
        id: `tr-${session.sessionId}`,
        input: finalInput,
        ...(reference?.kind === 'msg'
          ? { expected: { reference: converted[lastAssistant].content } }
          : {}),
        ...(finalTools ? { tools: finalTools } : {}),
        tags,
      },
    });
  }

  if (pending.length === 0) return { kind: 'skip', shape: 'none' };
  pending.sort((a, b) => a.position - b.position);
  return {
    kind: 'items',
    items: pending.map((entry) => entry.item),
    findings: counter.findings,
    shape: 'message-sections',
  };
}

// ── Row enumeration ────────────────────────────────────────────────────────

type Db = Awaited<ReturnType<typeof getDatabase>>;

function matchesGatewayStatus(row: IModelUsageLog, status: SnapshotFilters['status']): boolean {
  return !status || row.status === status;
}

function matchesTracingStatus(session: IAgentTracingSession, status: SnapshotFilters['status']): boolean {
  if (!status) return true;
  const isError = TRACING_ERROR_STATUSES.has((session.status ?? '').toLowerCase());
  return status === 'error' ? isError : !isError;
}

/**
 * Enumerate gateway rows newest-first, bounded by the scan cap. When no
 * modelKey filter is given, every Model Hub model's log stream is walked
 * (listModelUsageLogs is keyed by model).
 */
async function scanGatewayRows(
  db: Db,
  ctx: SnapshotContext,
  filters: SnapshotFilters,
  onRow: (row: IModelUsageLog) => boolean | void,
): Promise<{ scanned: number; scanCapped: boolean }> {
  const modelKeys = filters.modelKey
    ? [filters.modelKey]
    : (await db.listModels({ projectId: ctx.projectId })).map((model) => model.key);

  let scanned = 0;
  for (const modelKey of modelKeys) {
    let skip = 0;
    for (;;) {
      if (scanned >= SNAPSHOT_SCAN_CAP) return { scanned, scanCapped: true };
      const page = await db.listModelUsageLogs(
        modelKey,
        { limit: PAGE_SIZE, skip, from: filters.from, to: filters.to },
        ctx.projectId,
      );
      for (const row of page) {
        scanned += 1;
        if (onRow(row) === false) return { scanned, scanCapped: false };
        if (scanned >= SNAPSHOT_SCAN_CAP) return { scanned, scanCapped: true };
      }
      if (page.length < PAGE_SIZE) break;
      skip += page.length;
    }
  }
  return { scanned, scanCapped: false };
}

/** Enumerate tracing sessions newest-first, bounded by the scan cap. */
async function scanTracingSessions(
  db: Db,
  ctx: SnapshotContext,
  filters: SnapshotFilters,
  onSession: (session: IAgentTracingSession) => boolean | void | Promise<boolean | void>,
): Promise<{ scanned: number; scanCapped: boolean }> {
  let scanned = 0;
  let skip = 0;
  for (;;) {
    if (scanned >= SNAPSHOT_SCAN_CAP) return { scanned, scanCapped: true };
    const { sessions } = await db.listAgentTracingSessions(
      {
        ...(filters.agentName ? { agentNameExact: filters.agentName } : {}),
        ...(filters.from ? { from: filters.from.toISOString() } : {}),
        ...(filters.to ? { to: filters.to.toISOString() } : {}),
        limit: PAGE_SIZE,
        skip,
        includeTotal: false,
      },
      ctx.projectId,
    );
    for (const session of sessions) {
      scanned += 1;
      if ((await onSession(session)) === false) return { scanned, scanCapped: false };
      if (scanned >= SNAPSHOT_SCAN_CAP) return { scanned, scanCapped: true };
    }
    if (sessions.length < PAGE_SIZE) break;
    skip += sessions.length;
  }
  return { scanned, scanCapped: false };
}

// ── Filter options ─────────────────────────────────────────────────────────

export interface SnapshotFilterOptions {
  /** Distinct tracing agent names observed in the usage rollup. */
  agents: string[];
  /** Distinct gateway-served model keys (rollup rows with source 'api'). */
  gatewayModels: string[];
}

/** Lookback for filter options when the caller gives no explicit window. */
const FILTER_OPTIONS_WINDOW_DAYS = 90;
const FILTER_OPTIONS_ROW_LIMIT = 20_000;

/** Pure: derive wizard dropdown options from models-service rollup rows. */
export function deriveSnapshotFilterOptions(
  rows: Array<Pick<IUsageDaily, 'agentKey' | 'refKey' | 'source'>>,
): SnapshotFilterOptions {
  const agents = new Set<string>();
  const gatewayModels = new Set<string>();
  for (const row of rows) {
    if (row.agentKey) agents.add(row.agentKey);
    // Gateway log streams are keyed by hub model key — only 'api'-source rows
    // name models the gateway scan can actually filter on.
    if (row.source === 'api' && row.refKey) gatewayModels.add(row.refKey);
  }
  const sorted = (values: Set<string>) => [...values].sort((a, b) => a.localeCompare(b));
  return { agents: sorted(agents), gatewayModels: sorted(gatewayModels) };
}

/**
 * Dropdown options for the snapshot wizard, fed from observability (the
 * cross-service usage rollup) instead of static catalogs: agents = every
 * tracing agentKey seen in the window, models = every gateway-served model
 * key. Empty lists mean the corresponding traffic simply does not exist.
 */
export async function listSnapshotFilterOptions(
  ctx: SnapshotContext,
  window: { from?: Date; to?: Date } = {},
): Promise<SnapshotFilterOptions> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);
  const from = window.from ?? new Date(Date.now() - FILTER_OPTIONS_WINDOW_DAYS * 86_400_000);
  const rows = await db.listUsageDaily({
    projectId: ctx.projectId,
    service: 'models',
    fromDay: toUtcDay(from),
    ...(window.to ? { toDay: toUtcDay(window.to) } : {}),
    limit: FILTER_OPTIONS_ROW_LIMIT,
  });
  return deriveSnapshotFilterOptions(rows);
}

// ── Preview ────────────────────────────────────────────────────────────────

/**
 * Count what a snapshot with these parameters would select. Never returns
 * payload content — counts and per-model/agent breakdown only.
 *
 * NOTE: `wouldCreate` counts ROWS/SESSIONS (it never loads tracing events, by
 * design). For the tracing source the create call emits up to
 * MAX_ITEMS_PER_SESSION items per session, so actual `created` may exceed
 * this estimate (still bounded by `limit`). See SnapshotPreview.wouldCreate.
 */
export async function previewSnapshot(ctx: SnapshotContext, params: SnapshotParams): Promise<SnapshotPreview> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const filters = params.filters ?? {};
  const samplePct = normalizeSamplePct(filters.samplePct);
  const limit = normalizeLimit(filters.limit);

  let matching = 0;
  let sampled = 0;
  const breakdown = new Map<string, SnapshotBreakdownEntry>();

  const record = (key: string, stableId: string) => {
    matching += 1;
    let entry = breakdown.get(key);
    if (!entry) {
      entry = { key, matching: 0, sampled: 0 };
      breakdown.set(key, entry);
    }
    entry.matching += 1;
    if (isSampled(stableId, samplePct)) {
      sampled += 1;
      entry.sampled += 1;
    }
  };

  let scan: { scanned: number; scanCapped: boolean };
  if (params.source === 'gateway') {
    scan = await scanGatewayRows(db, ctx, filters, (row) => {
      if (matchesGatewayStatus(row, filters.status)) record(row.modelKey, row.requestId);
    });
  } else {
    scan = await scanTracingSessions(db, ctx, filters, (session) => {
      if (matchesTracingStatus(session, filters.status)) record(session.agentName ?? '', session.sessionId);
    });
  }

  return {
    source: params.source,
    matching,
    sampled,
    wouldCreate: Math.min(sampled, limit),
    scanned: scan.scanned,
    scanCapped: scan.scanCapped,
    samplePct,
    limit,
    breakdown: [...breakdown.values()].sort((a, b) => b.matching - a.matching),
  };
}

// ── Create ─────────────────────────────────────────────────────────────────

/** Output of the scan/map stage — everything needed to persist a snapshot. */
export interface SnapshotBuildOutput {
  items: SnapshotDatasetItem[];
  /** Provenance metadata for `metadata.snapshot` (never contains the salt). */
  snapshotMeta: Record<string, unknown>;
  summary: Omit<CreateSnapshotResult, 'dataset'>;
}

/**
 * Scan, sample, map and anonymize — the heavy stage shared by the synchronous
 * path (`createSnapshotDataset`) and the background job (`snapshotJob.ts`).
 * Refuses to run without valid anonymization options.
 */
export async function buildSnapshotDataset(
  ctx: SnapshotContext,
  params: CreateSnapshotParams,
): Promise<SnapshotBuildOutput> {
  assertAnonymizeOptions(params.anonymize);
  if (typeof params.name !== 'string' || !params.name.trim()) {
    throw new Error('`name` is required');
  }

  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const filters = params.filters ?? {};
  const samplePct = normalizeSamplePct(filters.samplePct);
  const limit = normalizeLimit(filters.limit);

  const items: SnapshotDatasetItem[] = [];
  const skipped: SnapshotSkipCounts = { truncatedPayload: 0, missingMessages: 0, unmappable: 0, sizeCapped: 0 };
  let matching = 0;
  let sampled = 0;
  let piiFindings = 0;
  let messageSectionSessions = 0;
  let noContentSessions = 0;
  // Datasets persist as ONE document — stay far below Mongo's 16MB cap.
  let payloadBytes = 0;
  const pushWithinBudget = (item: SnapshotDatasetItem): boolean => {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (payloadBytes + itemBytes > SNAPSHOT_PAYLOAD_BUDGET_BYTES) {
      skipped.sizeCapped += 1;
      return false;
    }
    payloadBytes += itemBytes;
    items.push(item);
    return true;
  };

  if (params.source === 'gateway') {
    await scanGatewayRows(db, ctx, filters, (row) => {
      if (!matchesGatewayStatus(row, filters.status)) return;
      matching += 1;
      if (!isSampled(row.requestId, samplePct)) return;
      sampled += 1;
      const outcome = mapGatewayRow(row, params.anonymize);
      if (outcome.kind === 'skip') {
        skipped[outcome.reason] += 1;
        return;
      }
      piiFindings += outcome.findings;
      if (!pushWithinBudget(outcome.item)) return false; // budget hit — stop
      if (items.length >= limit) return false; // stop scanning
    });
  } else {
    await scanTracingSessions(db, ctx, filters, async (session) => {
      if (!matchesTracingStatus(session, filters.status)) return;
      matching += 1;
      if (!isSampled(session.sessionId, samplePct)) return;
      sampled += 1;
      const events = await db.listAgentTracingEvents(session.sessionId, ctx.projectId);
      const outcome = mapTracingSession(session, events, params.anonymize);
      if (outcome.kind === 'skip') {
        skipped.unmappable += 1;
        noContentSessions += 1;
        return;
      }
      messageSectionSessions += 1;
      piiFindings += outcome.findings;
      // A session maps to MULTIPLE items (tool actions + final answer). On a
      // budget hit the session's remaining items are counted into sizeCapped
      // (pushWithinBudget already counted the failing one); on the item limit
      // the scan just stops, as for gateway rows.
      for (let i = 0; i < outcome.items.length; i++) {
        if (!pushWithinBudget(outcome.items[i])) {
          skipped.sizeCapped += outcome.items.length - i - 1;
          return false;
        }
        if (items.length >= limit) return false;
      }
    });
  }

  // Provenance — everything needed to understand/reproduce the snapshot,
  // except the salt (deliberately unrecoverable).
  const metadata = {
    snapshot: {
      source: params.source,
      filters: {
        from: filters.from?.toISOString(),
        to: filters.to?.toISOString(),
        modelKey: filters.modelKey,
        agentName: filters.agentName,
        status: filters.status,
      },
      samplePct,
      limit,
      counts: {
        matching,
        sampled,
        created: items.length,
        skipped,
        // Tracing sessions emit multiple items (`sampled` counts SESSIONS,
        // `created` counts ITEMS) — record the ratio so the discrepancy with
        // the preview's per-session `wouldCreate` estimate is explicit.
        ...(params.source === 'tracing'
          ? {
              itemsPerSession:
                messageSectionSessions > 0
                  ? Math.round((items.length / messageSectionSessions) * 100) / 100
                  : 0,
            }
          : {}),
      },
      anonymization: {
        strategy: params.anonymize.strategy,
        categories: params.anonymize.categories,
        customPatternCount: params.anonymize.customPatterns?.length ?? 0,
      },
      piiFindings,
      createdAt: new Date().toISOString(),
    },
  };

  const mappableDenominator = messageSectionSessions + noContentSessions;
  return {
    items,
    snapshotMeta: metadata.snapshot,
    summary: {
      source: params.source,
      matching,
      sampled,
      created: items.length,
      skipped,
      piiFindings,
      ...(params.source === 'tracing'
        ? {
            tracingShapes: {
              messageSections: messageSectionSessions,
              noContent: noContentSessions,
              mappableFraction: mappableDenominator > 0 ? messageSectionSessions / mappableDenominator : 0,
            },
          }
        : {}),
    },
  };
}

/**
 * Build and persist a snapshot dataset in one call — the synchronous path,
 * for flows that need the result inline (e.g. EE parity orchestration). The
 * dashboard wizard goes through `enqueueSnapshotDataset` (snapshotJob.ts)
 * instead so the HTTP request never waits on the scan.
 */
export async function createSnapshotDataset(
  ctx: SnapshotContext,
  params: CreateSnapshotParams,
): Promise<CreateSnapshotResult> {
  const build = await buildSnapshotDataset(ctx, params);
  const dataset = await createDataset(ctx.tenantDbName, ctx.tenantId, ctx.userId ?? 'system', {
    name: params.name,
    description: params.description,
    source: 'generated',
    projectId: ctx.projectId,
    items: build.items,
    metadata: { snapshot: build.snapshotMeta },
  });
  return { dataset: { id: dataset.id, key: dataset.key, name: dataset.name }, ...build.summary };
}
