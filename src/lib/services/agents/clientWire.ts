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

/**
 * Keys whose value is somebody else's data (tool arguments, free-form answers): never re-keyed.
 * `directiveSources` is a record keyed by the text of a directive, so its keys are data too.
 */
const OPAQUE_KEYS = new Set(['args', 'answers', 'directiveSources', 'directive_sources']);

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
    subagent?: string;
    args?: unknown;
    questions?: unknown[];
    allow_free_text?: boolean;
    timeout_seconds?: number;
    status: string;
    expires_at?: string;
    requested_at?: string;
    /** `tool_approval`: why the call waits (`source`, the matched `exception`, a sentence in `text`). */
    reason?: { source: string; exception?: { field?: string; pattern: string }; text?: string };
}

/** What `toClientPendingAction` reads: the dashboard's `PublicPendingAction`, or the copy on a message. */
export interface PendingActionLike {
    id: string;
    kind: string;
    toolName?: string;
    subagent?: string;
    args?: unknown;
    questions?: unknown[];
    allowFreeText?: boolean;
    timeoutSeconds?: number;
    status: string;
    expiresAt?: string;
    requestedAt?: string;
    reason?: ClientPendingAction['reason'];
}

export function toClientPendingAction(action: PendingActionLike): ClientPendingAction {
    return {
        id: action.id,
        kind: action.kind,
        // A question is not a tool call: the stored `toolName` of one (the SDK's
        // ask-user tool) is an internal detail and stays off the wire.
        ...(action.toolName && action.kind !== 'user_question' ? { tool_name: action.toolName } : {}),
        ...(action.subagent ? { subagent: action.subagent } : {}),
        ...(action.args !== undefined ? { args: action.args } : {}),
        ...(action.questions ? { questions: toSnakeCaseDeep<unknown[]>(action.questions) } : {}),
        ...(action.allowFreeText !== undefined ? { allow_free_text: action.allowFreeText } : {}),
        ...(action.timeoutSeconds !== undefined ? { timeout_seconds: action.timeoutSeconds } : {}),
        status: action.status,
        ...(action.expiresAt ? { expires_at: action.expiresAt } : {}),
        ...(action.requestedAt ? { requested_at: action.requestedAt } : {}),
        ...(action.reason ? { reason: action.reason } : {}),
    };
}

// ── Session events ───────────────────────────────────────────────────────

/**
 * Log rows only the dashboard and the portal read: the plan and the sub-agents
 * of a turn are not part of the client API's event vocabulary, and a summarization
 * pass a sub-agent made of its own context is none of the session's.
 */
export function isClientSessionEvent(type: string, data: Record<string, unknown> | undefined): boolean {
    if (type === 'agent.plan' || type === 'agent.subagent') return false;
    if (type === 'agent.compaction' && data?.subagent !== undefined && data.subagent !== null) return false;
    return true;
}

/**
 * Fields the dashboard's session view adds to a row and a client never saw: which
 * sub-agent and delegation a tool call belongs to, and where a summarization pass
 * stands in the turn. Stripped so the client's rows keep the shape they were
 * documented with.
 */
const DASHBOARD_ONLY_FIELDS: Record<string, readonly string[]> = {
    'agent.tool_use': ['subagentId', 'parentToolCallId', 'parallel'],
    'agent.tool_result': ['subagentId', 'parentToolCallId', 'parallel'],
    'agent.compaction': ['id', 'index', 'afterToolCallId', 'trigger', 'compactedTools'],
};

/**
 * The `data` of a logged event for a client: keys snake_cased, tool arguments
 * left alone, and — as on a pending action — no `tool_name` for a question and
 * no `delegation_tool_call_id` (an internal link the portal uses). Pass the
 * event's `type` to also drop what only the dashboard reads (see above).
 */
export function toClientEventData(data: Record<string, unknown>, type?: string): Record<string, unknown> {
    const hidden = type ? DASHBOARD_ONLY_FIELDS[type] : undefined;
    const source = hidden ? Object.fromEntries(Object.entries(data).filter(([key]) => !hidden.includes(key))) : data;
    const wire = toSnakeCaseDeep<Record<string, unknown>>(source);
    if (data.kind === 'user_question') delete wire.tool_name;
    delete wire.delegation_tool_call_id;
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
        data: toClientEventData(frame.data, frame.type),
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

/** A file the agent produced (sandbox `/outputs/` or `session_files_create`), as a client sees it. */
export interface ClientOutputFile {
    id: string;
    name: string;
    mime_type: string;
    size: number;
    /** Relative to the server origin, `/api` included: the session file content route. */
    download_url: string;
}

/** Where a session file's bytes are served (the URL every client surface and the agent's tools report). */
export function sessionFileDownloadUrl(conversationId: string, fileId: string): string {
    return `/api/client/v1/agents/sessions/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}/content`;
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
            download_url: sessionFileDownloadUrl(conversationId, file.fileId),
        }));
}

export function toFileAnnotations(files: ReadonlyArray<ClientOutputFile>): ClientFileAnnotation[] {
    return files.map((file) => ({ type: 'file_path', file_id: file.id, filename: file.name }));
}

/** Data of the `agent.output_file` session event (the client wire snake-cases it). */
export function outputFileEventData(file: ClientOutputFile): Record<string, unknown> {
    return { fileId: file.id, name: file.name, mimeType: file.mime_type, size: file.size, downloadUrl: file.download_url };
}

/** A file attached to a transcript message, as a client sees it (uploads and agent outputs alike). */
export interface ClientMessageAttachment extends ClientOutputFile {
    /** `agent_output` for a file the agent produced; `user_upload` for one the person attached. */
    origin: 'agent_output' | 'user_upload';
}

export function toClientMessageAttachments(
    conversationId: string,
    attachments: ReadonlyArray<OutputAttachmentLike> | undefined,
): ClientMessageAttachment[] {
    return (attachments ?? []).map((file) => ({
        id: file.fileId,
        name: file.name,
        mime_type: file.mimeType,
        size: file.size,
        origin: file.origin === 'agent_output' ? 'agent_output' : 'user_upload',
        download_url: sessionFileDownloadUrl(conversationId, file.fileId),
    }));
}

/** One transcript message for `GET .../sessions/{id}/messages`; files (`attachments`) keep their origin and download URL. */
export function toClientTranscriptMessage(
    conversationId: string,
    index: number,
    message: {
        role: string;
        content: string;
        timestamp: Date | string;
        attachments?: ReadonlyArray<OutputAttachmentLike>;
        warnings?: string[];
        metadata?: { origin?: string; reminder?: { runId: string; message: string; setAt?: string } };
    },
    id: string,
) {
    const files = toClientMessageAttachments(conversationId, message.attachments);
    const at = message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp);
    return {
        id,
        object: 'agent.session.message' as const,
        index,
        role: message.role,
        content: message.content,
        created_at: Number.isNaN(at.getTime()) ? null : at.toISOString(),
        attachments: files,
        ...(message.warnings?.length ? { warnings: message.warnings } : {}),
        ...(files.some((f) => f.origin === 'agent_output') ? { output_files: files.filter((f) => f.origin === 'agent_output') } : {}),
        // A reminder's wake turn: `content` is the note as the model read it; show `reminder.message`.
        ...(message.metadata?.origin === 'reminder' && message.metadata.reminder
            ? {
                origin: 'reminder' as const,
                reminder: { id: message.metadata.reminder.runId, message: message.metadata.reminder.message, set_at: message.metadata.reminder.setAt ?? null },
            }
            : {}),
    };
}
