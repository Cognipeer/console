/**
 * Makes tool argument schemas acceptable to a provider's STRICT tool mode.
 *
 * With structured output on, agent-sdk binds tools with `strict: true` for
 * OpenAI-family models, and the OpenAI client's `parse` path (native
 * structured output) accepts nothing else. Strict mode has three rules our
 * tools broke:
 *
 *  1. every property must be listed in `required` — optional arguments are
 *     not allowed, so the knowledge tools' optional `offset` / `limit` made
 *     the provider reject the whole request (`400 Invalid schema for function
 *     'knowledge_read_document_lines' … Missing 'offset'`);
 *  2. every object must be closed (`additionalProperties: false`);
 *  3. there is no free-form object — a `body: { type: object }` with no
 *     properties has no strict form at all.
 *
 * The transform keeps the tool's MEANING and changes only its wire form:
 *
 *  - an optional argument becomes required-but-nullable (the model sends
 *    `null` for "not given"), and `restore` drops those nulls again before the
 *    tool runs — the executor sees exactly the arguments it always saw;
 *  - objects are closed;
 *  - a free-form object/record/any becomes a JSON-encoded STRING, which
 *    `restore` parses back into the object the executor expects.
 *
 * `withStrictToolCalling` applies it at the model's `bindTools` — the one
 * point every tool (the agent's and agent-sdk's own) passes through — for
 * every provider that supports strict tool calling.
 */

import { z, type ZodTypeAny } from 'zod';

export interface StrictTransform {
    schema: ZodTypeAny;
    /** Maps the model's strict-shaped arguments back to what the tool expects. */
    restore: (value: unknown) => unknown;
}

const identity = (value: unknown) => value;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDef = any;

function describeLike<T extends ZodTypeAny>(schema: T, source: ZodTypeAny, suffix?: string): T {
    const description = [source.description, suffix].filter(Boolean).join(' ');
    return description ? (schema.describe(description) as T) : schema;
}

/** A value the schema cannot close: encoded as JSON text, decoded on the way in. */
function jsonString(source: ZodTypeAny): StrictTransform {
    return {
        schema: describeLike(z.string(), source, '(a JSON object, encoded as a string)'),
        restore: (value) => {
            if (typeof value !== 'string') return value;
            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
        },
    };
}

function unwrapOptional(schema: ZodTypeAny): { inner: ZodTypeAny; optional: boolean } {
    const def = schema._def as AnyDef;
    if (def?.typeName === 'ZodOptional') return { inner: def.innerType, optional: true };
    if (def?.typeName === 'ZodDefault') return { inner: def.innerType, optional: true };
    return { inner: schema, optional: false };
}

