/**
 * Agent variables — the typed "arguments" of an agent (`IAgentConfig.variables`).
 *
 * One module for everything about them: the save-time check of the declaration,
 * the validation of the values a request supplies (every entry point: runs API,
 * Responses, chat completions, A2A, triggers), the JSON Schema the client API
 * publishes (`variables_schema`), and how a turn delivers them to the model:
 *
 *   - as prompt variables `{{variables.<name>}}` (the agent author's own prompt), and
 *   - as a `Variables` JSON block appended to the user message, so an agent whose
 *     prompt does not mention them still sees them.
 *
 * Where they fit. A variable is a value a caller sends NEXT TO the message, so it
 * suits runs a program starts: the runs API, Responses, triggers, A2A data parts.
 * Chat clients send only messages. Over the API a required variable without a default
 * therefore refuses every chat message (400 `invalid_variables`), before a run exists.
 * The playground and the portals never take variables (a default still fills
 * `{{variables.<name>}}`); a realtime session's own variables arrive as
 * `runtime_context.metadata.variables` and are read through the same root (see
 * `promptVariables.ts`).
 *
 * Per turn. Values belong to the request that carried them. The prompt placeholders
 * are rendered again on every turn from that turn's values over the declared
 * defaults. The Variables block is part of the stored user message, so a session
 * replays earlier blocks as history, and a client that resends values on every turn
 * repeats the block. A required variable with a default never fails for being absent.
 */

import type { IAgentVariable } from '@/lib/database/provider/types.domain';

export const AGENT_VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MAX_AGENT_VARIABLES = 32;
/** Each string variable, in characters. */
export const MAX_VARIABLE_STRING_LENGTH = 8 * 1024;
/** All variables of a request, serialized. */
export const MAX_VARIABLES_BYTES = 32 * 1024;

const VARIABLE_TYPES: ReadonlyArray<IAgentVariable['type']> = ['string', 'number', 'integer', 'boolean', 'json'];

export interface VariableIssue {
    field: string;
    message: string;
    /** Stable code of a declaration problem, so a UI can word it in its own language (`message` is English). */
    code?: VariableIssueCode;
    params?: Record<string, string | number>;
}

export type VariableIssueCode =
    | 'not_list' | 'too_many' | 'not_object' | 'name_invalid' | 'name_duplicate' | 'type_invalid' | 'text_expected'
    | 'required_flag' | 'enum_unsupported' | 'enum_invalid' | 'default_type' | 'default_not_allowed' | 'default_too_long';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function matchesType(type: IAgentVariable['type'], value: unknown): boolean {
    switch (type) {
        case 'string': return typeof value === 'string';
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        case 'integer': return typeof value === 'number' && Number.isInteger(value);
        case 'boolean': return typeof value === 'boolean';
        case 'json': return value !== undefined;
        default: return false;
    }
}

// ── Save time ───────────────────────────────────────────────────────────

