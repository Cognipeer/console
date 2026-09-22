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
 * Only applied when the provider will actually use strict mode, so agents
 * without structured output — and providers that never go strict — keep their
 * tools exactly as they were.
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

interface InvokableTool {
    name?: string;
    schema?: unknown;
    invoke?: (input: unknown) => unknown;
    [key: string]: unknown;
}

/**
 * Returns the tools with strict-compatible schemas and executors that
 * restore the original argument shape. A tool without a zod schema is
 * passed through unchanged.
 */
export function makeToolsStrictCompatible<T>(tools: T[]): T[] {
    return tools.map((candidate) => {
        const tool = candidate as unknown as InvokableTool;
        const schema = tool?.schema as ZodTypeAny | undefined;
        if (!schema || typeof (schema as { safeParse?: unknown }).safeParse !== 'function' || typeof tool.invoke !== 'function') {
            return candidate;
        }
        const { schema: strictSchema, restore } = toStrictCompatible(schema);
        const invoke = tool.invoke.bind(tool);
        const execute = async (input: unknown) => invoke(restore(input));
        const next: InvokableTool = {
            ...tool,
            schema: strictSchema,
            invoke: execute,
            call: execute,
            run: execute,
            func: execute,
        };
        // The SDK caches a LangChain conversion on the tool; it was built from
        // the old schema and must not be reused.
        delete next.__lcTool;
        return next as unknown as T;
    });
}