export function toStrictCompatible(schema: ZodTypeAny): StrictTransform {
    const def = schema?._def as AnyDef;
    switch (def?.typeName) {
        case 'ZodObject': {
            const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
            const keys = Object.keys(shape ?? {});
            const open = def.unknownKeys === 'passthrough'
                || (def.catchall && def.catchall._def?.typeName !== 'ZodNever');
            // No declared properties and open to anything: there is no
            // strict way to say that, so it travels as JSON text.
            if (keys.length === 0 && open) return jsonString(schema);

            const nextShape: Record<string, ZodTypeAny> = {};
            const restores: Record<string, { restore: StrictTransform['restore']; optional: boolean }> = {};
            for (const key of keys) {
                const field = shape[key] as ZodTypeAny;
                const { inner, optional } = unwrapOptional(field);
                const child = toStrictCompatible(inner);
                const childSchema = describeLike(child.schema, field.description ? field : inner);
                nextShape[key] = optional ? childSchema.nullable() : childSchema;
                restores[key] = { restore: child.restore, optional };
            }
            return {
                schema: describeLike(z.object(nextShape), schema),
                restore: (value) => {
                    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
                    const out: Record<string, unknown> = {};
                    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
                        const entry = restores[key];
                        // `null` for an optional argument means "not given":
                        // omit it, so a tool that checks `=== undefined` or
                        // builds a query string never sees a literal null.
                        if (raw === null && entry?.optional) continue;
                        out[key] = entry ? entry.restore(raw) : raw;
                    }
                    return out;
                },
            };
        }
        case 'ZodOptional':
        case 'ZodDefault': {
            const child = toStrictCompatible(def.innerType);
            return {
                schema: describeLike(child.schema.nullable(), schema),
                restore: (value) => (value === null ? undefined : child.restore(value)),
            };
        }
        case 'ZodNullable': {
            const child = toStrictCompatible(def.innerType);
            return {
                schema: describeLike(child.schema.nullable(), schema),
                restore: (value) => (value === null ? null : child.restore(value)),
            };
        }
        case 'ZodArray': {
            const child = toStrictCompatible(def.type);
            return {
                schema: describeLike(z.array(child.schema), schema),
                restore: (value) => (Array.isArray(value) ? value.map(child.restore) : value),
            };
        }
        case 'ZodUnion':
        case 'ZodDiscriminatedUnion': {
            // Each branch must satisfy strict mode on its own: manage_plan's
            // `todoList: array(union(writeItem, updateItem))` left the
            // branches' optional fields out of `required`, and the provider
            // rejected every run with planning on (`… anyOf 0 … Missing 'step'`).
            const rawOptions = def.options instanceof Map ? [...def.options.values()] : def.options;
            const options = (rawOptions as ZodTypeAny[]).map(toStrictCompatible);
            if (options.length === 1) return options[0];
            if (options.every((option, index) => option.schema === rawOptions[index])) {
                return { schema, restore: identity };
            }
            return {
                schema: describeLike(z.union(options.map((option) => option.schema) as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]), schema),
                restore: (value) => {
                    // The model's value names no branch: the first branch
                    // whose restored value its ORIGINAL schema accepts wins
                    // (a "not given" null is only droppable where optional).
                    const candidates = options.map((option) => option.restore(value));
                    const index = candidates.findIndex((candidate, i) => (rawOptions as ZodTypeAny[])[i].safeParse(candidate).success);
                    return candidates[index >= 0 ? index : 0];
                },
            };
        }
        case 'ZodEffects':
            return toStrictCompatible(def.schema);
        case 'ZodRecord':
        case 'ZodAny':
        case 'ZodUnknown':
            return jsonString(schema);
        default:
            // Primitives, enums, literals, unions of primitives: already strict.
            return { schema, restore: identity };
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
interface BindableModel {
    bindTools?: AnyFn;
    invoke?: AnyFn;
    stream?: AnyFn;
    capabilities?: { strictToolCalling?: boolean };
}
interface ToolLike {
    name?: string;
    schema?: unknown;
    [key: string]: unknown;
}
type Restorers = Map<string, StrictTransform['restore']>;

function isZod(schema: unknown): schema is ZodTypeAny {
    return Boolean(schema) && typeof (schema as { safeParse?: unknown }).safeParse === 'function';
}

/**
 * Restores one model message's tool-call arguments to the tools' ORIGINAL
 * shape: the "not given" nulls dropped, JSON-encoded free-form values decoded.
 * Handles both the LangChain form (`args` object) and the raw OpenAI form
 * (`function.arguments` string). Exported for tests.
 */