/** Problems with a declared `config.variables` (names, types, enums, defaults). Empty = valid. */
export function validateVariableDeclaration(value: unknown): VariableIssue[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return [{ field: 'variables', code: 'not_list', message: 'Variables must be a list' }];
    const issues: VariableIssue[] = [];
    if (value.length > MAX_AGENT_VARIABLES) {
        issues.push({ field: 'variables', code: 'too_many', params: { max: MAX_AGENT_VARIABLES }, message: `An agent can declare at most ${MAX_AGENT_VARIABLES} variables` });
    }
    const seen = new Set<string>();
    value.slice(0, MAX_AGENT_VARIABLES * 2).forEach((entry, index) => {
        const at = `variables[${index}]`;
        if (!isPlainObject(entry)) {
            issues.push({ field: at, code: 'not_object', message: 'Each variable must be an object' });
            return;
        }
        const name = entry.name;
        if (typeof name !== 'string' || !AGENT_VARIABLE_NAME_RE.test(name)) {
            issues.push({ field: `${at}.name`, code: 'name_invalid', message: 'Name must start with a letter or "_" and use only letters, digits and "_" (max 64)' });
        } else if (seen.has(name)) {
            issues.push({ field: `${at}.name`, code: 'name_duplicate', params: { name }, message: `Variable "${name}" is declared twice` });
        } else {
            seen.add(name);
        }
        const type = entry.type;
        if (typeof type !== 'string' || !VARIABLE_TYPES.includes(type as IAgentVariable['type'])) {
            issues.push({ field: `${at}.type`, code: 'type_invalid', params: { types: VARIABLE_TYPES.join(', ') }, message: `Type must be one of ${VARIABLE_TYPES.join(', ')}` });
            return;
        }
        const fieldType = type as IAgentVariable['type'];
        for (const key of ['label', 'description'] as const) {
            if (entry[key] !== undefined && typeof entry[key] !== 'string') {
                issues.push({ field: `${at}.${key}`, code: 'text_expected', params: { key }, message: `${key} must be text` });
            }
        }
        if (entry.required !== undefined && typeof entry.required !== 'boolean') {
            issues.push({ field: `${at}.required`, code: 'required_flag', message: 'required must be true or false' });
        }
        if (entry.enum !== undefined) {
            const list = entry.enum;
            const allowed = fieldType === 'string' ? 'string' : fieldType === 'number' || fieldType === 'integer' ? 'number' : null;
            if (!allowed) {
                issues.push({ field: `${at}.enum`, code: 'enum_unsupported', params: { type: fieldType }, message: `A ${fieldType} variable cannot have a list of allowed values` });
            } else if (!Array.isArray(list) || list.length === 0 || list.length > 100
                || list.some((item) => typeof item !== allowed || (allowed === 'number' && !Number.isFinite(item))
                    || (fieldType === 'integer' && !Number.isInteger(item)))) {
                issues.push({ field: `${at}.enum`, code: 'enum_invalid', params: { kind: allowed === 'string' ? 'strings' : fieldType === 'integer' ? 'integers' : 'numbers' }, message: `Allowed values must be 1-100 ${allowed === 'string' ? 'strings' : fieldType === 'integer' ? 'integers' : 'numbers'}` });
            }
        }
        if (entry.default !== undefined && entry.default !== null) {
            if (!matchesType(fieldType, entry.default)) {
                issues.push({ field: `${at}.default`, code: 'default_type', params: { type: fieldType }, message: `Default must be ${fieldType === 'integer' ? 'an integer' : `a ${fieldType}`}` });
            } else if (Array.isArray(entry.enum) && !entry.enum.includes(entry.default as string | number)) {
                issues.push({ field: `${at}.default`, code: 'default_not_allowed', message: 'Default must be one of the allowed values' });
            } else if (typeof entry.default === 'string' && entry.default.length > MAX_VARIABLE_STRING_LENGTH) {
                issues.push({ field: `${at}.default`, code: 'default_too_long', params: { max: MAX_VARIABLE_STRING_LENGTH }, message: `Default must be at most ${MAX_VARIABLE_STRING_LENGTH} characters` });
            }
        }
    });
    return issues;
}

// ── Request time ────────────────────────────────────────────────────────

export type ResolvedVariables =
    | { ok: true; variables: Record<string, unknown> | null }
    | { ok: false; errors: VariableIssue[] };

/**
 * Checks the values a request supplies against the agent's declared variables and
 * fills defaults. Unknown names, a missing required value, a wrong type or a
 * value outside the enum are errors (all reported together); `variables: null`
 * when nothing is left to deliver.
 */
export function resolveRunVariables(
    declared: ReadonlyArray<IAgentVariable> | undefined,
    supplied: Record<string, unknown> | null | undefined,
): ResolvedVariables {
    const fields = declared ?? [];
    const given = supplied ?? {};
    const errors: VariableIssue[] = [];
    const byName = new Map(fields.map((field) => [field.name, field]));

    for (const key of Object.keys(given)) {
        if (!byName.has(key)) errors.push({ field: key, message: fields.length === 0 ? 'This agent declares no variables' : 'Not a variable of this agent' });
    }

    const out: Record<string, unknown> = {};
    for (const field of fields) {
        let value = given[field.name];
        if (value === null) value = undefined;
        if (value === undefined && field.default !== undefined && field.default !== null) value = field.default;
        if (value === undefined) {
            if (field.required) errors.push({ field: field.name, message: 'Required' });
            continue;
        }
        if (!matchesType(field.type, value)) {
            errors.push({ field: field.name, message: `Must be ${field.type === 'integer' ? 'an integer' : `a ${field.type}`}` });
            continue;
        }
        if (typeof value === 'string' && value.length > MAX_VARIABLE_STRING_LENGTH) {
            errors.push({ field: field.name, message: `Must be at most ${MAX_VARIABLE_STRING_LENGTH} characters` });
            continue;
        }
        if (field.enum && field.enum.length > 0 && !field.enum.includes(value as string | number)) {
            errors.push({ field: field.name, message: `Must be one of: ${field.enum.join(', ')}` });
            continue;
        }
        out[field.name] = value;
    }

    if (errors.length === 0 && Object.keys(out).length > 0) {
        let size = 0;
        try { size = JSON.stringify(out).length; } catch { errors.push({ field: 'variables', message: 'Variables must be JSON values' }); }
        if (size > MAX_VARIABLES_BYTES) errors.push({ field: 'variables', message: `Variables together must be at most ${MAX_VARIABLES_BYTES} bytes` });
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, variables: Object.keys(out).length > 0 ? out : null };
}

