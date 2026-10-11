/**
 * Client tools: tools that run in the page that embeds the chat.
 *
 * A host page (an intranet, a product) can let the agent read from it or act on
 * it — "what is selected?", "open this record" — without any server-side
 * connector. The embedding's admin DECLARES which tools exist (name,
 * description, input schema, timeout); only those are offered, and only on a
 * run that says it is embedded.
 *
 * How a call works (the same pause/resume as an approval or a question):
 *  1. The model calls the tool. Its executor does not run anything: it records a
 *     pending entry on the SDK state (`pendingUserQuestions`, marked
 *     `metadata.clientTool`) and the loop stops, exactly as the SDK's ask-user
 *     tool does. The console turns that entry into a `client_tool` pending
 *     action (`agentPendingActions.ts`).
 *  2. The chat surface hands the call to the host page and posts the page's
 *     answer to the resolve endpoint (`{ output }` or `{ error }`).
 *  3. The continuation applies the answer here ({@link resolveClientToolState})
 *     as the tool's result and the turn goes on. A page that never answers is
 *     resolved by the timeout sweep with an error result the model reads.
 *
 * Nothing in this module trusts the page: the output is size-checked, treated
 * as data for the model, and screened by the agent's `tool.post` guardrails.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SmartState as AgentSdkSmartState, ToolInterface as AgentSdkToolInterface } from '@cognipeer/agent-sdk';
import { toolInputSchemaToZod } from './agentRuntimeConfig';

/** What the model is told when the host page did not answer. */
export const CLIENT_TOOL_UNANSWERED_MESSAGE = 'The host page did not answer.';

/** The result of a client tool above this many bytes of JSON is refused. */
export const CLIENT_TOOL_OUTPUT_MAX_BYTES = 64 * 1024;
export const CLIENT_TOOL_ERROR_MAX_CHARS = 1_000;
export const CLIENT_TOOL_DEFAULT_TIMEOUT_SECONDS = 60;
export const CLIENT_TOOL_MAX_TIMEOUT_SECONDS = 600;
/** The server waits this much longer than the tool's timeout before it gives up on the page itself. */
export const CLIENT_TOOL_SERVER_GRACE_SECONDS = 15;
export const CLIENT_TOOL_MAX_COUNT = 20;
const SCHEMA_MAX_BYTES = 16 * 1024;
const DESCRIPTION_MAX_CHARS = 1_000;
const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

/** One tool the embedding page offers, as its admin declared it. */
export interface EmbeddedClientTool {
    /** The name the model calls; letters, digits and `_`, at most 64. */
    name: string;
    description: string;
    /** JSON Schema of the arguments (an object schema). Absent = an object with any properties. */
    inputSchema?: Record<string, unknown>;
    /** How long the page may take. Default 60, at most 600. */
    timeoutSeconds?: number;
    /** A person approves each call before it reaches the page. */
    needsApproval?: boolean;
}

/** "This run is embedded in a host page": the only thing that offers client tools. */
export interface EmbeddedRunContext {
    clientTools: EmbeddedClientTool[];
}

export type ClientToolsCheck =
    | { ok: true; tools: EmbeddedClientTool[] }
    | { ok: false; errors: Array<{ field: string; message: string }> };

