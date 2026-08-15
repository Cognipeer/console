/**
 * External Eval-Import service — parse LLM logs exported from other stacks
 * into evaluation dataset items, behind the mandatory anonymization gate.
 *
 * Formats (see `detectImportFormat`):
 *   - 'openai-chat-jsonl'       — JSONL, each line `{messages: [...]}` with
 *     optional `tools` (OpenAI fine-tune / Stored Completions export). A
 *     trailing assistant message becomes `expected.reference` /
 *     `expected.toolCalls` instead of input.
 *   - 'openai-pair-jsonl'       — JSONL, each line pairs a request-like object
 *     carrying `messages[]` with a response-like object carrying `choices[]`
 *     (accepted key pairs: request/response, input/output, body/completion;
 *     values may be objects, JSON strings, or one `body` level deeper).
 *   - 'bedrock-invocation-jsonl' — AWS Bedrock model-invocation logs: `modelId`
 *     plus `input.inputBodyJson` / `output.outputBodyJson` whose bodies are
 *     Anthropic-native (system + content blocks; `tool_use` blocks map to
 *     toolCalls). Bodies may be embedded objects or stringified JSON.
 *   - 'langfuse-generations'    — JSON array or JSONL of Langfuse generation
 *     observations (`type: 'GENERATION'` or model+input+output). `input` may
 *     be a messages[] array, `{messages}`, or a bare string (→ user message).
 *   - 'embedded-chat-json'      — fallback for gateway/APIM wrappers: each
 *     record is deep-walked (JSON-looking strings included) to the FIRST
 *     object carrying `messages[]` (request) and the first carrying
 *     `choices[]` (response), wherever nested.
 *
 * Mapping rules shared by all formats: non-string content parts are flattened
 * to their text; roles outside system/user/assistant are dropped; when no
 * recorded response supplies expectations, a trailing assistant message is
 * pulled out of the input as `expected.reference` (+ `expected.toolCalls`,
 * argsMatch 'subset').
 *
 * Privacy gate: EVERY string destined for a dataset item first goes through
 * the persisted-log scrubber (`redactLogPayload`) and then the PII
 * anonymization pipeline (`anonymizeText`) — the exact same gate as Traffic
 * Snapshots (`snapshotService`), including its `assertAnonymizeOptions`
 * validation, which is reused verbatim. Recorded provenance metadata never
 * includes the salt.
 *
 * Product rule: imported data is for evaluation ONLY. This module never
 * writes usage_daily / cost rows — measured costs come later from eval
 * replay. Persistence goes through the EXISTING evaluation dataset creation
 * path (`createDataset`, source 'imported') — no new collection.
 */

import { createHash } from 'node:crypto';
import type { IEvaluationDatasetItem } from '@/lib/database';
import { createDataset } from '@/lib/services/evaluation/service';
import type { EvalRole, ExpectedToolCall } from '@/lib/services/evaluation/types';
import { anonymizeText, type AnonymizeOptions } from '@/lib/services/pii/anonymize';
import { redactLogPayload } from '@/lib/services/logRedaction';
import { assertAnonymizeOptions } from '@/lib/services/snapshots/snapshotService';
import {
  IMPORT_FORMATS,
  type CreateImportedDatasetParams,
  type CreateImportedDatasetResult,
  type DatasetImportContext,
  type ImportFormat,
  type ImportSkipCounts,
  type ParseImportResult,
  type ParsedImportExpected,
  type ParsedImportItem,
} from './types';

/** Hard cap on raw import content size (checked as UTF-8 bytes). */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** Hard cap on dataset items one import may create; the rest counts 'overLimit'. */
export const MAX_IMPORT_ITEMS = 5000;
/** Records examined by format detection. */
const DETECT_SCAN_RECORDS = 50;
/** Depth bound for the embedded-chat deep walk. */
const MAX_WALK_DEPTH = 8;

