/**
 * Pure helpers for the dataset-item editor (DatasetItemEditor.tsx) and the
 * manual dataset-creation flow: draft ↔ item conversion, JSON-field validity,
 * tool-name inference, id suggestion, and item summaries. No React / DOM —
 * everything here is unit-testable in a plain node environment.
 *
 * The "draft" shape mirrors the editor UI: every JSON-bearing field is kept
 * as raw text (so the user can type freely, with a live validity indicator)
 * and only parsed when the draft is serialized back into a dataset item.
 */

import type {
  EvalArgsMatchMode,
  EvalDatasetItemView,
  EvalExpectedToolCallView,
  EvalJsonPathAssertionView,
  EvalMessageView,
  EvalToolDefinitionView,
} from './types';

export type EvalRoleView = EvalMessageView['role'];

export const EVAL_ROLES: EvalRoleView[] = ['system', 'user', 'assistant', 'tool'];
export const ARGS_MATCH_MODES: EvalArgsMatchMode[] = ['exact', 'subset', 'schema', 'ignore'];

/* ── Draft shapes ─────────────────────────────────────────────────── */

export interface ToolCallDraft {
  /** Provider call id (optional). */
  id: string;
  name: string;
  /** JSON object text ('' → {}). */
  argsText: string;
}

export interface TurnDraft {
  role: EvalRoleView;
  content: string;
  /** Assistant turns only. */
  toolCalls: ToolCallDraft[];
  /** Tool turns only. */
  toolCallId: string;
  /** Tool turns only. */
  name: string;
  /** Message keys the editor doesn't model (e.g. attachments) — preserved
   *  verbatim through an edit round-trip instead of being dropped. */
  extra: Record<string, unknown>;
}

export interface ToolDraft {
  name: string;
  description: string;
  /** JSON-schema object text ('' → omitted). */
  parametersText: string;
}

export interface ExpectedToolCallDraft {
  name: string;
  argsMatch: EvalArgsMatchMode;
  /** JSON object text, used for exact/subset ('' → {}). */
  argsText: string;
  /** JSON object text, used for schema ('' → omitted). */
  argsSchemaText: string;
}

export interface JsonPathRuleDraft {
  path: string;
  exists: boolean;
  /** JSON value text; bare text is treated as a string ('' → no equals). */
  equalsText: string;
}

export interface ToolResultRowDraft {
  /** Canonical key, e.g. `search_flights({"city":"Paris"})`. */
  key: string;
  /** JSON value text (strict — strings must be quoted). */
  valueText: string;
}

export interface ItemDraft {
  id: string;
  tags: string[];
  turns: TurnDraft[];
  tools: ToolDraft[];
  reference: string;
  expectedToolCalls: ExpectedToolCallDraft[];
  mustContain: string[];
  mustNotContain: string[];
  equals: string;
  regex: string;
  /** JSON object text ('' → omitted). */
  jsonSchemaText: string;
  jsonPathRules: JsonPathRuleDraft[];
  toolResultRows: ToolResultRowDraft[];
  /** Unknown top-level item keys, preserved verbatim on save. */
  extraItem: Record<string, unknown>;
  /** Unknown `expected` keys, preserved verbatim on save. */
  extraExpected: Record<string, unknown>;
}

/* ── Empty factories ──────────────────────────────────────────────── */

export const emptyTurnDraft = (role: EvalRoleView = 'user'): TurnDraft => ({
  role,
  content: '',
  toolCalls: [],
  toolCallId: '',
  name: '',
  extra: {},
});

export const emptyToolCallDraft = (): ToolCallDraft => ({ id: '', name: '', argsText: '' });

export const emptyToolDraft = (name = ''): ToolDraft => ({ name, description: '', parametersText: '' });

export const emptyExpectedToolCallDraft = (): ExpectedToolCallDraft => ({
  name: '',
  argsMatch: 'subset',
  argsText: '',
  argsSchemaText: '',
});

export const emptyJsonPathRuleDraft = (): JsonPathRuleDraft => ({ path: '', exists: true, equalsText: '' });

export const emptyItemDraft = (id = ''): ItemDraft => ({
  id,
  tags: [],
  turns: [emptyTurnDraft('user')],
  tools: [],
  reference: '',
  expectedToolCalls: [],
  mustContain: [],
  mustNotContain: [],
  equals: '',
  regex: '',
  jsonSchemaText: '',
  jsonPathRules: [],
  toolResultRows: [],
  extraItem: {},
  extraExpected: {},
});

