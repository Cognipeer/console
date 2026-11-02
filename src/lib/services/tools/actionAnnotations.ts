/**
 * What a tool action says about its effects, and the one rule that reads it.
 *
 * The markings are the MCP `ToolAnnotations` shape. Where they come from depends on the source: an MCP
 * server sends them in `tools/list`, an OpenAPI action gets `readOnlyHint` from its HTTP method, and a
 * managed tool carries what its owner set. Agent approval asks about every call that is not marked
 * read-only (`agentHumanInTheLoop.ts`), so a missing marking means "asks", never "does not ask".
 *
 * Pure and dependency-free (types only): the agent settings screen classifies a tool with the same code
 * the runtime runs.
 */

import type { IToolAction, IToolActionAnnotations } from '@/lib/database/provider/types.domain';

/** HTTP methods that only read. Everything else may change something. */
const READ_ONLY_HTTP_METHODS: readonly string[] = ['GET', 'HEAD'];

/** The kind of a tool as far as approval is concerned. */
export type ToolKind = 'reads' | 'writes' | 'destructive' | 'nohints';

export const TOOL_KINDS: readonly ToolKind[] = ['reads', 'writes', 'destructive', 'nohints'];

export function httpMethodReadsOnly(method: string | undefined): boolean {
    return READ_ONLY_HTTP_METHODS.includes((method ?? '').trim().toUpperCase());
}

/** Only the known markings, with the right types: whatever a server sent beyond them is dropped. */
export function sanitizeAnnotations(raw: unknown): IToolActionAnnotations | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const source = raw as Record<string, unknown>;
    const out: IToolActionAnnotations = {};
    if (typeof source.title === 'string' && source.title.trim()) out.title = source.title.trim().slice(0, 200);
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        if (typeof source[key] === 'boolean') out[key] = source[key];
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The markings of a tool on an MCP server as approval reads them: the operator's override (kept in the
 * server's metadata) over what the server sent, over the source's default (Console's internal servers only
 * read), and, when none of them says, the HTTP method of an operation proxied from an OpenAPI spec.
 */
export function mcpToolMarkings(
    tool: { annotations?: unknown; httpMethod?: string },
    override: unknown,
    sourceDefaults: unknown,
): IToolActionAnnotations {
    const marked: IToolActionAnnotations = {
        ...(sanitizeAnnotations(sourceDefaults) ?? {}),
        ...(sanitizeAnnotations(tool.annotations) ?? {}),
        ...(sanitizeAnnotations(override) ?? {}),
    };
    if (marked.readOnlyHint === undefined && tool.httpMethod) marked.readOnlyHint = httpMethodReadsOnly(tool.httpMethod);
    return marked;
}

/**
 * The markings of an action, with the method-derived `readOnlyHint` filled in for an HTTP action that has
 * none (records saved before the field existed read the same as new ones, no migration). A marking the
 * action carries is never overridden.
 */
export function effectiveActionAnnotations(
    action: Pick<IToolAction, 'executionType' | 'httpMethod' | 'annotations'>,
): IToolActionAnnotations {
    const own = sanitizeAnnotations(action.annotations) ?? {};
    if (own.readOnlyHint === undefined && action.executionType === 'openapi_http') {
        return { ...own, readOnlyHint: httpMethodReadsOnly(action.httpMethod) };
    }
    return own;
}

/** The markings an OpenAPI action is stored with at import. */
export function openApiActionAnnotations(method: string): IToolActionAnnotations {
    return { readOnlyHint: httpMethodReadsOnly(method) };
}

/**
 * Classifies a tool from its markings.
 *  - `readOnlyHint: true` -> reads;
 *  - not read-only and `destructiveHint: true` -> destructive;
 *  - `readOnlyHint: false` -> writes;
 *  - no `readOnlyHint` -> nohints (treated like writes: it asks).
 */
export function classifyAnnotations(annotations: IToolActionAnnotations | undefined): ToolKind {
    if (annotations?.readOnlyHint === true) return 'reads';
    if (annotations?.destructiveHint === true) return 'destructive';
    if (annotations?.readOnlyHint === false) return 'writes';
    return 'nohints';
}

export function isToolKind(value: unknown): value is ToolKind {
    return typeof value === 'string' && (TOOL_KINDS as readonly string[]).includes(value);
}