/** Typed rejection for content above MAX_IMPORT_BYTES (HTTP layer → 413). */
export class ImportTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Import content is ${bytes} bytes — the limit is ${MAX_IMPORT_BYTES} bytes (10 MB)`);
    this.name = 'ImportTooLargeError';
  }
}

function assertImportSize(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_IMPORT_BYTES) throw new ImportTooLargeError(bytes);
}

/** Stable fingerprint of the raw import content (provenance metadata). */
export function computeContentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ── Generic JSON helpers ───────────────────────────────────────────────────

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Accept a record directly or as a JSON string (stringified log bodies). */
function parseMaybeJsonRecord(value: unknown): UnknownRecord | undefined {
  const record = asRecord(value);
  if (record) return record;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return undefined;
    try {
      return asRecord(JSON.parse(trimmed));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Flatten message content (string | parts[] carrying `.text`) to plain text. */
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
 * Deep-walk a record for the first nested object satisfying `predicate`.
 * JSON-looking strings ({…} / […]) are parsed and walked too — gateway/APIM
 * logs frequently persist request/response bodies as strings.
 */
function findFirstRecord(
  value: unknown,
  predicate: (record: UnknownRecord) => boolean,
  depth = 0,
): UnknownRecord | undefined {
  if (depth > MAX_WALK_DEPTH) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
    try {
      return findFirstRecord(JSON.parse(trimmed), predicate, depth + 1);
    } catch {
      return undefined;
    }
  }
  const record = asRecord(value);
  if (record) {
    if (predicate(record)) return record;
    for (const nested of Object.values(record)) {
      const found = findFirstRecord(nested, predicate, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findFirstRecord(nested, predicate, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

const hasMessages = (record: UnknownRecord): boolean =>
  Array.isArray(record.messages) && record.messages.length > 0;
const hasChoices = (record: UnknownRecord): boolean =>
  Array.isArray(record.choices) && record.choices.length > 0;

// ── Message / tool normalization ───────────────────────────────────────────

const EVAL_ROLES = new Set<string>(['system', 'user', 'assistant', 'tool']);

/** Recorded tool call with the source's call id kept for pairing on replay. */
type RawToolCall = ExpectedToolCall & { id?: string };

/** A message normalized out of the export, before the trailing-assistant split. */
interface RawMessage {
  role: EvalRole;
  text?: string;
  /** Assistant-only: recorded tool calls (already normalized, ids kept). */
  toolCalls?: RawToolCall[];
  /** Tool-only: id of the call this responds to. */
  toolCallId?: string;
  /** Tool-only: tool name when the source recorded it. */
  name?: string;
}

/** OpenAI `tool_calls` → RawToolCall[] (argsMatch 'subset', ids kept). */
function mapOpenAiToolCalls(value: unknown): RawToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: RawToolCall[] = [];
  for (const entry of value) {
    const call = asRecord(entry);
    const fn = asRecord(call?.function);
    if (!fn || typeof fn.name !== 'string') continue;
    let args: UnknownRecord | undefined;
    if (typeof fn.arguments === 'string') {
      try {
        args = asRecord(JSON.parse(fn.arguments));
      } catch {
        args = undefined; // unparseable arguments → name-only expectation
      }
    } else {
      args = asRecord(fn.arguments);
    }
    calls.push({
      ...(typeof call?.id === 'string' ? { id: call.id } : {}),
      name: fn.name,
      argsMatch: 'subset',
      ...(args ? { args } : {}),
    });
  }
  return calls;
}

/** Anthropic content blocks: `tool_use` → RawToolCall[] (argsMatch 'subset', ids kept). */
function mapToolUseBlocks(content: unknown): RawToolCall[] {
  if (!Array.isArray(content)) return [];
  const calls: RawToolCall[] = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
    const args = asRecord(block.input);
    calls.push({
      ...(typeof block.id === 'string' ? { id: block.id } : {}),
      name: block.name,
      argsMatch: 'subset',
      ...(args ? { args } : {}),
    });
  }
  return calls;
}

/**
 * Tool definitions: OpenAI `{type:'function', function:{…}}` and flat
 * `{name, description, parameters | input_schema}` (Anthropic/Bedrock).
 */
function mapToolDefinitions(value: unknown): ParsedImportItem['tools'] {
  if (!Array.isArray(value)) return undefined;
  const tools: NonNullable<ParsedImportItem['tools']> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const fn = asRecord(record.function);
    if (fn && typeof fn.name === 'string') {
      tools.push({
        name: fn.name,
        description: asString(fn.description),
        parameters: asRecord(fn.parameters),
      });
    } else if (typeof record.name === 'string') {
      tools.push({
        name: record.name,
        description: asString(record.description),
        parameters: asRecord(record.parameters) ?? asRecord(record.input_schema),
      });
    }
  }
  return tools.length > 0 ? tools : undefined;
}

/** OpenAI-style messages[] → RawMessage[] (full tool fidelity kept). */
function normalizeOpenAiMessages(messages: unknown[]): RawMessage[] {
  const out: RawMessage[] = [];
  for (const entry of messages) {
    const message = asRecord(entry);
    if (!message) continue;
    const role = typeof message.role === 'string' ? message.role : '';
    if (!EVAL_ROLES.has(role)) continue;
    const text = flattenContent(message.content);
    if (role === 'tool') {
      if (text === undefined) continue;
      out.push({
        role: 'tool',
        text,
        ...(typeof message.tool_call_id === 'string' ? { toolCallId: message.tool_call_id } : {}),
        ...(typeof message.name === 'string' ? { name: message.name } : {}),
      });
      continue;
    }
    const toolCalls = role === 'assistant' ? mapOpenAiToolCalls(message.tool_calls) : [];
    if (text === undefined && toolCalls.length === 0) continue;
    out.push({
      role: role as EvalRole,
      ...(text !== undefined ? { text } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }
  return out;
}

/** Anthropic body ({system?, messages}) → RawMessage[] (tool_use → toolCalls). */
function normalizeAnthropicBody(body: UnknownRecord): RawMessage[] {
  const out: RawMessage[] = [];
  const system = flattenContent(body.system);
  if (system !== undefined && system.length > 0) out.push({ role: 'system', text: system });
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const entry of messages) {
    const message = asRecord(entry);
    if (!message) continue;
    const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : undefined;
    if (!role) continue;

    // Anthropic tool results arrive as user-turn `tool_result` content blocks;
    // split them out as tool turns (keeping block order) for full fidelity.
    if (role === 'user' && Array.isArray(message.content)) {
      let textParts: string[] = [];
      const flushText = () => {
        if (textParts.length > 0) {
          out.push({ role: 'user', text: textParts.join('\n') });
          textParts = [];
        }
      };
      for (const blockEntry of message.content) {
        const block = asRecord(blockEntry);
        if (!block) continue;
        if (block.type === 'tool_result') {
          flushText();
          const resultText = flattenContent(block.content)
            ?? (block.content !== undefined ? JSON.stringify(block.content) : undefined);
          if (resultText === undefined) continue;
          out.push({
            role: 'tool',
            text: resultText,
            ...(typeof block.tool_use_id === 'string' ? { toolCallId: block.tool_use_id } : {}),
          });
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          textParts.push(block.text);
        }
      }
      flushText();
      continue;
    }

    const text = flattenContent(message.content);
    const toolCalls = role === 'assistant' ? mapToolUseBlocks(message.content) : [];
    if (text === undefined && toolCalls.length === 0) continue;
    out.push({
      role,
      ...(text !== undefined ? { text } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }
  return out;
}

/** OpenAI response `{choices:[{message}]}` → expectations, when present. */
function expectedFromChoices(response: UnknownRecord | undefined): ParsedImportExpected | undefined {
  const choice = asRecord(Array.isArray(response?.choices) ? response?.choices[0] : undefined);
  const assistant = asRecord(choice?.message);
  if (!assistant) return undefined;
  const expected: ParsedImportExpected = {};
  const text = flattenContent(assistant.content);
  if (text !== undefined && text.length > 0) expected.reference = text;
  const toolCalls = mapOpenAiToolCalls(assistant.tool_calls);
  // Expectation shape carries no call ids — strip them.
  if (toolCalls.length > 0) expected.toolCalls = toolCalls.map((call) => ({ name: call.name, argsMatch: call.argsMatch, ...(call.args ? { args: call.args } : {}) }));
  return expected.reference !== undefined || expected.toolCalls ? expected : undefined;
}

/** Anthropic output body ({content blocks}) → expectations, when present. */
function expectedFromAnthropicOutput(body: UnknownRecord): ParsedImportExpected | undefined {
  const expected: ParsedImportExpected = {};
  const text = flattenContent(body.content);
  if (text !== undefined && text.length > 0) expected.reference = text;
  const toolCalls = mapToolUseBlocks(body.content);
  // Expectation shape carries no call ids — strip them.
  if (toolCalls.length > 0) expected.toolCalls = toolCalls.map((call) => ({ name: call.name, argsMatch: call.argsMatch, ...(call.args ? { args: call.args } : {}) }));
  return expected.reference !== undefined || expected.toolCalls ? expected : undefined;
}

type MapOutcome =
  | { kind: 'item'; item: ParsedImportItem }
  | { kind: 'skip'; reason: 'missingMessages' | 'emptyInput' };

/**
 * Assemble one item from normalized messages. When no recorded response
 * supplied expectations, a trailing assistant message becomes the expected
 * reference / tool calls instead of input.
 */
function buildItem(
  raw: RawMessage[],
  extras: { tools?: ParsedImportItem['tools']; responseExpected?: ParsedImportExpected; sourceModel?: string },
): MapOutcome {
  let expected = extras.responseExpected;
  let inputRaw = raw;

  if (!expected) {
    const last = raw[raw.length - 1];
    if (last && last.role === 'assistant') {
      inputRaw = raw.slice(0, -1);
      const trailing: ParsedImportExpected = {};
      if (last.text !== undefined && last.text.length > 0) trailing.reference = last.text;
      if (last.toolCalls && last.toolCalls.length > 0) {
        // Expectation shape carries no call ids — strip them.
        trailing.toolCalls = last.toolCalls.map((call) => ({ name: call.name, argsMatch: call.argsMatch, ...(call.args ? { args: call.args } : {}) }));
      }
      if (trailing.reference !== undefined || trailing.toolCalls) expected = trailing;
    }
  }

  // Full tool fidelity: history assistant tool calls and tool turns stay in
  // the conversation — replay is not faithful without them.
  const input: ParsedImportItem['input'] = [];
  for (const message of inputRaw) {
    if (message.role === 'tool') {
      input.push({
        role: 'tool',
        content: message.text ?? '',
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.name ? { name: message.name } : {}),
      });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      input.push({
        role: 'assistant',
        content: message.text ?? '',
        toolCalls: message.toolCalls.map((call) => ({
          ...(call.id ? { id: call.id } : {}),
          name: call.name,
          args: call.args ?? {},
        })),
      });
      continue;
    }
    if (message.text === undefined) continue;
    input.push({ role: message.role, content: message.text });
  }
  if (input.length === 0) return { kind: 'skip', reason: 'emptyInput' };

  return {
    kind: 'item',
    item: {
      input,
      ...(extras.tools ? { tools: extras.tools } : {}),
      ...(expected ? { expected } : {}),
      ...(extras.sourceModel ? { sourceModel: extras.sourceModel } : {}),
    },
  };
}

// ── Per-format record shapes ───────────────────────────────────────────────

/** Key pairs accepted for the request/response halves of a pair record. */
const PAIR_REQUEST_KEYS = ['request', 'input', 'body'] as const;
const PAIR_RESPONSE_KEYS = ['response', 'output', 'completion'] as const;

/** Unwrap a request-like value: itself, a JSON string, or one `body` deeper. */
function unwrapRequestLike(value: unknown): UnknownRecord | undefined {
  const record = parseMaybeJsonRecord(value);
  if (!record) return undefined;
  if (hasMessages(record)) return record;
  const body = parseMaybeJsonRecord(record.body);
  return body && hasMessages(body) ? body : undefined;
}

/** Unwrap a response-like value: itself, a JSON string, or one `body` deeper. */
function unwrapResponseLike(value: unknown): UnknownRecord | undefined {
  const record = parseMaybeJsonRecord(value);
  if (!record) return undefined;
  if (hasChoices(record)) return record;
  const body = parseMaybeJsonRecord(record.body);
  return body && hasChoices(body) ? body : undefined;
}

function pairRequest(record: UnknownRecord): UnknownRecord | undefined {
  for (const key of PAIR_REQUEST_KEYS) {
    const request = unwrapRequestLike(record[key]);
    if (request) return request;
  }
  return undefined;
}

function pairResponse(record: UnknownRecord): UnknownRecord | undefined {
  for (const key of PAIR_RESPONSE_KEYS) {
    const response = unwrapResponseLike(record[key]);
    if (response) return response;
  }
  return undefined;
}

/** Bedrock invocation-log body: `input.inputBodyJson` (object or JSON string). */
function bedrockBody(record: UnknownRecord, wrapKey: 'input' | 'output', bodyKey: string): UnknownRecord | undefined {
  const wrapper = asRecord(record[wrapKey]);
  return parseMaybeJsonRecord(wrapper?.[bodyKey]) ?? parseMaybeJsonRecord(record[bodyKey]);
}

function isBedrockRecord(record: UnknownRecord): boolean {
  if (typeof record.modelId !== 'string') return false;
  return bedrockBody(record, 'input', 'inputBodyJson') !== undefined
    || bedrockBody(record, 'output', 'outputBodyJson') !== undefined;
}

function isLangfuseRecord(record: UnknownRecord): boolean {
  if (typeof record.type === 'string' && record.type.toUpperCase() === 'GENERATION') return true;
  return typeof record.model === 'string' && 'input' in record && 'output' in record;
}

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Classify one record, most-specific format first (a pair record also carries
 * nested messages, so the embedded fallback must be checked last).
 */
function classifyRecord(record: UnknownRecord): ImportFormat | undefined {
  if (pairRequest(record) && pairResponse(record)) return 'openai-pair-jsonl';
  if (Array.isArray(record.messages) && record.messages.length > 0) return 'openai-chat-jsonl';
  if (isBedrockRecord(record)) return 'bedrock-invocation-jsonl';
  if (isLangfuseRecord(record)) return 'langfuse-generations';
  if (findFirstRecord(record, hasMessages)) return 'embedded-chat-json';
  return undefined;
}

/** First DETECT_SCAN_RECORDS records: JSON array elements, JSONL lines, or one object. */
function collectDetectionRecords(content: string): UnknownRecord[] {
  const trimmed = content.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .slice(0, DETECT_SCAN_RECORDS)
          .map(asRecord)
          .filter((record): record is UnknownRecord => record !== undefined);
      }
    } catch {
      // fall through to the line scan
    }
  }

  const records: UnknownRecord[] = [];
  const lines = content.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  for (const line of lines.slice(0, DETECT_SCAN_RECORDS)) {
    try {
      const record = asRecord(JSON.parse(line));
      if (record) records.push(record);
    } catch {
      // unparseable line — detection ignores, parsing counts
    }
  }
  if (records.length === 0 && trimmed.startsWith('{')) {
    // Pretty-printed single object spanning multiple lines.
    try {
      const record = asRecord(JSON.parse(trimmed));
      if (record) records.push(record);
    } catch {
      // not JSON at all
    }
  }
  return records;
}

/**
 * Detect the export format by classifying up to the first ~50 records.
 * Returns the format iff every classifiable record agrees; mixed or
 * unrecognizable content → undefined (the caller may still force a format).
 */
export function detectImportFormat(content: string): ImportFormat | undefined {
  assertImportSize(content);
  const votes = new Set<ImportFormat>();
  for (const record of collectDetectionRecords(content)) {
    const format = classifyRecord(record);
    if (format) votes.add(format);
  }
  return votes.size === 1 ? [...votes][0] : undefined;
}

// ── Per-format mapping ─────────────────────────────────────────────────────

function mapOpenAiChatRecord(record: UnknownRecord): MapOutcome {
  const messages = Array.isArray(record.messages) ? record.messages : undefined;
  if (!messages || messages.length === 0) return { kind: 'skip', reason: 'missingMessages' };
  return buildItem(normalizeOpenAiMessages(messages), {
    tools: mapToolDefinitions(record.tools),
    sourceModel: asString(record.model),
  });
}

function mapOpenAiPairRecord(record: UnknownRecord): MapOutcome {
  const request = pairRequest(record);
  if (!request) return { kind: 'skip', reason: 'missingMessages' };
  const response = pairResponse(record);
  return buildItem(normalizeOpenAiMessages(request.messages as unknown[]), {
    tools: mapToolDefinitions(request.tools),
    responseExpected: expectedFromChoices(response),
    sourceModel: asString(request.model) ?? asString(record.model) ?? asString(record.modelId),
  });
}

function mapBedrockRecord(record: UnknownRecord): MapOutcome {
  const inputBody = bedrockBody(record, 'input', 'inputBodyJson');
  if (!inputBody || !Array.isArray(inputBody.messages) || inputBody.messages.length === 0) {
    return { kind: 'skip', reason: 'missingMessages' };
  }
  const outputBody = bedrockBody(record, 'output', 'outputBodyJson');
  return buildItem(normalizeAnthropicBody(inputBody), {
    tools: mapToolDefinitions(inputBody.tools),
    responseExpected: outputBody ? expectedFromAnthropicOutput(outputBody) : undefined,
    sourceModel: asString(record.modelId),
  });
}

/** Langfuse `input`: messages[], `{messages}`, or a bare string → user turn. */
function langfuseInputMessages(input: unknown): RawMessage[] | undefined {
  if (typeof input === 'string') {
    return input.length > 0 ? [{ role: 'user', text: input }] : undefined;
  }
  if (Array.isArray(input)) return normalizeOpenAiMessages(input);
  const record = asRecord(input);
  if (record && Array.isArray(record.messages)) return normalizeOpenAiMessages(record.messages);
  return undefined;
}

/** Langfuse `output`: string, assistant-message record, or array (last wins). */
function langfuseOutputExpected(output: unknown): ParsedImportExpected | undefined {
  if (typeof output === 'string') {
    return output.length > 0 ? { reference: output } : undefined;
  }
  if (Array.isArray(output)) {
    for (let i = output.length - 1; i >= 0; i--) {
      const candidate = langfuseOutputExpected(output[i]);
      if (candidate) return candidate;
    }
    return undefined;
  }
  const record = asRecord(output);
  if (!record) return undefined;
  const expected: ParsedImportExpected = {};
  const text = flattenContent(record.content) ?? asString(record.completion);
  if (text !== undefined && text.length > 0) expected.reference = text;
  const toolCalls = mapOpenAiToolCalls(record.tool_calls);
  if (toolCalls.length > 0) expected.toolCalls = toolCalls;
  return expected.reference !== undefined || expected.toolCalls ? expected : undefined;
}

function mapLangfuseRecord(record: UnknownRecord): MapOutcome {
  const raw = langfuseInputMessages(record.input);
  if (!raw) return { kind: 'skip', reason: 'missingMessages' };
  return buildItem(raw, {
    responseExpected: langfuseOutputExpected(record.output),
    sourceModel: asString(record.model),
  });
}

function mapEmbeddedChatRecord(record: UnknownRecord): MapOutcome {
  const request = findFirstRecord(record, hasMessages);
  if (!request) return { kind: 'skip', reason: 'missingMessages' };
  const response = findFirstRecord(record, hasChoices);
  return buildItem(normalizeOpenAiMessages(request.messages as unknown[]), {
    tools: mapToolDefinitions(request.tools),
    responseExpected: expectedFromChoices(response),
    sourceModel: asString(request.model) ?? (response ? asString(response.model) : undefined),
  });
}

const RECORD_MAPPERS: Record<ImportFormat, (record: UnknownRecord) => MapOutcome> = {
  'openai-chat-jsonl': mapOpenAiChatRecord,
  'openai-pair-jsonl': mapOpenAiPairRecord,
  'bedrock-invocation-jsonl': mapBedrockRecord,
  'langfuse-generations': mapLangfuseRecord,
  'embedded-chat-json': mapEmbeddedChatRecord,
};

/** Formats that may arrive as one JSON document instead of JSONL. */
const WHOLE_JSON_FORMATS = new Set<ImportFormat>(['langfuse-generations', 'embedded-chat-json']);

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse the export into dataset-item candidates (RAW — not anonymized).
 * JSONL formats are processed line by line (the whole file is never
 * JSON.parsed); array-capable formats also accept a JSON array or a single
 * pretty-printed object. Stops at MAX_IMPORT_ITEMS, counting the remainder
 * as 'overLimit'; content above MAX_IMPORT_BYTES throws ImportTooLargeError.
 */
export function parseImportItems(content: string, format: ImportFormat): ParseImportResult {
  assertImportSize(content);
  const mapRecord = RECORD_MAPPERS[format];
  const items: ParsedImportItem[] = [];
  const skipped: ImportSkipCounts = {};
  const bump = (reason: string, by = 1) => {
    if (by > 0) skipped[reason] = (skipped[reason] ?? 0) + by;
  };

  const consumeRecord = (record: UnknownRecord | undefined) => {
    if (!record) {
      bump('unparseable');
      return;
    }
    const outcome = mapRecord(record);
    if (outcome.kind === 'skip') bump(outcome.reason);
    else items.push(outcome.item);
  };

  const trimmed = content.trim();

  // Whole-JSON forms (Langfuse array export / single wrapped object).
  if (WHOLE_JSON_FORMATS.has(format) && trimmed.startsWith('[')) {
    let elements: unknown[];
    try {
      const parsed = JSON.parse(trimmed);
      elements = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      bump('unparseable');
      return { items, skipped };
    }
    for (let i = 0; i < elements.length; i++) {
      if (items.length >= MAX_IMPORT_ITEMS) {
        bump('overLimit', elements.length - i);
        break;
      }
      consumeRecord(asRecord(elements[i]));
    }
    return { items, skipped };
  }

  const lines = content.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

  // Pretty-printed single JSON object (multi-line, first line not parseable).
  if (WHOLE_JSON_FORMATS.has(format) && trimmed.startsWith('{') && lines.length > 1) {
    let firstLineParses = true;
    try {
      JSON.parse(lines[0]);
    } catch {
      firstLineParses = false;
    }
    if (!firstLineParses) {
      try {
        consumeRecord(asRecord(JSON.parse(trimmed)));
        return { items, skipped };
      } catch {
        // not one JSON document either — fall through to per-line counting
      }
    }
  }

  // Line-by-line JSONL.
  for (let i = 0; i < lines.length; i++) {
    if (items.length >= MAX_IMPORT_ITEMS) {
      bump('overLimit', lines.length - i);
      break;
    }
    let record: UnknownRecord | undefined;
    try {
      record = asRecord(JSON.parse(lines[i]));
    } catch {
      bump('unparseable');
      continue;
    }
    consumeRecord(record);
  }
  return { items, skipped };
}

// ── Create ─────────────────────────────────────────────────────────────────

/** Scrub (log-redaction) then anonymize a single string — the snapshot gate. */
function cleanText(text: string, opts: AnonymizeOptions, counter: { findings: number }): string {
  const scrubbed = redactLogPayload(text);
  const result = anonymizeText(scrubbed, opts);
  counter.findings += result.findings;
  return result.text;
}

/** Anonymize a structured args record via its canonical JSON text. */
function cleanArgsRecord(
  args: Record<string, unknown>,
  opts: AnonymizeOptions,
  counter: { findings: number },
): Record<string, unknown> {
  const cleaned = cleanText(JSON.stringify(args), opts, counter);
  try {
    const parsed = JSON.parse(cleaned);
    return asRecord(parsed) ?? { _raw: cleaned };
  } catch {
    return { _raw: cleaned }; // keep the anonymized text when re-parsing fails
  }
}

/** Anonymize structured tool-call args via their canonical JSON text. */
function cleanToolCalls(
  toolCalls: ExpectedToolCall[],
  opts: AnonymizeOptions,
  counter: { findings: number },
): Array<Record<string, unknown>> {
  return toolCalls.map((call) => ({
    name: call.name,
    argsMatch: 'subset',
    ...(call.args !== undefined ? { args: cleanArgsRecord(call.args, opts, counter) } : {}),
  }));
}

/** Persisted item shape: DB item + the coordinated tool-definition field. */
type ImportedDatasetItem = IEvaluationDatasetItem;

function toDatasetItem(
  parsed: ParsedImportItem,
  index: number,
  format: ImportFormat,
  opts: AnonymizeOptions,
  counter: { findings: number },
): ImportedDatasetItem {
  const input = parsed.input.map((message) => ({
    role: message.role,
    content: cleanText(message.content, opts, counter),
    ...(message.toolCalls && message.toolCalls.length > 0
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            args: cleanArgsRecord(call.args ?? {}, opts, counter),
          })),
        }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
  }));

  const expected: Record<string, unknown> = {};
  if (parsed.expected?.reference !== undefined) {
    expected.reference = cleanText(parsed.expected.reference, opts, counter);
  }
  if (parsed.expected?.toolCalls && parsed.expected.toolCalls.length > 0) {
    expected.toolCalls = cleanToolCalls(parsed.expected.toolCalls, opts, counter);
  }

  const tools = parsed.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description !== undefined ? cleanText(tool.description, opts, counter) : undefined,
    parameters: tool.parameters,
  }));

  const sourceModel = parsed.sourceModel !== undefined
    ? cleanText(parsed.sourceModel, opts, counter)
    : undefined;

  return {
    id: `imp-${index + 1}`,
    input,
    ...(Object.keys(expected).length > 0 ? { expected } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    tags: ['imported', `format:${format}`, ...(sourceModel ? [`model:${sourceModel}`] : [])],
  };
}

/**
 * Parse + anonymize + persist an import as an evaluation dataset (source
 * 'imported'). Refuses to run without valid anonymization options (the exact
 * snapshot gate); provenance metadata records everything about the import
 * EXCEPT the salt. Never writes usage_daily / cost rows.
 */
export async function createImportedDataset(
  ctx: DatasetImportContext,
  params: CreateImportedDatasetParams,
): Promise<CreateImportedDatasetResult> {
  assertAnonymizeOptions(params.anonymize);
  if (typeof params.name !== 'string' || !params.name.trim()) {
    throw new Error('`name` is required');
  }
  if (!IMPORT_FORMATS.includes(params.format)) {
    throw new Error(`\`format\` must be one of: ${IMPORT_FORMATS.join(', ')}`);
  }
  if (typeof params.content !== 'string' || params.content.trim().length === 0) {
    throw new Error('`content` is required');
  }

  const { items: parsed, skipped } = parseImportItems(params.content, params.format);
  const counter = { findings: 0 };
  const items = parsed.map((item, index) => toDatasetItem(item, index, params.format, params.anonymize, counter));

  // Provenance — everything needed to understand the import, except the salt
  // (deliberately unrecoverable). contentSha256 fingerprints the raw source
  // without revealing it.
  const metadata = {
    importFormat: params.format,
    ...(params.sourceLabel ? { sourceLabel: params.sourceLabel } : {}),
    contentSha256: computeContentSha256(params.content),
    counts: { parsed: parsed.length, created: items.length, skipped },
    anonymization: {
      strategy: params.anonymize.strategy,
      categories: params.anonymize.categories,
      customPatternCount: params.anonymize.customPatterns?.length ?? 0,
    },
    piiFindings: counter.findings,
    createdAt: new Date().toISOString(),
  };

  const dataset = await createDataset(ctx.tenantDbName, ctx.tenantId, ctx.userId ?? 'system', {
    name: params.name.trim(),
    source: 'imported',
    projectId: ctx.projectId,
    items,
    metadata,
  });

  return {
    datasetId: String(dataset.id),
    datasetKey: dataset.key,
    name: dataset.name,
    created: items.length,
    skipped,
    piiFindings: counter.findings,
  };
}