/* ── JSON helpers ─────────────────────────────────────────────────── */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Live-validity check for a JSON text field.
 * Returns null when `text` is blank or valid; otherwise a short error.
 */
export function jsonTextError(text: string, opts?: { requireObject?: boolean }): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return `Invalid JSON: ${(err as Error).message}`;
  }
  if (opts?.requireObject && !isPlainObject(parsed)) return 'Must be a JSON object';
  return null;
}

/** Parse a JSON object text field. '' → undefined. Throws on invalid input. */
function parseObjectText(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!isPlainObject(parsed)) throw new Error('Must be a JSON object');
  return parsed;
}

/**
 * Parse a JSON *value* leniently: valid JSON wins, otherwise the raw text is
 * treated as a plain string (so `Paris` works without quotes).
 */
export function parseJsonValueLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

const stringifyPretty = (value: unknown): string => JSON.stringify(value, null, 2);

/* ── Item ↔ draft conversion ──────────────────────────────────────── */

const KNOWN_ITEM_KEYS = new Set(['id', 'input', 'expected', 'tools', 'toolResults', 'tags']);
const KNOWN_MESSAGE_KEYS = new Set(['role', 'content', 'toolCalls', 'toolCallId', 'name']);
const KNOWN_EXPECTED_KEYS = new Set([
  'reference',
  'toolCalls',
  'mustContain',
  'mustNotContain',
  'equals',
  'regex',
  'jsonSchema',
  'jsonPath',
]);

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((v) => String(v)) : [];

/** Effective argsMatch for an expected tool call (mirrors the scorer default). */
export function resolveArgsMatch(call: EvalExpectedToolCallView): EvalArgsMatchMode {
  if (call.argsMatch) return call.argsMatch;
  if (call.args) return 'exact';
  if (call.argsSchema) return 'schema';
  return 'ignore';
}

/** Expand a dataset item into the editable draft shape. Lossless for known + unknown keys. */
export function itemToDraft(item: EvalDatasetItemView): ItemDraft {
  const expected = isPlainObject(item.expected) ? item.expected : {};

  const extraItem: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item as unknown as Record<string, unknown>)) {
    if (!KNOWN_ITEM_KEYS.has(k) && v !== undefined) extraItem[k] = v;
  }
  const extraExpected: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(expected)) {
    if (!KNOWN_EXPECTED_KEYS.has(k) && v !== undefined) extraExpected[k] = v;
  }

  const expectedToolCalls = Array.isArray(expected.toolCalls)
    ? (expected.toolCalls as EvalExpectedToolCallView[]).map((tc) => ({
        name: tc.name ?? '',
        argsMatch: resolveArgsMatch(tc),
        argsText: tc.args !== undefined ? stringifyPretty(tc.args) : '',
        argsSchemaText: tc.argsSchema !== undefined ? stringifyPretty(tc.argsSchema) : '',
      }))
    : [];

  const jsonPathRules = Array.isArray(expected.jsonPath)
    ? (expected.jsonPath as EvalJsonPathAssertionView[]).map((rule) => ({
        path: rule.path ?? '',
        exists: rule.exists !== false,
        equalsText: rule.equals !== undefined ? stringifyPretty(rule.equals) : '',
      }))
    : [];

  const toolResults = isPlainObject(item.toolResults) ? item.toolResults : {};

  return {
    id: item.id ?? '',
    tags: toStringArray(item.tags),
    turns: (Array.isArray(item.input) ? item.input : []).map((m) => {
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(m as unknown as Record<string, unknown>)) {
        if (!KNOWN_MESSAGE_KEYS.has(k) && v !== undefined) extra[k] = v;
      }
      return {
        role: (EVAL_ROLES as string[]).includes(m.role) ? m.role : 'user',
        content: typeof m.content === 'string' ? m.content : '',
        toolCalls: Array.isArray(m.toolCalls)
          ? m.toolCalls.map((tc) => ({
              id: tc.id ?? '',
              name: tc.name ?? '',
              argsText: tc.args !== undefined ? stringifyPretty(tc.args) : '',
            }))
          : [],
        toolCallId: m.toolCallId ?? '',
        name: m.name ?? '',
        extra,
      };
    }),
    tools: (Array.isArray(item.tools) ? item.tools : []).map((t) => ({
      name: t.name ?? '',
      description: t.description ?? '',
      parametersText: t.parameters !== undefined ? stringifyPretty(t.parameters) : '',
    })),
    reference: typeof expected.reference === 'string' ? expected.reference : '',
    expectedToolCalls,
    mustContain: toStringArray(expected.mustContain),
    mustNotContain: toStringArray(expected.mustNotContain),
    equals: typeof expected.equals === 'string' ? expected.equals : expected.equals != null ? String(expected.equals) : '',
    regex: typeof expected.regex === 'string' ? expected.regex : '',
    jsonSchemaText: expected.jsonSchema !== undefined ? stringifyPretty(expected.jsonSchema) : '',
    jsonPathRules,
    toolResultRows: Object.entries(toolResults).map(([key, value]) => ({
      key,
      valueText: stringifyPretty(value),
    })),
    extraItem,
    extraExpected,
  };
}