export function restoreToolCalls<M>(message: M, restorers: Restorers): M {
    const m = message as unknown as { tool_calls?: Array<Record<string, unknown>> } | undefined;
    if (!m || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return message;
    const toolCalls = m.tool_calls.map((call) => {
        const fn = call.function as { name?: string; arguments?: unknown } | undefined;
        const name = (call.name as string | undefined) ?? fn?.name;
        const restore = name ? restorers.get(name) : undefined;
        if (!restore) return call;
        if (call.args && typeof call.args === 'object') return { ...call, args: restore(call.args) };
        if (fn && typeof fn.arguments === 'string') {
            try {
                return { ...call, function: { ...fn, arguments: JSON.stringify(restore(JSON.parse(fn.arguments))) } };
            } catch {
                return call;
            }
        }
        return call;
    });
    return { ...(message as object), tool_calls: toolCalls } as M;
}

function withRestoredToolArgs<T extends object>(input: T, restorers: Restorers): T {
    const model = input as T & BindableModel;
    const wrapped = { ...model } as BindableModel & Record<string, unknown>;
    if (typeof model.invoke === 'function') {
        const invoke = model.invoke.bind(model);
        wrapped.invoke = async (...args: unknown[]) => restoreToolCalls(await invoke(...args), restorers);
    }
    if (typeof model.stream === 'function') {
        const stream = model.stream.bind(model);
        wrapped.stream = async function* restored(...args: unknown[]) {
            for await (const chunk of stream(...args) as AsyncIterable<unknown>) {
                // Raw deltas pass through; the assembled message (the one the
                // SDK keeps — it carries a role) is where the args are read.
                const hasRole = Boolean(chunk && typeof chunk === 'object' && (chunk as { role?: unknown }).role);
                yield hasRole ? restoreToolCalls(chunk, restorers) : chunk;
            }
        };
    }
    return wrapped as unknown as T;
}

/**
 * A tool's arguments must be an OBJECT schema. An open object with no declared
 * properties (a tool whose contract is unknown) transforms to a JSON string,
 * and a bare string at the top level got wrapped by LangChain into
 * `{ input }` with no `required` — which strict mode rejects outright
 * ("Missing 'input'"), failing every call of the agent, not just this tool's.
 * Here the string is carried as an explicit required `input` field instead,
 * and unwrapped back into the object the tool expects.
 */
function topLevelObject(transform: StrictTransform): StrictTransform {
    if ((transform.schema._def as AnyDef)?.typeName === 'ZodObject') return transform;
    return {
        schema: z.object({
            input: transform.schema.describe(
                transform.schema.description ?? 'The tool arguments as a JSON object, encoded as a string',
            ),
        }),
        restore: (value) => {
            const input = (value && typeof value === 'object' ? (value as { input?: unknown }).input : undefined);
            const restored = transform.restore(input);
            return restored && typeof restored === 'object' ? restored : {};
        },
    };
}

/**
 * Binds EVERY tool the provider sees in strict mode — the agent's own tools
 * and the ones agent-sdk injects itself (manage_plan, open_skill,
 * search_skills, get_tool_response, spawn_subagent, …), most of which have
 * optional arguments and were not strict-compatible either. `bindTools` is
 * the one chokepoint every tool passes through on its way to the provider,
 * so it is the only place that can guarantee "everything".
 *
 * The provider sees the strict-shaped schemas; the model's tool calls are
 * restored to the ORIGINAL shape before agent-sdk validates and runs them, so
 * no tool — ours or the SDK's — ever sees a strict-mode null.
 *
 * Applied to providers that support strict tool calling (OpenAI-family), and
 * there ALWAYS, not only with structured output: strict mode is what makes a
 * tool call's arguments schema-valid by construction, which is worth having on
 * every call. Providers without strict mode are left untouched.
 */
export function withStrictToolCalling<T extends object>(input: T): T {
    const model = input as T & BindableModel;
    if (!model || typeof model !== 'object' || typeof model.bindTools !== 'function') return input;
    if (!model.capabilities?.strictToolCalling) return input;
    const bindTools = model.bindTools.bind(model);
    const wrapped = { ...model } as BindableModel & Record<string, unknown>;
    wrapped.bindTools = (tools: unknown, options?: Record<string, unknown>) => {
        const restorers: Restorers = new Map();
        const shaped = (Array.isArray(tools) ? tools : []).map((candidate) => {
            const tool = candidate as ToolLike;
            if (!tool || !tool.name || !isZod(tool.schema)) return candidate;
            const transform = topLevelObject(toStrictCompatible(tool.schema));
            restorers.set(tool.name, transform.restore);
            const copy: ToolLike = { ...tool, schema: transform.schema };
            // agent-sdk caches its LangChain conversion on the tool object;
            // that cache was built from the original schema.
            delete copy.__lcTool;
            return copy;
        });
        const bound = bindTools(shaped, { ...(options ?? {}), strict: true });
        return withRestoredToolArgs(bound as object, restorers);
    };
    return wrapped as unknown as T;
}