/** Validates and normalises a declared list (an admin's save, or the list a host hands a run). */
export function checkEmbeddedClientTools(input: unknown, options: { reservedNames?: ReadonlySet<string> } = {}): ClientToolsCheck {
    if (input === undefined || input === null) return { ok: true, tools: [] };
    const errors: Array<{ field: string; message: string }> = [];
    if (!Array.isArray(input)) return { ok: false, errors: [{ field: 'clientTools', message: 'must be a list' }] };
    if (input.length > CLIENT_TOOL_MAX_COUNT) {
        errors.push({ field: 'clientTools', message: `at most ${CLIENT_TOOL_MAX_COUNT} tools` });
    }
    const tools: EmbeddedClientTool[] = [];
    const seen = new Set<string>();
    input.slice(0, CLIENT_TOOL_MAX_COUNT).forEach((raw, index) => {
        const field = `clientTools.${index}`;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            errors.push({ field, message: 'must be an object' });
            return;
        }
        const entry = raw as Record<string, unknown>;
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!TOOL_NAME.test(name)) {
            errors.push({ field: `${field}.name`, message: 'use letters, digits and _ (up to 64), starting with a letter or _' });
            return;
        }
        if (seen.has(name)) {
            errors.push({ field: `${field}.name`, message: `"${name}" is declared twice` });
            return;
        }
        if (options.reservedNames?.has(name)) {
            errors.push({ field: `${field}.name`, message: `"${name}" is already a tool of this agent` });
            return;
        }
        seen.add(name);
        const description = typeof entry.description === 'string' ? entry.description.trim() : '';
        if (!description) {
            errors.push({ field: `${field}.description`, message: 'Tell the model what the tool does' });
            return;
        }
        if (description.length > DESCRIPTION_MAX_CHARS) {
            errors.push({ field: `${field}.description`, message: `at most ${DESCRIPTION_MAX_CHARS} characters` });
            return;
        }
        let inputSchema: Record<string, unknown> | undefined;
        if (entry.inputSchema !== undefined && entry.inputSchema !== null) {
            if (typeof entry.inputSchema !== 'object' || Array.isArray(entry.inputSchema)) {
                errors.push({ field: `${field}.inputSchema`, message: 'must be a JSON Schema object' });
                return;
            }
            const schema = entry.inputSchema as Record<string, unknown>;
            if (schema.type !== undefined && schema.type !== 'object') {
                errors.push({ field: `${field}.inputSchema`, message: 'the arguments are always an object: use type "object"' });
                return;
            }
            let size = 0;
            try {
                size = Buffer.byteLength(JSON.stringify(schema), 'utf8');
            } catch {
                errors.push({ field: `${field}.inputSchema`, message: 'must be JSON' });
                return;
            }
            if (size > SCHEMA_MAX_BYTES) {
                errors.push({ field: `${field}.inputSchema`, message: `at most ${SCHEMA_MAX_BYTES / 1024} KB` });
                return;
            }
            inputSchema = schema;
        }
        let timeoutSeconds: number | undefined;
        if (entry.timeoutSeconds !== undefined && entry.timeoutSeconds !== null) {
            if (typeof entry.timeoutSeconds !== 'number' || !Number.isInteger(entry.timeoutSeconds)
                || entry.timeoutSeconds < 1 || entry.timeoutSeconds > CLIENT_TOOL_MAX_TIMEOUT_SECONDS) {
                errors.push({ field: `${field}.timeoutSeconds`, message: `a whole number of seconds, 1 to ${CLIENT_TOOL_MAX_TIMEOUT_SECONDS}` });
                return;
            }
            timeoutSeconds = entry.timeoutSeconds;
        }
        if (entry.needsApproval !== undefined && typeof entry.needsApproval !== 'boolean') {
            errors.push({ field: `${field}.needsApproval`, message: 'must be true or false' });
            return;
        }
        tools.push({
            name,
            description,
            ...(inputSchema ? { inputSchema } : {}),
            ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
            ...(entry.needsApproval === true ? { needsApproval: true } : {}),
        });
    });
    return errors.length > 0 ? { ok: false, errors } : { ok: true, tools };
}

export function clientToolTimeoutSeconds(tool: Pick<EmbeddedClientTool, 'timeoutSeconds'> | undefined): number {
    return tool?.timeoutSeconds ?? CLIENT_TOOL_DEFAULT_TIMEOUT_SECONDS;
}

/** The policy name of a client tool, as a `tool_access` guardrail sees it. */
export function clientToolPolicyName(name: string): string {
    return `agent.client.${name}`;
}

// ── The answer a page gives ─────────────────────────────────────────────

export type ClientToolAnswer =
    | { ok: true; output: unknown; error?: undefined }
    | { ok: false; message: string };

function jsonBytes(value: unknown): number | null {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
    } catch {
        return null;
    }
}

/**
 * Reads the body of a client tool's resolve call: `{ output }` (any JSON, at
 * most 64 KB) or `{ error }` (text — the page could not do it). The result is
 * the resolution to store, or the message of the 400.
 */
export function parseClientToolAnswer(body: Record<string, unknown>): { ok: true; resolution: { output?: unknown; error?: string; timedOut?: boolean } } | { ok: false; message: string } {
    const hasOutput = Object.prototype.hasOwnProperty.call(body, 'output') && body.output !== undefined;
    const hasError = body.error !== undefined && body.error !== null;
    if (!hasOutput && !hasError) return { ok: false, message: 'Send the tool\'s result as `output`, or `error` if the page could not do it' };
    if (hasError) {
        if (typeof body.error !== 'string' || body.error.trim() === '') return { ok: false, message: '`error` must be a non-empty string' };
        return {
            ok: true,
            resolution: {
                error: body.error.slice(0, CLIENT_TOOL_ERROR_MAX_CHARS),
                ...(body.timedOut === true ? { timedOut: true } : {}),
            },
        };
    }
    const bytes = jsonBytes(body.output);
    if (bytes === null) return { ok: false, message: '`output` must be JSON' };
    if (bytes > CLIENT_TOOL_OUTPUT_MAX_BYTES) {
        return { ok: false, message: `\`output\` is ${Math.ceil(bytes / 1024)} KB; the most a tool may return is ${CLIENT_TOOL_OUTPUT_MAX_BYTES / 1024} KB` };
    }
    return { ok: true, resolution: { output: body.output } };
}

