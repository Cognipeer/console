/**
 * Validation and normalisation of dataset items arriving over the HTTP API.
 *
 * The canonical stored shape is `{ role, content, toolCalls: [{ id?, name, args: object }], toolCallId?, name? }`.
 * Callers that paste OpenAI chat transcripts send `tool_calls[].function.{name, arguments (JSON string)}` and
 * `tool_call_id` instead. Those used to be accepted and stored as-is, then ignored at replay: tool turns became
 * orphans with synthesized `{}` calls and the model was graded on a corrupted conversation without any error. This
 * module maps the OpenAI spelling onto the canonical one and rejects everything that cannot replay faithfully, so a
 * bad item is a 400 at write time instead of a silent wrong score later.
 *
 * Only the fields an item is allowed to carry are returned (unknown keys are dropped), and `labelMeta` is never
 * accepted from a client: it is server-stamped provenance (a human edit or an AI labeling run), and a client-sent
 * `{ source: 'human' }` would shield an item from every later AI labeling pass.
 */

const ROLES = ['system', 'user', 'assistant', 'tool'] as const;
const ARGS_MATCH_MODES = ['exact', 'subset', 'schema', 'ignore'] as const;

export type NormalizedItem = Record<string, unknown>;
export type ItemResult = { value: NormalizedItem } | { error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Tool-call arguments: an object, or a JSON string holding one (the OpenAI wire form). */
function parseArgs(raw: unknown): { args: Record<string, unknown> } | { error: string } {
  if (raw === undefined || raw === null) return { args: {} };
  if (typeof raw === 'string') {
    // An empty string is how some SDKs spell "no arguments".
    if (raw.trim() === '') return { args: {} };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed)) return { args: parsed };
    } catch {
      // fall through to the error below
    }
    return { error: 'must be a JSON object (or a string holding one)' };
  }
  if (isPlainObject(raw)) return { args: raw };
  return { error: 'must be an object' };
}

function normalizeToolCalls(raw: unknown, path: string): { calls: Array<Record<string, unknown>> } | { error: string } {
  if (!Array.isArray(raw)) return { error: `${path} must be an array` };
  const calls: Array<Record<string, unknown>> = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    const at = `${path}[${i}]`;
    if (!isPlainObject(entry)) return { error: `${at} must be an object` };
    // OpenAI nests the call under `function`; the canonical shape is flat.
    const fn = isPlainObject(entry.function) ? entry.function : undefined;
    const name = entry.name ?? fn?.name;
    if (typeof name !== 'string' || name.trim() === '') return { error: `${at}.name must be a non-empty string` };
    const parsed = parseArgs(entry.args !== undefined ? entry.args : fn?.arguments);
    if ('error' in parsed) return { error: `${at}.args ${parsed.error}` };
    if (entry.id !== undefined && entry.id !== null && typeof entry.id !== 'string') {
      return { error: `${at}.id must be a string` };
    }
    calls.push({
      ...(typeof entry.id === 'string' && entry.id !== '' ? { id: entry.id } : {}),
      name,
      args: parsed.args,
    });
  }
  return { calls };
}

function normalizeMessage(raw: unknown, path: string): { message: Record<string, unknown> } | { error: string } {
  if (!isPlainObject(raw)) return { error: `${path} must be an object` };
  if (typeof raw.role !== 'string' || !(ROLES as readonly string[]).includes(raw.role)) {
    return { error: `${path}.role must be one of ${ROLES.map((r) => `"${r}"`).join(', ')}` };
  }
  const role = raw.role;
  // An assistant turn that only issues tool calls legitimately has no text.
  let content = raw.content;
  if (role === 'assistant' && (content === undefined || content === null)) content = '';
  if (typeof content !== 'string') return { error: `${path}.content must be a string` };

  const message: Record<string, unknown> = { role, content };

  const rawCalls = raw.toolCalls !== undefined && raw.toolCalls !== null ? raw.toolCalls : raw.tool_calls;
  if (rawCalls !== undefined && rawCalls !== null) {
    const parsed = normalizeToolCalls(rawCalls, raw.toolCalls !== undefined && raw.toolCalls !== null ? `${path}.toolCalls` : `${path}.tool_calls`);
    if ('error' in parsed) return { error: parsed.error };
    if (parsed.calls.length > 0) message.toolCalls = parsed.calls;
  }

  const rawCallId = raw.toolCallId !== undefined && raw.toolCallId !== null ? raw.toolCallId : raw.tool_call_id;
  if (rawCallId !== undefined && rawCallId !== null) {
    if (typeof rawCallId !== 'string' || rawCallId === '') {
      return { error: `${path}.toolCallId must be a non-empty string` };
    }
    message.toolCallId = rawCallId;
  }

  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== 'string') return { error: `${path}.name must be a string` };
    if (raw.name !== '') message.name = raw.name;
  }
  return { message };
}