// ── Published schema ────────────────────────────────────────────────────

/** The JSON Schema of an agent's variables (`variables_schema` on the client API), or null when it declares none. */
export function variablesToJsonSchema(declared: ReadonlyArray<IAgentVariable> | undefined): Record<string, unknown> | null {
    if (!declared || declared.length === 0) return null;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const field of declared) {
        const node: Record<string, unknown> = field.type === 'json' ? {} : { type: field.type };
        const title = field.label ?? undefined;
        if (title) node.title = title;
        if (field.description) node.description = field.description;
        if (field.enum && field.enum.length > 0) node.enum = [...field.enum];
        if (field.default !== undefined && field.default !== null) node.default = field.default;
        properties[field.name] = node;
        if (field.required) required.push(field.name);
    }
    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
}

// ── Delivery ────────────────────────────────────────────────────────────

/**
 * The values prompt templates read as `{{variables.<name>}}`: the declared defaults
 * under whatever the request supplied. Undefined when the agent declares nothing
 * and the request carries nothing.
 */
export function variablePromptValues(
    declared: ReadonlyArray<IAgentVariable> | undefined,
    variables: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
    const values: Record<string, unknown> = {};
    for (const field of declared ?? []) {
        if (field.default !== undefined && field.default !== null) values[field.name] = field.default;
    }
    Object.assign(values, variables ?? {});
    const hasDeclared = (declared?.length ?? 0) > 0;
    return hasDeclared || Object.keys(values).length > 0 ? values : undefined;
}

/**
 * The values a referenced agent's declared variables take from the run that
 * delegates to it: the delegating run's value of the same name, for each name
 * the referenced agent declares. A value of another type, or outside the
 * declared list, is left out (the declared default then applies), and so is a
 * name the delegating run does not carry. Null when nothing is left, so the
 * result goes straight in as `variables` of `buildPromptVariables`.
 */
export function delegatedVariableValues(
    declared: ReadonlyArray<IAgentVariable> | undefined,
    parentValues: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const field of declared ?? []) {
        const value = parentValues?.[field.name];
        if (value === undefined || value === null || !matchesType(field.type, value)) continue;
        if (field.enum && field.enum.length > 0 && !field.enum.includes(value as string | number)) continue;
        out[field.name] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * Names of the variables a referenced agent requires (and gives no default)
 * that the agent delegating to it does not declare. A sub-agent is handed free
 * text, never a set of values, so these can only come from a variable of the
 * same name on the parent: without one, they stay empty in the child's prompt.
 */
export function unsuppliableRequiredVariables(
    referenced: ReadonlyArray<IAgentVariable> | undefined,
    parent: ReadonlyArray<IAgentVariable> | undefined,
): string[] {
    const parentNames = new Set((parent ?? []).map((field) => field.name));
    return (referenced ?? [])
        .filter((field) => field.required && (field.default === undefined || field.default === null) && !parentNames.has(field.name))
        .map((field) => field.name);
}

/**
 * JSON for the Variables block. The line separators JavaScript tolerates inside
 * strings (U+2028, U+2029, U+0085) and the backtick are written as escapes, so
 * a value cannot break out of the fenced block or fake a new line; the parsed
 * value is unchanged.
 */
export function stringifyVariablesBlock(variables: Record<string, unknown>): string {
    return JSON.stringify(variables, null, 2)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
        .replace(/\u0085/g, '\\u0085')
        .replace(/`/g, '\\u0060');
}

export const EXTERNAL_DATA_CLOSING_LINE = 'End of external data.';

/**
 * The user message a turn runs on: the person's words, then (when there are
 * variables) the Variables block, then — for content that came from outside the
 * platform's own callers (a webhook payload) — a closing line, so text inside
 * the data cannot pass as the end of it. An empty message leaves only the block.
 */
export function composeUserMessageWithVariables(
    message: string,
    variables: Record<string, unknown> | null | undefined,
    options: { externalContent?: boolean } = {},
): string {
    const hasVariables = Boolean(variables && Object.keys(variables).length > 0);
    if (!hasVariables && !options.externalContent) return message;
    const parts: string[] = [];
    if (message.length > 0) parts.push(message);
    if (hasVariables) parts.push(`Variables:\n\`\`\`json\n${stringifyVariablesBlock(variables!)}\n\`\`\``);
    if (options.externalContent) parts.push(EXTERNAL_DATA_CLOSING_LINE);
    return parts.join('\n\n');
}