/** A short digest of a value: enough to tell two calls apart in an audit trail, nothing of the content. */
export function digestForAudit(value: unknown): { sha256: string; bytes: number } {
    let text = '';
    try {
        text = JSON.stringify(value) ?? '';
    } catch {
        text = '';
    }
    return { sha256: createHash('sha256').update(text).digest('hex').slice(0, 16), bytes: Buffer.byteLength(text, 'utf8') };
}

// ── The tool the model sees ─────────────────────────────────────────────

/** The part of the tool guard this module needs (see `createAgentToolGuard`). */
export interface ClientToolGuard {
    protect<A extends Record<string, unknown>, R>(
        spec: { name: string; requestedName: string },
        execute: (safeArgs: A) => Promise<R>,
    ): (args: A) => Promise<R | string>;
}

type CreateToolFn = typeof import('@cognipeer/agent-sdk').createTool;

export interface BuiltClientTools {
    tools: AgentSdkToolInterface[];
    definitions: Array<{ name: string; description: string; parameters?: Record<string, unknown> }>;
}

/** What a client tool leaves on the SDK state while it waits for the page. */
export interface ClientToolPendingMeta {
    name: string;
    args: unknown;
    timeoutSeconds: number;
}

/** Is this SDK pending entry a client tool call waiting for its page? */
export function clientToolMeta(entry: { metadata?: Record<string, unknown> } | undefined | null): ClientToolPendingMeta | null {
    const meta = entry?.metadata?.clientTool as Partial<ClientToolPendingMeta> | undefined;
    return meta && typeof meta.name === 'string'
        ? { name: meta.name, args: meta.args, timeoutSeconds: typeof meta.timeoutSeconds === 'number' ? meta.timeoutSeconds : CLIENT_TOOL_DEFAULT_TIMEOUT_SECONDS }
        : null;
}

/**
 * The SDK tools for the declared client tools. Each one's executor pauses the
 * run (see the module note) instead of doing anything; `tool.pre` guardrails
 * screen the arguments BEFORE the page ever sees them.
 *
 * `needsApproval` is a function (never `true`): a tool the admin marked for
 * approval asks first (once per session if the person chose "remember"), and
 * any function value also makes the SDK run these tools one at a time, which
 * the shared pending-entry handle below needs.
 */
export function buildClientTools(input: {
    declared: readonly EmbeddedClientTool[];
    createToolFn: CreateToolFn;
    guard: ClientToolGuard;
    /** Tools the person already allowed for this session ("remember"). */
    allowedTools: ReadonlySet<string>;
}): BuiltClientTools {
    const tools: AgentSdkToolInterface[] = [];
    const definitions: BuiltClientTools['definitions'] = [];
    for (const spec of input.declared) {
        const timeoutSeconds = clientToolTimeoutSeconds(spec);
        const stateRef: Record<string, unknown> = {};
        const pause = async (args: Record<string, unknown>) => {
            const ref = stateRef as {
                ctx?: Record<string, unknown>;
                pendingUserQuestions?: Array<Record<string, unknown>>;
                __currentToolCallId?: string;
            };
            if (!ref.ctx) ref.ctx = {};
            if (!ref.pendingUserQuestions) ref.pendingUserQuestions = [];
            const toolCallId = ref.__currentToolCallId || `client_${randomUUID().slice(0, 8)}`;
            const entry = {
                id: randomUUID().replace(/-/g, '').slice(0, 21),
                toolCallId,
                toolName: spec.name,
                questions: [],
                status: 'pending',
                requestedAt: new Date().toISOString(),
                metadata: { clientTool: { name: spec.name, args, timeoutSeconds } satisfies ClientToolPendingMeta },
            };
            ref.pendingUserQuestions.push(entry);
            ref.ctx.__awaitingUserQuestion = { id: entry.id, toolCallId, requestedAt: entry.requestedAt };
            ref.ctx.__resumeStage = 'tools';
            return { __awaitingUserQuestion: true, id: entry.id, toolCallId };
        };
        const tool = input.createToolFn({
            name: spec.name,
            description: spec.description,
            schema: toolInputSchemaToZod(spec.inputSchema),
            func: input.guard.protect(
                { name: clientToolPolicyName(spec.name), requestedName: spec.name },
                pause,
            ),
        }) as AgentSdkToolInterface & Record<string, unknown>;
        tool._stateRef = stateRef;
        tool.__source = 'client-tool';
        tool.needsApproval = () => spec.needsApproval === true && !input.allowedTools.has(spec.name);
        tools.push(tool);
        definitions.push({
            name: spec.name,
            description: spec.description,
            ...(spec.inputSchema ? { parameters: spec.inputSchema } : {}),
        });
    }
    return { tools, definitions };
}