function normalizeTools(raw: unknown, path: string): { tools: Array<Record<string, unknown>> } | { error: string } {
  if (!Array.isArray(raw)) return { error: `${path} must be an array` };
  const tools: Array<Record<string, unknown>> = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    const at = `${path}[${i}]`;
    if (!isPlainObject(entry)) return { error: `${at} must be an object` };
    // OpenAI tool menus wrap the definition: { type: 'function', function: { name, description, parameters } }.
    const def = isPlainObject(entry.function) ? entry.function : entry;
    if (typeof def.name !== 'string' || def.name.trim() === '') return { error: `${at}.name must be a non-empty string` };
    if (def.description !== undefined && def.description !== null && typeof def.description !== 'string') {
      return { error: `${at}.description must be a string` };
    }
    // `null` parameters come back from Mongo for a tool saved without any: absent, not invalid.
    if (def.parameters !== undefined && def.parameters !== null && !isPlainObject(def.parameters)) {
      return { error: `${at}.parameters must be an object` };
    }
    tools.push({
      name: def.name,
      ...(typeof def.description === 'string' ? { description: def.description } : {}),
      ...(isPlainObject(def.parameters) ? { parameters: def.parameters } : {}),
    });
  }
  return { tools };
}

function normalizeExpected(raw: unknown, path: string): { expected: Record<string, unknown> } | { error: string } {
  if (!isPlainObject(raw)) return { error: `${path} must be an object` };
  const expected: Record<string, unknown> = { ...raw };
  if (raw.toolCalls !== undefined && raw.toolCalls !== null) {
    if (!Array.isArray(raw.toolCalls)) return { error: `${path}.toolCalls must be an array` };
    const calls: Array<Record<string, unknown>> = [];
    for (let i = 0; i < raw.toolCalls.length; i += 1) {
      const entry: unknown = raw.toolCalls[i];
      const at = `${path}.toolCalls[${i}]`;
      if (!isPlainObject(entry)) return { error: `${at} must be an object` };
      if (typeof entry.name !== 'string' || entry.name.trim() === '') {
        return { error: `${at}.name must be a non-empty string` };
      }
      if (
        entry.argsMatch !== undefined
        && entry.argsMatch !== null
        && !(ARGS_MATCH_MODES as readonly string[]).includes(entry.argsMatch as string)
      ) {
        return { error: `${at}.argsMatch must be one of ${ARGS_MATCH_MODES.map((m) => `"${m}"`).join(', ')}` };
      }
      const call: Record<string, unknown> = { ...entry };
      if (entry.args !== undefined && entry.args !== null) {
        const parsed = parseArgs(entry.args);
        if ('error' in parsed) return { error: `${at}.args ${parsed.error}` };
        call.args = parsed.args;
      } else {
        delete call.args;
      }
      if (entry.argsSchema !== undefined && entry.argsSchema !== null && !isPlainObject(entry.argsSchema)) {
        return { error: `${at}.argsSchema must be an object` };
      }
      if (entry.argsSchema === null) delete call.argsSchema;
      if (entry.argsMatch === null) delete call.argsMatch;
      calls.push(call);
    }
    expected.toolCalls = calls;
  } else if (raw.toolCalls === null) {
    delete expected.toolCalls;
  }
  return { expected };
}