export interface DraftToItemResult {
  item?: EvalDatasetItemView;
  errors: string[];
}

/**
 * Serialize a draft back into a dataset item.
 * Validation (all collected, not fail-fast):
 *  - item id is required
 *  - conversation must have ≥1 turn carrying content or a tool call
 *  - every JSON field must parse (args, parameters, argsSchema, jsonSchema, toolResults values)
 *  - assistant tool calls / tools / expected tool calls need a name
 *  - tool turns need a toolCallId (declared or free-text)
 *  - regex must compile; jsonPath rules and toolResults rows need a key/path
 */
export function draftToItem(draft: ItemDraft): DraftToItemResult {
  const errors: string[] = [];

  const id = draft.id.trim();
  if (!id) errors.push('Item id is required.');

  const turns: EvalMessageView[] = [];
  const hasSubstance = draft.turns.some(
    (t) => t.content.trim() !== '' || (t.role === 'assistant' && t.toolCalls.length > 0),
  );
  if (draft.turns.length === 0 || !hasSubstance) {
    errors.push('Conversation needs at least one turn with content (or an assistant tool call).');
  }

  draft.turns.forEach((turn, i) => {
    const label = `Turn ${i + 1} (${turn.role})`;
    // Spread unmodeled keys FIRST so the modeled fields always win.
    const message: EvalMessageView = { ...turn.extra, role: turn.role, content: turn.content } as EvalMessageView;
    if (turn.role === 'assistant' && turn.toolCalls.length > 0) {
      const calls = turn.toolCalls.map((tc, j) => {
        if (!tc.name.trim()) errors.push(`${label}: tool call ${j + 1} needs a name.`);
        let args: Record<string, unknown> = {};
        try {
          args = parseObjectText(tc.argsText) ?? {};
        } catch (err) {
          errors.push(`${label}: tool call ${j + 1} args — ${(err as Error).message}`);
        }
        const call: NonNullable<EvalMessageView['toolCalls']>[number] = { name: tc.name.trim(), args };
        if (tc.id.trim()) call.id = tc.id.trim();
        return call;
      });
      message.toolCalls = calls;
    }
    if (turn.role === 'tool') {
      if (!turn.toolCallId.trim()) errors.push(`${label}: tool turns need a toolCallId.`);
      else message.toolCallId = turn.toolCallId.trim();
      if (turn.name.trim()) message.name = turn.name.trim();
    }
    turns.push(message);
  });

  const tools: EvalToolDefinitionView[] = draft.tools.map((tool, i) => {
    if (!tool.name.trim()) errors.push(`Tool ${i + 1}: name is required.`);
    const def: EvalToolDefinitionView = { name: tool.name.trim() };
    if (tool.description.trim()) def.description = tool.description.trim();
    try {
      const params = parseObjectText(tool.parametersText);
      if (params !== undefined) def.parameters = params;
    } catch (err) {
      errors.push(`Tool ${i + 1} (${tool.name || 'unnamed'}): parameters — ${(err as Error).message}`);
    }
    return def;
  });

  // ── expected ──
  const expected: Record<string, unknown> = { ...draft.extraExpected };
  if (draft.reference.trim()) expected.reference = draft.reference;
  if (draft.expectedToolCalls.length > 0) {
    expected.toolCalls = draft.expectedToolCalls.map((tc, i) => {
      if (!tc.name.trim()) errors.push(`Expected tool call ${i + 1}: name is required.`);
      const call: EvalExpectedToolCallView = { name: tc.name.trim(), argsMatch: tc.argsMatch };
      if (tc.argsMatch === 'exact' || tc.argsMatch === 'subset') {
        try {
          call.args = parseObjectText(tc.argsText) ?? {};
        } catch (err) {
          errors.push(`Expected tool call ${i + 1} (${tc.name || 'unnamed'}): args — ${(err as Error).message}`);
        }
      } else if (tc.argsMatch === 'schema') {
        try {
          const schema = parseObjectText(tc.argsSchemaText);
          if (schema !== undefined) call.argsSchema = schema;
        } catch (err) {
          errors.push(`Expected tool call ${i + 1} (${tc.name || 'unnamed'}): argsSchema — ${(err as Error).message}`);
        }
      }
      return call;
    });
  }
  if (draft.mustContain.length > 0) expected.mustContain = draft.mustContain;
  if (draft.mustNotContain.length > 0) expected.mustNotContain = draft.mustNotContain;
  if (draft.equals.trim()) expected.equals = draft.equals;
  if (draft.regex.trim()) {
    try {
      new RegExp(draft.regex);
      expected.regex = draft.regex;
    } catch {
      errors.push('Expected regex does not compile.');
    }
  }
  try {
    const schema = parseObjectText(draft.jsonSchemaText);
    if (schema !== undefined) expected.jsonSchema = schema;
  } catch (err) {
    errors.push(`Expected jsonSchema — ${(err as Error).message}`);
  }
  if (draft.jsonPathRules.length > 0) {
    expected.jsonPath = draft.jsonPathRules.map((rule, i) => {
      if (!rule.path.trim()) errors.push(`JSON-path assertion ${i + 1}: path is required.`);
      const assertion: EvalJsonPathAssertionView = { path: rule.path.trim(), exists: rule.exists };
      if (rule.equalsText.trim()) assertion.equals = parseJsonValueLoose(rule.equalsText);
      return assertion;
    });
  }

  // ── toolResults ──
  let toolResults: Record<string, unknown> | undefined;
  if (draft.toolResultRows.length > 0) {
    toolResults = {};
    const seen = new Set<string>();
    draft.toolResultRows.forEach((row, i) => {
      const key = row.key.trim();
      if (!key) {
        errors.push(`Tool result ${i + 1}: key is required.`);
        return;
      }
      if (seen.has(key)) errors.push(`Tool result ${i + 1}: duplicate key "${key}".`);
      seen.add(key);
      const valueError = jsonTextError(row.valueText);
      if (valueError || !row.valueText.trim()) {
        errors.push(`Tool result "${key}": value must be valid JSON (quote plain strings).`);
        return;
      }
      toolResults![key] = JSON.parse(row.valueText.trim());
    });
  }

  if (errors.length > 0) return { errors };

  const item: EvalDatasetItemView = {
    ...draft.extraItem,
    id,
    input: turns,
  };
  if (Object.keys(expected).length > 0) item.expected = expected;
  if (tools.length > 0) item.tools = tools;
  if (toolResults && Object.keys(toolResults).length > 0) item.toolResults = toolResults;
  if (draft.tags.length > 0) item.tags = draft.tags;
  return { item, errors: [] };
}

