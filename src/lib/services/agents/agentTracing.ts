/**
 * Internal tracing of an agent turn: the trace session types, the sink that
 * records the SDK's events into the console's trace store, and the helpers
 * that reconcile and close a trace session.
 */

import type { AgentInvokeResult as AgentSdkInvokeResult, TraceSessionFile } from '@cognipeer/agent-sdk';
import { runWithTenantScope, type DatabaseProvider, type IAgentTracingEvent, type IAgentTracingSession } from '@/lib/database';
import { currentRestrictedKnowledgeTags, restrictedKnowledgeTagsOf } from '@/lib/services/rag/access';
import { currentTurnSignal } from '@/lib/core/turnSignal';
import { recordTracingSessionCreated } from '@/lib/services/agentTracing';
import { isTerminalSessionStatus, recordAgentSessionOutcome, recordTraceEventMetrics } from '@/lib/services/tracing/traceEntityMetrics';
import { countTraceErrors, deriveSessionStatus, isExplicitClientStatus } from '@/lib/shared/traceHealth';
import { buildToolDefinitionsSection, TOOL_DEFINITIONS_SECTION_KIND, type TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';
import { normalizeSectionListResponseFormat } from '@/lib/services/tracingResponseFormat';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';
import { isTruncatedFinishReason, normalizeFinishReason } from '@/lib/shared/finishReason';
import { nameSubagentOnApprovalStep } from './subagentEvents';
import { mergeContinuedSessionIdentity, readTraceContinuationMarker } from '@/lib/services/tracingContinuation';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

type InternalTraceEvent = TraceSessionFile['events'][number] & {
    toolName?: string;
    usage?: Record<string, unknown>;
    metadata?: Record<string, unknown> & { usage?: Record<string, unknown> };
    finishReason?: string;
    reasoningTokens?: number;
    sections?: unknown[];
    data?: { sections?: unknown[] };
    modelNames?: string[];
    bytesIn?: number | null;
    bytesOut?: number | null;
};

type InternalTraceSession = Omit<TraceSessionFile, 'events'> & {
    events: InternalTraceEvent[];
    metadata?: Record<string, string>;
};

/**
 * What the console knows of a run before its first trace event. The session
 * document opened on that event carries it until the SDK's own session file
 * (which says the same, and more) replaces it when the run ends.
 */
type InternalTraceSeed = {
    threadId?: string;
    agent?: { name?: string; version?: string; model?: string };
    metadata?: Record<string, string>;
};

/**
 * Reasoning ("thinking") models expose their chain-of-thought separately from the
 * final answer. A native provider puts it on the assistant message as
 * `reasoning.summary` (OpenAI-compatible `reasoning_content` / `reasoning`,
 * Anthropic thinking, Gemini thoughts, Bedrock reasoningContent all land there).
 * Pull the trace from the final assistant message so callers can surface it
 * alongside the answer. A turn saved before the native providers kept it on
 * `additional_kwargs.reasoning_content`; that is still read.
 */
export function extractAgentReasoning(result: AgentSdkInvokeResult): string | undefined {
    const messages = (result.messages ?? []) as Array<{
        role?: string;
        getType?: () => string;
        _getType?: () => string;
        reasoning?: { summary?: unknown };
        additional_kwargs?: Record<string, unknown>;
    }>;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        const type = msg?.role ?? msg?.getType?.() ?? msg?._getType?.();
        if (type && type !== 'assistant' && type !== 'ai') continue;
        const summary = msg?.reasoning?.summary;
        if (typeof summary === 'string' && summary.length > 0) return summary;
        const legacy = msg?.additional_kwargs?.['reasoning_content'];
        if (typeof legacy === 'string' && legacy.length > 0) return legacy;
        if (type) break;
    }
    return undefined;
}

