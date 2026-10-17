/**
 * Agent inputs — the typed "arguments" of an agent (`IAgentConfig.inputs`).
 *
 * One module for everything about them: the save-time check of the declaration,
 * the validation of the values a request supplies (every entry point: runs API,
 * Responses, chat completions, A2A, routines), the JSON Schema the client API
 * publishes (`input_schema`), and how a turn delivers them to the model:
 *
 *   - as prompt variables `{{input.<name>}}` (the agent author's own prompt), and
 *   - as an `Inputs` JSON block appended to the user message, so an agent whose
 *     prompt does not mention them still sees them.
 */

import type { IAgentInputField } from '@/lib/database/provider/types.domain';

export const AGENT_INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MAX_AGENT_INPUT_FIELDS = 32;
/** Each string input, in characters. */
export const MAX_INPUT_STRING_LENGTH = 8 * 1024;
/** All inputs of a request, serialized. */
export const MAX_INPUTS_BYTES = 32 * 1024;

const INPUT_TYPES: ReadonlyArray<IAgentInputField['type']> = ['string', 'number', 'integer', 'boolean', 'json'];

export interface InputIssue {
    field: string;
    message: string;
    /** Stable code of a declaration problem, so a UI can word it in its own language (`message` is English). */
    code?: InputIssueCode;
    params?: Record<string, string | number>;
}

export type InputIssueCode =
    | 'not_list' | 'too_many' | 'not_object' | 'name_invalid' | 'name_duplicate' | 'type_invalid' | 'text_expected'
    | 'required_flag' | 'enum_unsupported' | 'enum_invalid' | 'default_type' | 'default_not_allowed' | 'default_too_long';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function matchesType(type: IAgentInputField['type'], value: unknown): boolean {
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

/** Problems with a declared `config.inputs` (names, types, enums, defaults). Empty = valid. */
export function validateInputDeclaration(value: unknown): InputIssue[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return [{ field: 'inputs', code: 'not_list', message: 'Inputs must be a list' }];
    const issues: InputIssue[] = [];
    if (value.length > MAX_AGENT_INPUT_FIELDS) {
        issues.push({ field: 'inputs', code: 'too_many', params: { max: MAX_AGENT_INPUT_FIELDS }, message: `An agent can declare at most ${MAX_AGENT_INPUT_FIELDS} inputs` });
    }
    const seen = new Set<string>();
    value.slice(0, MAX_AGENT_INPUT_FIELDS * 2).forEach((entry, index) => {
        const at = `inputs[${index}]`;
        if (!isPlainObject(entry)) {
            issues.push({ field: at, code: 'not_object', message: 'Each input must be an object' });
            return;
        }
        const name = entry.name;
        if (typeof name !== 'string' || !AGENT_INPUT_NAME_RE.test(name)) {
            issues.push({ field: `${at}.name`, code: 'name_invalid', message: 'Name must start with a letter or "_" and use only letters, digits and "_" (max 64)' });
        } else if (seen.has(name)) {
            issues.push({ field: `${at}.name`, code: 'name_duplicate', params: { name }, message: `Input "${name}" is declared twice` });
        } else {
            seen.add(name);
        }
        const type = entry.type;
        if (typeof type !== 'string' || !INPUT_TYPES.includes(type as IAgentInputField['type'])) {
            issues.push({ field: `${at}.type`, code: 'type_invalid', params: { types: INPUT_TYPES.join(', ') }, message: `Type must be one of ${INPUT_TYPES.join(', ')}` });
            return;
        }
        const fieldType = type as IAgentInputField['type'];
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
                issues.push({ field: `${at}.enum`, code: 'enum_unsupported', params: { type: fieldType }, message: `A ${fieldType} input cannot have a list of allowed values` });
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
            } else if (typeof entry.default === 'string' && entry.default.length > MAX_INPUT_STRING_LENGTH) {
                issues.push({ field: `${at}.default`, code: 'default_too_long', params: { max: MAX_INPUT_STRING_LENGTH }, message: `Default must be at most ${MAX_INPUT_STRING_LENGTH} characters` });
            }
        }
    });
    return issues;
}