/**
 * Validate and normalise the writable fields of one item. `partial` is the PATCH form: only keys present in `raw`
 * are returned, and an explicit `null` on an optional block passes through so the caller can clear it. In the
 * create form `null` blocks are treated as absent (Mongo hands `null` back for a field that was never set).
 *
 * `labels` are kept as a plain object (the callers stamp `labelMeta` themselves); `labelMeta` is always dropped.
 */
export function normalizeDatasetItem(raw: unknown, path: string, opts: { partial?: boolean } = {}): ItemResult {
  if (!isPlainObject(raw)) return { error: `${path} must be an object` };
  const partial = opts.partial === true;
  const out: NormalizedItem = {};

  if (typeof raw.id === 'string') out.id = raw.id;

  if (raw.input !== undefined || !partial) {
    if (!Array.isArray(raw.input)) {
      return { error: partial ? `${path}.input must be a message array` : `${path} must be an object with an "input" message array` };
    }
    const input: Array<Record<string, unknown>> = [];
    for (let j = 0; j < raw.input.length; j += 1) {
      const parsed = normalizeMessage(raw.input[j], `${path}.input[${j}]`);
      if ('error' in parsed) return { error: parsed.error };
      input.push(parsed.message);
    }
    out.input = input;
  }

  const optionalBlock = (
    key: 'expected' | 'tools' | 'toolResults' | 'responseFormat' | 'tags' | 'labels',
    build: (value: unknown) => { error: string } | { value: unknown },
  ): string | null => {
    const value = raw[key];
    if (value === undefined) return null;
    if (value === null) {
      if (partial) out[key] = null;
      return null;
    }
    const built = build(value);
    if ('error' in built) return built.error;
    out[key] = built.value;
    return null;
  };

  const error =
    optionalBlock('expected', (v) => {
      const r = normalizeExpected(v, `${path}.expected`);
      return 'error' in r ? r : { value: r.expected };
    })
    ?? optionalBlock('tools', (v) => {
      const r = normalizeTools(v, `${path}.tools`);
      return 'error' in r ? r : { value: r.tools };
    })
    ?? optionalBlock('toolResults', (v) => (isPlainObject(v) ? { value: v } : { error: `${path}.toolResults must be an object` }))
    ?? optionalBlock('responseFormat', (v) => (isPlainObject(v) ? { value: v } : { error: `${path}.responseFormat must be an object` }))
    ?? optionalBlock('tags', (v) => (
      Array.isArray(v) && v.every((t) => typeof t === 'string')
        ? { value: v }
        : { error: `${path}.tags must be an array of strings` }
    ))
    ?? optionalBlock('labels', (v) => (isPlainObject(v) ? { value: v } : { error: `${path}.labels must be an object` }));
  if (error) return { error };

  return { value: out };
}

/**
 * Validate a whole payload for dataset create / replace / append: every entry needs a non-empty unique string
 * `id` (items are addressed by id under a unique (dataset, id) constraint, so a duplicate is a clean 400 rather
 * than a destructive 409/500) and must pass `normalizeDatasetItem`.
 */
export function normalizeDatasetItems(items: unknown[]): { items: NormalizedItem[] } | { error: string } {
  const seen = new Set<string>();
  const out: NormalizedItem[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const raw = items[i];
    if (!isPlainObject(raw) || !Array.isArray(raw.input)) {
      return { error: `items[${i}] must be an object with an "input" message array` };
    }
    if (typeof raw.id !== 'string' || raw.id.trim() === '') {
      return { error: `items[${i}] must have a non-empty string "id"` };
    }
    if (seen.has(raw.id)) return { error: `items[${i}] duplicates item id "${raw.id}"` };
    seen.add(raw.id);
    const parsed = normalizeDatasetItem(raw, `items[${i}]`);
    if ('error' in parsed) return { error: parsed.error };
    out.push(parsed.value);
  }
  return { items: out };
}
