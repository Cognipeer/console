/**
 * Configure → Client tools: pure edits on the stored `clientTools` list and the
 * inline checks the panel shows. The rules mirror `checkEmbeddedClientTools`
 * (server side, which also runs on save); they are repeated here because that
 * module imports Node-only code that must not reach the browser bundle.
 */

import type { IAgentClientToolConfig } from '@/lib/database/provider/types.domain';

export const CLIENT_TOOLS_MAX_COUNT = 20;
export const CLIENT_TOOL_DESCRIPTION_MAX = 1000;
export const CLIENT_TOOL_TIMEOUT_MAX = 600;
export const CLIENT_TOOL_TIMEOUT_DEFAULT = 60;
const SCHEMA_MAX_BYTES = 16 * 1024;
const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

export type ApprovalChoice = 'inherit' | 'always' | 'never';

export function addTool(list: IAgentClientToolConfig[] | undefined): IAgentClientToolConfig[] {
    const current = list ?? [];
    if (current.length >= CLIENT_TOOLS_MAX_COUNT) return current;
    return [...current, { name: '', description: '' }];
}

export function updateTool(
    list: IAgentClientToolConfig[] | undefined,
    index: number,
    patch: Partial<IAgentClientToolConfig>,
): IAgentClientToolConfig[] {
    const current = list ?? [];
    if (index < 0 || index >= current.length) return current;
    return current.map((tool, i) => {
        if (i !== index) return tool;
        const next = { ...tool, ...patch } as Record<string, unknown>;
        // An explicit `undefined` in the patch clears the field.
        for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
        return next as unknown as IAgentClientToolConfig;
    });
}

export function removeTool(list: IAgentClientToolConfig[] | undefined, index: number): IAgentClientToolConfig[] {
    return (list ?? []).filter((_, i) => i !== index);
}

/** What goes into `config.clientTools` on save: an empty list is "none declared" (absent). */
export function normalizeClientTools(list: IAgentClientToolConfig[] | undefined): IAgentClientToolConfig[] | undefined {
    return list && list.length > 0 ? list : undefined;
}

export function approvalChoice(tool: Pick<IAgentClientToolConfig, 'needsApproval'>): ApprovalChoice {
    return tool.needsApproval === true ? 'always' : tool.needsApproval === false ? 'never' : 'inherit';
}

export function approvalFromChoice(choice: ApprovalChoice): boolean | undefined {
    return choice === 'always' ? true : choice === 'never' ? false : undefined;
}

export type ParsedSchema =
    | { ok: true; schema: Record<string, unknown> | undefined }
    | { ok: false; message: string };

/** Empty text = no schema (any object). Otherwise it must be a JSON object with type "object" (or no type). */
export function parseSchemaText(text: string): ParsedSchema {
    const trimmed = text.trim();
    if (!trimmed) return { ok: true, schema: undefined };
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Invalid JSON' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, message: 'The schema must be a JSON object.' };
    }
    const schema = parsed as Record<string, unknown>;
    if (schema.type !== undefined && schema.type !== 'object') {
        return { ok: false, message: 'The arguments are always an object: use type "object".' };
    }
    if (new TextEncoder().encode(JSON.stringify(schema)).length > SCHEMA_MAX_BYTES) {
        return { ok: false, message: `The schema must be at most ${SCHEMA_MAX_BYTES / 1024} KB.` };
    }
    return { ok: true, schema };
}

export function schemaToText(schema: Record<string, unknown> | undefined): string {
    return schema ? JSON.stringify(schema, null, 2) : '';
}

export type ClientToolFieldError = 'name' | 'nameDuplicate' | 'description' | 'descriptionTooLong' | 'timeout';

/** Per-tool field problems, by index; an empty object means the list would save. */
export function clientToolErrors(list: IAgentClientToolConfig[] | undefined): Record<number, ClientToolFieldError[]> {
    const result: Record<number, ClientToolFieldError[]> = {};
    const seen = new Set<string>();
    (list ?? []).forEach((tool, index) => {
        const errors: ClientToolFieldError[] = [];
        const name = (tool.name ?? '').trim();
        if (!TOOL_NAME.test(name)) errors.push('name');
        else if (seen.has(name)) errors.push('nameDuplicate');
        else seen.add(name);
        const description = (tool.description ?? '').trim();
        if (!description) errors.push('description');
        else if (description.length > CLIENT_TOOL_DESCRIPTION_MAX) errors.push('descriptionTooLong');
        if (tool.timeoutSeconds !== undefined
            && (!Number.isInteger(tool.timeoutSeconds) || tool.timeoutSeconds < 1 || tool.timeoutSeconds > CLIENT_TOOL_TIMEOUT_MAX)) {
            errors.push('timeout');
        }
        if (errors.length > 0) result[index] = errors;
    });
    return result;
}