/* ── Whole-item raw JSON ──────────────────────────────────────────── */

export function itemToJsonText(item: EvalDatasetItemView): string {
  return stringifyPretty(item);
}

/** Parse the raw-JSON tab's text into a single item (minimal shape checks). */
export function parseItemJson(text: string): { item: EvalDatasetItemView } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { error: 'Item JSON is empty.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { error: `Invalid JSON: ${(err as Error).message}` };
  }
  if (!isPlainObject(parsed)) return { error: 'Item must be a JSON object.' };
  if (!Array.isArray(parsed.input)) return { error: 'Item must have an "input" array of messages.' };
  const item = parsed as unknown as EvalDatasetItemView;
  return { item: { ...item, id: typeof item.id === 'string' ? item.id : '' } };
}

/* ── Inference / suggestion helpers ───────────────────────────────── */

/** Tool names referenced by assistant toolCalls but not yet in `existing`. */
export function inferMissingToolNames(turns: TurnDraft[], existing: Array<{ name: string }>): string[] {
  const declared = new Set(existing.map((t) => t.name.trim()).filter(Boolean));
  const missing: string[] = [];
  for (const turn of turns) {
    if (turn.role !== 'assistant') continue;
    for (const call of turn.toolCalls) {
      const name = call.name.trim();
      if (name && !declared.has(name) && !missing.includes(name)) missing.push(name);
    }
  }
  return missing;
}

/**
 * toolCallIds declared by assistant turns before `beforeIndex`
 * (all assistant turns when omitted). Deduplicated, order preserved.
 */