// ── Request time ────────────────────────────────────────────────────────

export type ResolvedInputs =
    | { ok: true; inputs: Record<string, unknown> | null }
    | { ok: false; errors: InputIssue[] };

/**
 * Checks the values a request supplies against the agent's declared inputs and
 * fills defaults. Unknown names, a missing required value, a wrong type or a
 * value outside the enum are errors (all reported together); `inputs: null`
 * when nothing is left to deliver.
 */
export function resolveRunInputs(
    declared: ReadonlyArray<IAgentInputField> | undefined,
    supplied: Record<string, unknown> | null | undefined,
): ResolvedInputs {
    const fields = declared ?? [];
    const given = supplied ?? {};
    const errors: InputIssue[] = [];
    const byName = new Map(fields.map((field) => [field.name, field]));

    for (const key of Object.keys(given)) {
        if (!byName.has(key)) errors.push({ field: key, message: fields.length === 0 ? 'This agent declares no inputs' : 'Not an input of this agent' });
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
        if (typeof value === 'string' && value.length > MAX_INPUT_STRING_LENGTH) {
            errors.push({ field: field.name, message: `Must be at most ${MAX_INPUT_STRING_LENGTH} characters` });
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
        try { size = JSON.stringify(out).length; } catch { errors.push({ field: 'inputs', message: 'Inputs must be JSON values' }); }
        if (size > MAX_INPUTS_BYTES) errors.push({ field: 'inputs', message: `Inputs together must be at most ${MAX_INPUTS_BYTES} bytes` });
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, inputs: Object.keys(out).length > 0 ? out : null };
}

// ── Published schema ────────────────────────────────────────────────────

/** The JSON Schema of an agent's inputs (`input_schema` on the client API), or null when it declares none. */
export function inputsToJsonSchema(declared: ReadonlyArray<IAgentInputField> | undefined): Record<string, unknown> | null {
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
 * The values prompt templates read as `{{input.<name>}}`: the declared defaults
 * under whatever the request supplied. Undefined when the agent declares nothing
 * and the request carries nothing.
 */
export function inputPromptValues(
    declared: ReadonlyArray<IAgentInputField> | undefined,
    inputs: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
    const values: Record<string, unknown> = {};
    for (const field of declared ?? []) {
        if (field.default !== undefined && field.default !== null) values[field.name] = field.default;
    }
    Object.assign(values, inputs ?? {});
    const hasDeclared = (declared?.length ?? 0) > 0;
    return hasDeclared || Object.keys(values).length > 0 ? values : undefined;
}

/**
 * JSON for the Inputs block. The line separators JavaScript tolerates inside
 * strings (U+2028, U+2029, U+0085) and the backtick are written as escapes, so
 * a value cannot break out of the fenced block or fake a new line; the parsed
 * value is unchanged.
 */
export function stringifyInputsBlock(inputs: Record<string, unknown>): string {
    return JSON.stringify(inputs, null, 2)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
        .replace(/\u0085/g, '\\u0085')
        .replace(/`/g, '\\u0060');
}

export const EXTERNAL_DATA_CLOSING_LINE = 'End of external data.';

/**
 * The user message a turn runs on: the person's words, then (when there are
 * inputs) the Inputs block, then — for content that came from outside the
 * platform's own callers (a webhook payload) — a closing line, so text inside
 * the data cannot pass as the end of it. An empty message leaves only the block.
 */
export function composeUserMessageWithInputs(
    message: string,
    inputs: Record<string, unknown> | null | undefined,
    options: { externalContent?: boolean } = {},
): string {
    const hasInputs = Boolean(inputs && Object.keys(inputs).length > 0);
    if (!hasInputs && !options.externalContent) return message;
    const parts: string[] = [];
    if (message.length > 0) parts.push(message);
    if (hasInputs) parts.push(`Inputs:\n\`\`\`json\n${stringifyInputsBlock(inputs!)}\n\`\`\``);
    if (options.externalContent) parts.push(EXTERNAL_DATA_CLOSING_LINE);
    return parts.join('\n\n');
}