/**
 * Reduces `runtimeContext` into the flat string map the trace session's own
 * `metadata` field accepts.
 *
 * These attribution tags are separate from prompt variables. They are what
 * lets a scheduled fire, a live API call, and a playground run show up
 * distinguishably in the existing Traces/Observability views instead of
 * needing a parallel "run" record: `?metadataKey=scheduleId&metadataValue=<id>`
 * on the tracing list finds every fire of one schedule, and
 * `schedule.lastConversationId` already equals the trace's `threadId`, so a
 * single fire is one click away without any new API surface.
 *
 * Deliberately narrow: `source` and `trigger`/`scheduleId`/`scheduleName` (the
 * fields the scheduler stamps into `metadata` for prompt variables) are worth
 * attribution — they are exactly what `?metadataKey=…&metadataValue=…` on the
 * tracing list is for. The rest of a caller's free-form metadata is left out;
 * it was sent for prompt rendering, not for a tracing filter, and object/array
 * values would need a shape decision this call site should not make silently.
 */
export function buildTracingMetadata(runtimeContext: AgentRuntimeContext | undefined): Record<string, string> | undefined {
    if (!runtimeContext) return undefined;
    const out: Record<string, string> = {};
    if (runtimeContext.source) out.source = runtimeContext.source;
    // An application's token acted for the person: the tags let the Traces views filter calls made on someone's behalf.
    if (runtimeContext.via) {
        out.via = runtimeContext.via.kind;
        out.viaIssuer = runtimeContext.via.issuer;
    }
    if (runtimeContext.trigger) {
        out.triggerId = runtimeContext.trigger.id;
        out.trigger = runtimeContext.trigger.type;
    }
    // A turn a flow step started: filter and group the traces by flow (`metadataKey=flowId`).
    if (runtimeContext.flow) {
        out.flowId = runtimeContext.flow.id;
        out.flowKey = runtimeContext.flow.key;
        out.flowName = runtimeContext.flow.name;
        out.flowRunId = runtimeContext.flow.runId;
        out.flowNodeKey = runtimeContext.flow.nodeKey;
    }
    const meta = runtimeContext.metadata;
    for (const key of ['trigger', 'scheduleId', 'scheduleName']) {
        const value = meta?.[key];
        if (typeof value === 'string' && value) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

// ── Internal Tracing Sink ────────────────────────────────────────────

/**
 * Raises a trace session's token totals to the turn's usage. The SDK sums the
 * trace's own model-call events, which leave out the calls a sub-agent made
 * (they sit in the turn's usage ledger, tagged `subagent`, but add no trace
 * steps), so a turn that delegated would otherwise show less than it used.
 * Totals only grow here: a session already at or above the turn's usage is kept.
 */
export async function reconcileTraceTotals(
    tenantDbName: string,
    projectId: string,
    sessionId: string | undefined,
    usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined,
): Promise<void> {
    if (!sessionId || !usage) return;
    try {
        await runWithTenantScope(tenantDbName, async (db) => {
            const session = await db.findAgentTracingSessionById(sessionId, projectId);
            if (!session) return;
            const patch: Partial<IAgentTracingSession> = {};
            const fields = [
                ['totalInputTokens', usage.inputTokens],
                ['totalOutputTokens', usage.outputTokens],
                ['totalCachedInputTokens', usage.cachedInputTokens],
            ] as const;
            for (const [field, value] of fields) {
                if (typeof value === 'number' && Number.isFinite(value) && value > (session[field] ?? 0)) patch[field] = Math.ceil(value);
            }
            if (Object.keys(patch).length === 0) return;
            await db.updateAgentTracingSession(sessionId, patch, projectId);
        });
    } catch (error) {
        logger.warn('Could not reconcile the trace totals with the turn usage', { sessionId, error: String(error) });
    }
}

/**
 * Marks a trace session failed for a reason the SDK could not know: it closed
 * the session as `paused`, but the console could not keep what the pause needs
 * (the state was too large to store), so the run is over. Without this the
 * session stays `paused` forever in the tracing views. Best-effort.
 */
export async function markTraceSessionFailed(
    tenantDbName: string,
    projectId: string,
    sessionId: string | undefined,
    detail: string,
): Promise<void> {
    if (!sessionId) return;
    try {
        await runWithTenantScope(tenantDbName, async (db) => {
            const session = await db.findAgentTracingSessionById(sessionId, projectId);
            if (!session) return;
            await db.updateAgentTracingSession(sessionId, {
                status: 'error',
                statusExplicit: true,
                errors: [
                    ...(session.errors ?? []),
                    { eventId: 'console', type: 'session', message: detail, timestamp: new Date().toISOString() },
                ],
            }, projectId);
        });
    } catch (error) {
        logger.warn('Could not mark the trace session failed', { sessionId, error: String(error) });
    }
}

/**
 * Creates a customSink that saves trace sessions directly to the database,
 * bypassing the HTTP tracing endpoint and its API-token authentication.
 * This is used for internal agent executions (dashboard playground & client API chat).
 *
 * `toolDefinitions` is the tool menu bound for THIS invocation: every model-
 * call event ('ai_call') gets a `tool_definitions` section carrying it.
 * Capture is per event, never per session — the SDK binds one menu per
 * invoke, but a session/thread spans invocations whose menus can differ, so
 * each call must record the menu it actually saw.
 *
 * Exported so the ingest tests can drive `onSession` directly.
 */
export async function createInternalTracingSink(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    toolDefinitions?: TraceToolDefinition[],
    /** Stable key of the hosted agent, stamped into the session `metadata.agentKey` (the session's `agentName` is the display name). */
    agentKey?: string,
    /** Told the id of each session the sink saves, so the turn can reconcile its totals afterwards. */
    onSessionSaved?: (sessionId: string) => void,
    /** SDK approval / question id → the sub-agent it came from, learned from the child's forwarded events. */
    approvalSubagents: ReadonlyMap<string, string> = new Map(),
    /** What is known of the run before its first event; the session document opened on that event carries it. */
    seed?: InternalTraceSeed,
) {
    const { customSink } = await import('@cognipeer/agent-sdk');
    const toolDefinitionsSection = toolDefinitions && toolDefinitions.length > 0
        ? buildToolDefinitionsSection(toolDefinitions)
        : undefined;

    /**
     * The stored form of one SDK trace event — one mapping for an event written
     * as it happens and for one saved with the session, so a session is never
     * shaped two ways.
     */
    const buildEventDoc = (sessionId: string, event: InternalTraceEvent): Omit<IAgentTracingEvent, '_id' | 'createdAt'> => {
        let sections = (Array.isArray(event?.sections)
            ? event.sections
            : Array.isArray(event?.data?.sections)
                ? event.data.sections
                : []) as Array<Record<string, unknown>>;

        // Attach the bound tool menu to each model-call event
        // (skipped if the SDK ever emits its own section).
        if (
            toolDefinitionsSection
            && event.type === 'ai_call'
            && !sections.some((section) => section?.kind === TOOL_DEFINITIONS_SECTION_KIND)
        ) {
            sections = [...sections, toolDefinitionsSection];
        }
        // Same cap/shape treatment the HTTP ingest gives an SDK
        // sender's own sections. The two paths write to the same
        // collection and are read by the same UI, so a section
        // shaped one way here and another way there is a bug
        // waiting to be found by whoever reads a mixed session.
        sections = normalizeSectionListResponseFormat(sections);

        const usage = event?.usage || event?.metadata?.usage || {};
            const inputTokens = toOptionalNumber(
                event?.inputTokens ?? usage?.inputTokens ?? usage?.input_tokens,
            );
            const outputTokens = toOptionalNumber(
                event?.outputTokens ?? usage?.outputTokens ?? usage?.output_tokens,
            );
            const cachedInputTokens = toOptionalNumber(
                event?.cachedInputTokens ??
                usage?.cachedInputTokens ??
                usage?.cached_input_tokens ??
                usage?.cacheReadInputTokens ??
                usage?.cache_read_input_tokens,
            );
            // The write slice of the prompt. The SDK event's `usageBasis` is deliberately NOT
            // applied to any of these numbers: the gateway chat model hands the SDK the
            // console's canonical (inclusive) usage, so a hosted event already says it right.
            const cachedWriteTokens = toOptionalNumber(
                event?.cacheWriteTokens ??
                usage?.cachedWriteTokens ??
                usage?.cacheWriteTokens ??
                usage?.cache_write_tokens ??
                usage?.cache_creation_input_tokens,
            );
            const diagnostics = extractInternalTraceDiagnostics(event);
            // Strip the keys `extractInternalTraceDiagnostics` already
            // consumed so the same value never lands in both the
            // column and the metadata blob.
            const restMetadata = { ...(event.metadata ?? {}) } as Record<string, unknown>;
            delete restMetadata.finishReason;
            delete restMetadata.stop_reason;
            delete restMetadata.reasoningTokens;

        const named = nameSubagentOnApprovalStep(
            { type: event.type, label: event.label, sequence: event.sequence, metadata: restMetadata, sections },
            approvalSubagents,
        );
        const eventDoc: Omit<IAgentTracingEvent, '_id' | 'createdAt'> = {
            sessionId,
            traceId: event.traceId ?? undefined,
            spanId: event.spanId ?? undefined,
            parentSpanId: event.parentSpanId ?? undefined,
            tenantId,
            projectId,
            id: event.id ?? undefined,
            type: event.type ?? undefined,
            label: named.label ?? undefined,
            sequence: event.sequence ?? 0,
            timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
            status: event.status ?? undefined,
            actor: event.actor ?? {},
            // `finishReason` / `reasoningTokens` are real columns now
            // (see `extractInternalTraceDiagnostics`), mirroring the
            // HTTP ingest's sibling `extractTraceDiagnostics`
            // (client-tracing.ts). Without this an agent hosted BY
            // the console would be the only source missing them,
            // which is the worst place for a gap: it is the path we
            // control end to end.
            metadata: named.metadata,
            sections,
            modelNames: event.modelNames ?? [],
            model: event.model ?? undefined,
            error: event.error ?? undefined,
            durationMs: event.durationMs ?? undefined,
            actorName: event.actor?.name ?? undefined,
            actorRole: event.actor?.role ?? event.actor?.scope ?? undefined,
            toolName:
                event.toolName ??
                (event.actor?.scope === 'tool' ? event.actor?.name : undefined),
            toolExecutionId: event.toolExecutionId ?? undefined,
            inputTokens,
            outputTokens,
            cachedInputTokens,
            // Only a positive count: a null would land in Mongo for every call without a cache write.
            ...(cachedWriteTokens ? { cachedWriteTokens } : {}),
            totalTokens: event.totalTokens ?? undefined,
            finishReason: diagnostics.finishReason,
            reasoningTokens: diagnostics.reasoningTokens,
            bytesIn: event.bytesIn ?? undefined,
            bytesOut: event.bytesOut ?? undefined,
            requestBytes: event.requestBytes ?? undefined,
            responseBytes: event.responseBytes ?? undefined,
        };

        return eventDoc;
    };

    // ── Streaming ───────────────────────────────────────────────────────────
    // The SDK records every event through `onEvent` as it happens (without awaiting it) and hands the
    // whole session to `onSession` when the run ends. Writing each event as it arrives means a run that
    // is cut off (a pod restart, an OOM kill, a timeout) leaves its trace up to that point — the stale
    // session finalizer closes it as 'abandoned' — and the session is readable while the run is going.
    // Writes are serialized per session, and `onSession` waits for them before it decides what is left
    // to insert, so a streamed event is never stored twice and a streamed write that failed is made up
    // for at the end. The document is built inside the chain, not when the SDK calls: the sub-agent an
    // approval came from is learned from an SDK event that follows the trace record in the same tick.
    type SessionStream = { chain: Promise<void>; opened: boolean; written: number; warned: boolean };
    const streams = new Map<string, SessionStream>();

    /** The session document a streamed run is read through until the SDK's own session file replaces it. */
    const openStreamedSession = async (db: DatabaseProvider, sessionId: string, event: InternalTraceEvent): Promise<void> => {
        const existing = await db.findAgentTracingSessionById(sessionId, projectId);
        if (existing) {
            // A later part of a run that paused: it is running again.
            if (existing.status === 'paused') {
                await db.updateAgentTracingSession(sessionId, { status: 'in_progress', statusExplicit: false }, projectId);
            }
            return;
        }
        const metadata: Record<string, string> = { ...(seed?.metadata ?? {}), ...(agentKey ? { agentKey } : {}) };
        const attribution = recordTracingSessionCreated({ tenantDbName, tenantId, projectId, agentName: seed?.agent?.name, metadata });
        await db.createAgentTracingSession({
            sessionId,
            traceId: event.traceId ?? undefined,
            ...(seed?.threadId ? { threadId: seed.threadId } : {}),
            tenantId,
            projectId,
            source: metadata.source === 'trigger' && typeof metadata.triggerId === 'string' ? 'trigger' : 'custom',
            agent: { ...(seed?.agent ?? {}) },
            agentName: seed?.agent?.name,
            agentVersion: seed?.agent?.version,
            agentModel: seed?.agent?.model,
            config: {},
            metadata,
            summary: {},
            status: 'in_progress',
            statusExplicit: false,
            startedAt: event.timestamp ? new Date(event.timestamp) : new Date(),
            errorEvents: 0,
            toolErrors: 0,
            aiErrors: 0,
            errors: [],
            modelsUsed: [],
            toolsUsed: [],
            eventCounts: {},
            totalEvents: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCachedInputTokens: 0,
            totalReasoningTokens: 0,
            truncatedEvents: 0,
            userId: attribution.userId,
            apiTokenId: attribution.apiTokenId,
            actorType: attribution.actorType,
        });
    };

    const writeStreamed = async (sessionId: string, event: InternalTraceEvent, stream: SessionStream): Promise<void> => {
        await runWithTenantScope(tenantDbName, async (db) => {
            if (!stream.opened) {
                await openStreamedSession(db, sessionId, event);
                stream.opened = true;
                onSessionSaved?.(sessionId);
            }
            const doc = buildEventDoc(sessionId, event);
            await db.createAgentTracingEvent(doc);
            stream.written += 1;
            const errorCounts = countTraceErrors([doc]);
            await db.applyAgentTracingSessionEvent(sessionId, {
                aiErrors: errorCounts.aiErrors,
                cachedInputTokens: doc.cachedInputTokens,
                durationMs: doc.durationMs,
                errorEvents: errorCounts.errorEvents,
                eventType: doc.type,
                finishReason: doc.finishReason,
                inputTokens: doc.inputTokens,
                modelsUsed: doc.model ? [doc.model] : [],
                outputTokens: doc.outputTokens,
                reasoningTokens: doc.reasoningTokens,
                toolErrors: errorCounts.toolErrors,
                toolsUsed: doc.toolName ? [doc.toolName] : [],
            }, projectId);
            // Hosted runs feed agent health only; the end-of-run booking knows these were counted here.
            await recordTraceEventMetrics({ tenantDbName, tenantId, projectId, agentName: seed?.metadata?.flowOwned === 'true' ? undefined : seed?.agent?.name, events: [doc], source: 'hosted' });
        });
    };

    const onEvent = (event: InternalTraceEvent): void => {
        const sessionId = typeof event?.sessionId === 'string' ? event.sessionId : '';
        if (!sessionId) return;
        let stream = streams.get(sessionId);
        if (!stream) {
            stream = { chain: Promise.resolve(), opened: false, written: 0, warned: false };
            streams.set(sessionId, stream);
        }
        const current = stream;
        current.chain = current.chain
            .then(() => writeStreamed(sessionId, event, current))
            .catch((error: unknown) => {
                if (current.warned) return;
                current.warned = true;
                logger.warn('Streaming a trace event failed; the session is completed when the run ends', {
                    sessionId,
                    sequence: event?.sequence,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
    };

    return customSink({
        onEvent,
        onSession: async (session: InternalTraceSession) => {
            try {
                await runWithTenantScope(tenantDbName, async (db) => {
                    // A run that paused (tool approval, question, client tool)
                    // and resumed sends its session in parts: the later parts
                    // carry only their own events and are APPENDED, while the
                    // session-level totals they carry already cover every part.
                    const continuation = readTraceContinuationMarker(session);
                    const existing = await db.findAgentTracingSessionById(session.sessionId, projectId);
                    const stream = streams.get(session.sessionId);
                    // Every streamed write lands before this save decides what is left to insert.
                    if (stream) await stream.chain;
                    const streamed = Boolean(stream && stream.written > 0);
                    // A later part of a paused run, and a session streamed while it ran, keep the events already
                    // stored and add the rest; any other save replaces what an earlier save of the session left.
                    const appending = Boolean(existing) && (Boolean(continuation) || streamed);
                    const stored = existing
                        ? await db.listAgentTracingEvents(session.sessionId, projectId, { projection: { sections: 0, metadata: 0 } })
                        : [];
                    const storedSequences = new Set(stored.map((event) => event.sequence));
                    const allEvents = Array.isArray(session.events) ? session.events : [];
                    // A retried part, or a streamed event, must not be inserted twice.
                    const events = appending
                        ? allEvents.filter((event) => !storedSequences.has(event?.sequence ?? 0))
                        : allEvents;
                    const eventDocs = events.map((event) => buildEventDoc(session.sessionId, event));

                    // Models and tools used, and the diagnostic rollups (`totalReasoningTokens` /
                    // `truncatedEvents`) that `applyAgentTracingSessionEvent` accumulates incrementally —
                    // taken here over the whole session: the stored events (earlier parts, streamed writes)
                    // and this save's own, read from the columns both carry.
                    const counted = appending ? [...stored, ...eventDocs] : eventDocs;
                    const modelsUsed = new Set<string>();
                    const toolsUsed = new Set<string>();
                    let totalReasoningTokens = 0;
                    let truncatedEvents = 0;
                    for (const doc of counted) {
                        if (doc.model) modelsUsed.add(doc.model);
                        if (doc.toolName) toolsUsed.add(doc.toolName);
                        const actorName = doc.actor?.scope === 'tool' ? doc.actor?.name : undefined;
                        if (typeof actorName === 'string' && actorName) toolsUsed.add(actorName);
                        if (typeof doc.reasoningTokens === 'number') totalReasoningTokens += doc.reasoningTokens;
                        if (isTruncatedFinishReason(doc.finishReason)) truncatedEvents += 1;
                    }
                    if (session?.agent?.model) modelsUsed.add(session.agent.model);

                    // Same health rule as the HTTP ingest: the SDK's own status stays authoritative; counters and a
                    // derived status fill in when it is absent. SDK sink failures are not run failures.
                    const errorCounts = countTraceErrors(counted);
                    const sessionErrors = session.errors ?? [];
                    const nonSinkErrors = sessionErrors.filter((error) => (error as Record<string, unknown> | null)?.type !== 'sink').length;
                    const sessionStatus = deriveSessionStatus({
                        clientStatus: session.status,
                        errorEvents: errorCounts.errorEvents,
                        nonSinkErrors,
                        ended: String(session.status ?? '').trim().toLowerCase() !== 'in_progress',
                    });
                    // A turn the caller stopped ends its session as the SDK sees an ordinary end ("success");
                    // the sink runs inside the invoke, so the turn's own signal says it was cancelled. A run
                    // that failed keeps its error. What the aborted model call used is only known when the
                    // gateway settled it (runUsage); the trace's token totals are the SDK's, so they may miss it.
                    const cancelledByCaller = currentTurnSignal()?.aborted === true
                        && sessionStatus !== 'error' && sessionStatus !== 'paused' && sessionStatus !== 'in_progress';
                    // What the traced work drew from documents not open to everyone (the sink runs inside the turn's
                    // exposure), with what an earlier part of the session already held.
                    const kbRestricted = restrictedKnowledgeTagsOf([...(existing?.kbRestricted ?? []), ...currentRestrictedKnowledgeTags()]);

                    const agentTriggerId = (session.metadata as Record<string, unknown> | undefined)?.source === 'trigger'
                        && typeof (session.metadata as Record<string, unknown>).triggerId === 'string';
                    const sessionDoc: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'> = {
                        sessionId: session.sessionId,
                        traceId: session.traceId,
                        rootSpanId: session.rootSpanId,
                        threadId: session.threadId,
                        tenantId,
                        projectId,
                        source: agentTriggerId ? 'trigger' : 'custom',
                        agent: session.agent ?? {},
                        agentName: session.agent?.name ?? undefined,
                        agentVersion: session.agent?.version ?? undefined,
                        agentModel: session.agent?.model ?? undefined,
                        config: session.config ?? {},
                        metadata: { ...(session.metadata ?? {}), ...(agentKey ? { agentKey } : {}) },
                        summary: session.summary ?? {},
                        status: cancelledByCaller ? 'cancelled' : sessionStatus,
                        // An SDK-supplied status is never overridden by a late error event (only a derived one is).
                        statusExplicit: cancelledByCaller || isExplicitClientStatus(session.status),
                        startedAt: session.startedAt ? new Date(session.startedAt) : new Date(),
                        endedAt: session.endedAt ? new Date(session.endedAt) : undefined,
                        durationMs: session.durationMs ?? undefined,
                        errorEvents: errorCounts.errorEvents,
                        toolErrors: errorCounts.toolErrors,
                        aiErrors: errorCounts.aiErrors,
                        errors: sessionErrors,
                        modelsUsed: Array.from(modelsUsed),
                        toolsUsed: Array.from(toolsUsed),
                        eventCounts: session.summary?.eventCounts ?? {},
                        totalEvents: counted.length,
                        totalInputTokens: session.summary?.totalInputTokens ?? 0,
                        totalOutputTokens: session.summary?.totalOutputTokens ?? 0,
                        totalCachedInputTokens: session.summary?.totalCachedInputTokens ?? 0,
                        totalReasoningTokens,
                        truncatedEvents,
                        totalBytesIn: session.summary?.totalBytesIn ?? undefined,
                        totalBytesOut: session.summary?.totalBytesOut ?? undefined,
                        ...(kbRestricted.length > 0 ? { kbRestricted } : {}),
                    };

                    // The counters above already cover the stored events; what carries over from an earlier
                    // part or from the streamed opening is the identity a later save may lack.
                    if (appending && existing) mergeContinuedSessionIdentity(sessionDoc, existing);

                    onSessionSaved?.(session.sessionId);
                    // Upsert session
                    if (existing) {
                        await db.updateAgentTracingSession(session.sessionId, sessionDoc, projectId);
                    } else {
                        const attribution = recordTracingSessionCreated({
                            tenantDbName,
                            tenantId,
                            projectId,
                            agentName: sessionDoc.agentName,
                            metadata: sessionDoc.metadata,
                        });
                        await db.createAgentTracingSession({
                            ...sessionDoc,
                            userId: attribution.userId,
                            apiTokenId: attribution.apiTokenId,
                            actorType: attribution.actorType,
                        });
                    }

                    // Replace the events — or, for a continued or streamed session, add what is not stored yet.
                    if (!appending) {
                        await db.deleteAgentTracingEvents(session.sessionId, projectId);
                    }
                    for (const eventDoc of eventDocs) {
                        await db.createAgentTracingEvent(eventDoc);
                    }
                    // What the health counters already hold for this part: a replaced save's previous events
                    // (subtracted below), or the events this part streamed, booked as they were written.
                    const partStart = continuation?.firstSequence ?? 0;
                    const partStored = appending ? stored.filter((doc) => (doc.sequence ?? 0) >= partStart) : [];
                    const bookedWhileStreaming = streamed && Boolean(seed?.agent?.name) && seed?.metadata?.flowOwned !== 'true';

                    // Hosted runs feed agent health only: their model and tool calls are counted where they execute.
                    await recordTraceEventMetrics({
                        tenantDbName,
                        tenantId,
                        projectId,
                        // A hidden agent a flow owns is not an agent of its own in the health views.
                        agentName: seed?.metadata?.flowOwned === 'true' ? undefined : sessionDoc.agentName,
                        events: appending ? [...partStored, ...eventDocs] : eventDocs,
                        previousEvents: appending ? (bookedWhileStreaming ? partStored : []) : stored,
                        source: 'hosted',
                    });
                    if (isTerminalSessionStatus(sessionDoc.status)) {
                        await recordAgentSessionOutcome({
                            tenantDbName,
                            tenantId,
                            projectId,
                            session: sessionDoc,
                            previousOutcome: existing?.metricsOutcome,
                            source: 'hosted',
                            events: counted,
                        });
                    }

                    logger.info('Internal tracing session saved', {
                        sessionId: session.sessionId,
                        agentName: session.agent?.name,
                        eventsCount: counted.length,
                        streamedEvents: stream?.written ?? 0,
                        insertedEvents: eventDocs.length,
                    });
                });
            } catch (err) {
                logger.error('Failed to save internal tracing session', { error: err });
            }
        },
    });
}

/**
 * Pull the SDK's top-level diagnostic fields off a raw trace event so they can
 * be persisted as real `finishReason` / `reasoningTokens` columns instead of
 * being buried in the `metadata` JSON blob.
 *
 * This is the internal-sink twin of the HTTP ingest's `extractTraceDiagnostics`
 * (`src/server/api/plugins/client-tracing.ts`) — both paths write to the same
 * `agentTracingEvents` table read by the same UI, so they must stay in
 * lockstep: a value read from `finishReason` here but from `metadata` there
 * (or vice versa) would make one trace source silently poorer than the other.
 *
 * `finishReason` explains a truncated answer (`length` is the usual cause of
 * unparseable JSON); `reasoningTokens` is a SUBSET of `outputTokens`, recorded
 * for attribution and deliberately never added to the bill.
 */
export function extractInternalTraceDiagnostics(event: InternalTraceEvent): {
    finishReason?: string;
    reasoningTokens?: number;
} {
    const metadata = event.metadata ?? {};
    const finishReason = normalizeFinishReason(
        event.finishReason ?? metadata.finishReason ?? metadata.stop_reason,
    );
    const reasoningTokens = toOptionalNumber(
        event.reasoningTokens
        ?? event.usage?.reasoningTokens
        ?? event.usage?.reasoning_tokens
        ?? metadata.reasoningTokens,
    );
    return {
        finishReason,
        reasoningTokens: reasoningTokens !== undefined && reasoningTokens > 0 ? reasoningTokens : undefined,
    };
}

    function toOptionalNumber(value: unknown): number | undefined {
        if (value === null || value === undefined || value === '') {
            return undefined;
        }

        const normalized = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(normalized) ? normalized : undefined;
    }