export function declaredToolCallIds(turns: TurnDraft[], beforeIndex?: number): string[] {
  const limit = beforeIndex === undefined ? turns.length : Math.max(0, Math.min(beforeIndex, turns.length));
  const ids: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    const turn = turns[i];
    if (turn.role !== 'assistant') continue;
    for (const call of turn.toolCalls) {
      const id = call.id.trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** Names of the tools declared on the draft (for name Selects). */
export function declaredToolNames(tools: Array<{ name: string }>): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    const name = tool.name.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Smallest unused `<prefix>-<n>` id (n ≥ 1). */
export function suggestItemId(existingIds: string[], prefix = 'manual'): string {
  const taken = new Set(existingIds);
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/* ── Summaries (list columns / badges) ────────────────────────────── */

export interface ItemSummary {
  turns: number;
  tools: number;
  hasReference: boolean;
  hasExpectedToolCalls: boolean;
  /** mustContain / mustNotContain / equals / regex / jsonSchema / jsonPath. */
  hasAssertions: boolean;
}

export function summarizeItem(item: EvalDatasetItemView): ItemSummary {
  const expected = isPlainObject(item.expected) ? item.expected : {};
  const nonEmptyArray = (v: unknown) => Array.isArray(v) && v.length > 0;
  return {
    turns: Array.isArray(item.input) ? item.input.length : 0,
    tools: Array.isArray(item.tools) ? item.tools.length : 0,
    hasReference: typeof expected.reference === 'string' && expected.reference.trim() !== '',
    hasExpectedToolCalls: nonEmptyArray(expected.toolCalls),
    hasAssertions:
      nonEmptyArray(expected.mustContain) ||
      nonEmptyArray(expected.mustNotContain) ||
      (expected.equals !== undefined && expected.equals !== null && expected.equals !== '') ||
      (typeof expected.regex === 'string' && expected.regex !== '') ||
      expected.jsonSchema !== undefined ||
      nonEmptyArray(expected.jsonPath),
  };
}

/* ── Simple-row ↔ item (manual creation flow) ─────────────────────── */

/** The flat fields of a simple editor row (structurally matches EditorRow). */
export interface SimpleRowFields {
  id: string;
  input: string;
  reference: string;
  contains: string;
  tags: string;
}

/** Build a full item from a simple row (question → user turn, expected → reference). */
export function simpleRowToItem(row: SimpleRowFields, fallbackId: string): EvalDatasetItemView {
  const expected: Record<string, unknown> = {};
  if (row.reference.trim()) expected.reference = row.reference.trim();
  if (row.contains.trim()) {
    expected.mustContain = row.contains.split(/[|;,]/).map((s) => s.trim()).filter(Boolean);
  }
  const item: EvalDatasetItemView = {
    id: row.id.trim() || fallbackId,
    input: [{ role: 'user', content: row.input.trim() }],
  };
  if (Object.keys(expected).length > 0) item.expected = expected;
  const tags = row.tags.split(',').map((s) => s.trim()).filter(Boolean);
  if (tags.length > 0) item.tags = tags;
  return item;
}

/** Apply dataset-level default tools to items that don't define their own. */
export function applyDefaultTools(
  items: EvalDatasetItemView[],
  defaults: EvalToolDefinitionView[],
): EvalDatasetItemView[] {
  if (defaults.length === 0) return items;
  return items.map((item) =>
    Array.isArray(item.tools) && item.tools.length > 0
      ? item
      : { ...item, tools: defaults.map((t) => ({ ...t })) },
  );
}

/** Convert tool drafts to definitions. Throws never — returns errors instead. */
export function toolDraftsToDefinitions(
  drafts: ToolDraft[],
): { tools: EvalToolDefinitionView[]; errors: string[] } {
  const errors: string[] = [];
  const tools: EvalToolDefinitionView[] = [];
  drafts.forEach((tool, i) => {
    if (!tool.name.trim()) {
      errors.push(`Tool ${i + 1}: name is required.`);
      return;
    }
    const def: EvalToolDefinitionView = { name: tool.name.trim() };
    if (tool.description.trim()) def.description = tool.description.trim();
    try {
      const params = parseObjectText(tool.parametersText);
      if (params !== undefined) def.parameters = params;
    } catch (err) {
      errors.push(`Tool "${tool.name.trim()}": parameters — ${(err as Error).message}`);
    }
    tools.push(def);
  });
  return { tools, errors };
}

/** Convert tool definitions back to drafts (default-tools editor prefill). */
export function toolDefinitionsToDrafts(tools: EvalToolDefinitionView[]): ToolDraft[] {
  return tools.map((t) => ({
    name: t.name ?? '',
    description: t.description ?? '',
    parametersText: t.parameters !== undefined ? stringifyPretty(t.parameters) : '',
  }));
}
