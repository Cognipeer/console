/**
 * How the agent-runtime features spell themselves on the client API.
 *
 * The agent family under `/client/v1` (Responses, runs, sessions) is
 * snake_case (`stop_reason`, `required_action`, `conversation_id`). The
 * dashboard and the stored records are camelCase, so everything that crosses
 * to a client token goes through here: pending actions, the `data` of logged
 * events, the error fields, and the answer a client posts.
 *
 * Dashboard endpoints do not use any of this — they keep their own shape.
 */

import type { AgentRunErrorBody } from './agentErrors';

/** `toolCallId` → `tool_call_id`. Already-snake keys pass through. */
export function toSnakeKey(key: string): string {
    return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Keys whose value is somebody else's data (tool arguments, free-form answers): never re-keyed. */
const OPAQUE_KEYS = new Set(['args', 'answers']);

/** Every object key snake_cased, depth first; values of {@link OPAQUE_KEYS} are left as they are. */
export function toSnakeCaseDeep<T = unknown>(value: unknown): T {
    if (Array.isArray(value)) return value.map((item) => toSnakeCaseDeep(item)) as unknown as T;
    if (typeof value !== 'object' || value === null || value instanceof Date) return value as T;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        out[toSnakeKey(key)] = OPAQUE_KEYS.has(key) ? inner : toSnakeCaseDeep(inner);
    }
    return out as T;
}

/**
 * A run id as the API hands it out and takes it back: `run_<id>`. The store
 * (and the dashboard's own event frames) hold the bare id; a client joins an
 * event to `GET /agents/runs/{id}` on the prefixed one.
 */
export function toPublicRunId(runId: string): string {
    return runId.startsWith('run_') ? runId : `run_${runId}`;
}

// ── Pending actions ───────────────────────────────────────────────────────

/** An approval / question as a client sees it. */
export interface ClientPendingAction {
    id: string;
    kind: string;
    tool_name?: string;
    args?: unknown;
    questions?: unknown[];
    allow_free_text?: boolean;
    timeout_seconds?: number;
    status: string;
    expires_at?: string;
    requested_at?: string;
}

/** What `toClientPendingAction` reads: the dashboard's `PublicPendingAction`, or the copy on a message. */
export interface PendingActionLike {
    id: string;
    kind: string;
    toolName?: string;
    args?: unknown;
    questions?: unknown[];
    allowFreeText?: boolean;
    timeoutSeconds?: number;
    status: string;
    expiresAt?: string;
    requestedAt?: string;
}

export function toClientPendingAction(action: PendingActionLike): ClientPendingAction {
    return {
        id: action.id,
        kind: action.kind,
        // A question is not a tool call: the stored `toolName` of one (the SDK's
        // ask-user tool) is an internal detail and stays off the wire.
        ...(action.toolName && action.kind !== 'user_question' ? { tool_name: action.toolName } : {}),
        ...(action.args !== undefined ? { args: action.args } : {}),
        ...(action.questions ? { questions: toSnakeCaseDeep<unknown[]>(action.questions) } : {}),
        ...(action.allowFreeText !== undefined ? { allow_free_text: action.allowFreeText } : {}),
        ...(action.timeoutSeconds !== undefined ? { timeout_seconds: action.timeoutSeconds } : {}),
        status: action.status,
        ...(action.expiresAt ? { expires_at: action.expiresAt } : {}),
        ...(action.requestedAt ? { requested_at: action.requestedAt } : {}),
    };
}

// ── Session events ───────────────────────────────────────────────────────

/**
 * The `data` of a logged event for a client: keys snake_cased, tool arguments
 * left alone, and — as on a pending action — no `tool_name` for a question.
 */
export function toClientEventData(data: Record<string, unknown>): Record<string, unknown> {
    const wire = toSnakeCaseDeep<Record<string, unknown>>(data);
    if (data.kind === 'user_question') delete wire.tool_name;
    return wire;
}

/** A bus / replay frame (`runId`, `createdAt`) as the client stream carries it. */
export function toClientEventFrame(frame: {
    seq?: number;
    type: string;
    data: Record<string, unknown>;
    runId?: string;
    createdAt: string;
}) {
    return {
        ...(frame.seq !== undefined ? { seq: frame.seq } : {}),
        type: frame.type,
        data: toClientEventData(frame.data),
        ...(frame.runId ? { run_id: toPublicRunId(frame.runId) } : {}),
        created_at: frame.createdAt,
    };
}

// ── What a client posts ──────────────────────────────────────────────────

/**
 * The answer to an approval / question, as the service reads it. A client
 * spells it `approved_args` / `remember_for_session`; the camelCase names the
 * first drafts used are still accepted.
 */
export function normalizeClientResolveBody(body: Record<string, unknown>): Record<string, unknown> {
    const out = { ...body };
    if (out.approvedArgs === undefined && body.approved_args !== undefined) out.approvedArgs = body.approved_args;
    if (out.rememberForSession === undefined && body.remember_for_session !== undefined) {
        out.rememberForSession = body.remember_for_session;
    }
    delete out.approved_args;
    delete out.remember_for_session;
    return out;
}

// ── Errors ───────────────────────────────────────────────────────────────

/** An agent-run error body with its extra fields snake_cased (`pending_action_ids`, `spent_usd`, `max_cost_usd`). */
export function toClientErrorBody(error: AgentRunErrorBody): Record<string, unknown> {
    const { pendingActionIds, spentUsd, maxCostUsd, ...rest } = error;
    return {
        ...rest,
        ...(pendingActionIds !== undefined ? { pending_action_ids: pendingActionIds } : {}),
        ...(spentUsd !== undefined ? { spent_usd: spentUsd } : {}),
        ...(maxCostUsd !== undefined ? { max_cost_usd: maxCostUsd } : {}),
    };
}

// ── Files the agent produced ─────────────────────────────────────────────

/** A file the agent wrote to its sandbox's `/outputs/`, as a client sees it. */
export interface ClientOutputFile {
    id: string;
    name: string;
    mime_type: string;
    size: number;
    /** Relative to the API origin: the session file content route. */
    download_url: string;
}

/** An `output_text` annotation pointing at an output file (OpenAI `container_file_citation` / `file_path` compatible). */
export interface ClientFileAnnotation {
    type: 'file_path';
    file_id: string;
    filename: string;
}

interface OutputAttachmentLike {
    fileId: string;
    name: string;
    mimeType: string;
    size: number;
    origin?: string;
}

/** The `agent_output` attachments of an assistant message, as `output_files` (user uploads are not included). */
export function toClientOutputFiles(conversationId: string, attachments: ReadonlyArray<OutputAttachmentLike> | undefined): ClientOutputFile[] {
    return (attachments ?? [])
        .filter((file) => file.origin === 'agent_output')
        .map((file) => ({
            id: file.fileId,
            name: file.name,
            mime_type: file.mimeType,
            size: file.size,
            download_url: `/client/v1/agents/sessions/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(file.fileId)}/content`,
        }));
}

export function toFileAnnotations(files: ReadonlyArray<ClientOutputFile>): ClientFileAnnotation[] {
    return files.map((file) => ({ type: 'file_path', file_id: file.id, filename: file.name }));
}