// ── Applying the answer ────────────────────────────────────────────────

export interface ClientToolResolutionInput {
    /** The SDK's own id of the pending entry. */
    sdkId: string;
    output?: unknown;
    error?: string;
    /** What the model reads: the output as text (already screened), or the error line. */
    content: string;
    durationMs?: number;
    answeredBy?: string;
}

/** The model-facing text of an answer: strings as they are, everything else as JSON. */
export function clientToolOutputText(output: unknown): string {
    if (typeof output === 'string') return output;
    try {
        return JSON.stringify(output) ?? 'null';
    } catch {
        return String(output);
    }
}

export function clientToolErrorText(message: string): string {
    return `Error executing tool: ${message}`;
}

/**
 * Applies a page's answer to the paused SDK state: the pending entry is
 * answered, the call gets its tool message and its step in the tool history,
 * and the loop is told where to carry on. The counterpart of the SDK's
 * `resolveUserQuestionState`, for an entry that is a tool call rather than a
 * question.
 */
export function resolveClientToolState(state: AgentSdkSmartState, answer: ClientToolResolutionInput): AgentSdkSmartState {
    const pending = (state.pendingUserQuestions ?? []).map((entry) => ({ ...entry }));
    const index = pending.findIndex((entry) => entry.id === answer.sdkId);
    if (index === -1) throw new Error(`Pending client tool call not found for id: ${answer.sdkId}`);
    const entry = pending[index];
    const meta = clientToolMeta(entry as { metadata?: Record<string, unknown> });
    if (!meta) throw new Error(`Pending entry ${answer.sdkId} is not a client tool call`);
    if (entry.status !== 'pending') throw new Error(`Client tool call ${entry.id} already resolved (status: ${entry.status}).`);
    const failed = answer.error !== undefined;
    pending[index] = {
        ...entry,
        status: 'answered',
        answeredAt: new Date().toISOString(),
        ...(answer.answeredBy ? { answeredBy: answer.answeredBy } : {}),
    };

    const messages = [
        ...(state.messages ?? []),
        { role: 'tool', name: meta.name, tool_call_id: entry.toolCallId, content: answer.content },
    ];
    const toolHistory = [
        ...(state.toolHistory ?? []),
        {
            executionId: randomUUID().replace(/-/g, '').slice(0, 21),
            toolName: meta.name,
            args: meta.args,
            // `output` is what the model read (a guardrail may have changed it); `rawOutput` is the page's own result.
            output: failed
                ? clientToolErrorText(answer.error!)
                : clientToolOutputText(answer.output) === answer.content ? answer.output : answer.content,
            rawOutput: failed ? null : answer.output,
            timestamp: new Date().toISOString(),
            tool_call_id: entry.toolCallId,
            summarized: false,
            retentionPolicy: 'keep_full',
            status: failed ? 'error' : 'success',
            ...(answer.durationMs !== undefined ? { durationMs: answer.durationMs } : {}),
        },
    ] as typeof state.toolHistory;

    const ctx = { ...(state.ctx ?? {}) } as Record<string, unknown>;
    delete ctx.__awaitingUserQuestion;
    ctx.__userQuestionResolved = { id: entry.id, status: 'answered' };
    // Calls of the same assistant message that never got to run still need the tools node.
    const stillOpen = openToolCallCount(messages);
    if (stillOpen > 0) ctx.__resumeStage = 'tools';
    else delete ctx.__resumeStage;

    return {
        ...state,
        pendingUserQuestions: pending,
        messages: messages as typeof state.messages,
        toolHistory,
        toolCallCount: (state.toolCallCount ?? 0) + 1,
        ctx: ctx as typeof state.ctx,
    };
}

/** Tool calls of the last assistant message that have no tool message yet. */
function openToolCallCount(messages: ReadonlyArray<Record<string, unknown>>): number {
    const answered = new Set<string>();
    for (const message of messages) {
        if (message.role === 'tool' && message.tool_call_id != null) answered.add(String(message.tool_call_id));
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message.role !== 'assistant') continue;
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<{ id?: unknown }> : [];
        return calls.filter((call) => call?.id == null || !answered.has(String(call.id))).length;
    }
    return 0;
}
