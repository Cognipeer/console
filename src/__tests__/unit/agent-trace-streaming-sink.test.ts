/**
 * The hosted agent's trace sink streams: every event is stored as the SDK
 * records it, so a run is readable while it runs and a run that is cut off
 * leaves its trace behind; the end-of-run save then completes the session
 * without storing an event twice.
 *
 * Background: a 12-minute prod run held its whole trace in memory until the
 * end. Nothing was visible while it ran, and a pod restart would have lost all
 * of it — the only record of what the run did and spent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Doc = Record<string, unknown>;

const hoisted = vi.hoisted(() => ({
    sessions: new Map<string, Doc>(),
    events: [] as Doc[],
    deletes: 0,
    applied: [] as Doc[],
    metrics: [] as Array<{ events: number[]; previous: number[]; agentName?: string }>,
    outcomes: [] as string[],
    failWritesOfSequence: new Set<number>(),
}));

vi.mock('@/lib/database', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/database')>();
    const num = (value: unknown) => (typeof value === 'number' ? value : 0);
    const db = {
        switchToTenant: vi.fn(async () => undefined),
        findAgentTracingSessionById: vi.fn(async (id: string) => hoisted.sessions.get(id) ?? null),
        listAgentTracingEvents: vi.fn(async (id: string) => hoisted.events
            .filter((event) => event.sessionId === id)
            .map(({ sections: _sections, metadata: _metadata, ...columns }) => columns)),
        createAgentTracingSession: vi.fn(async (doc: Doc) => { hoisted.sessions.set(String(doc.sessionId), { ...doc }); return doc; }),
        updateAgentTracingSession: vi.fn(async (id: string, patch: Doc) => {
            hoisted.sessions.set(id, { ...hoisted.sessions.get(id), ...patch });
            return hoisted.sessions.get(id);
        }),
        deleteAgentTracingEvents: vi.fn(async (id: string) => {
            const kept = hoisted.events.filter((event) => event.sessionId !== id);
            const removed = hoisted.events.length - kept.length;
            hoisted.events.splice(0, hoisted.events.length, ...kept);
            hoisted.deletes += 1;
            return removed;
        }),
        createAgentTracingEvent: vi.fn(async (doc: Doc) => {
            if (hoisted.failWritesOfSequence.has(doc.sequence as number)) {
                hoisted.failWritesOfSequence.delete(doc.sequence as number);
                throw new Error('database unavailable');
            }
            hoisted.events.push({ ...doc });
            return doc;
        }),
        applyAgentTracingSessionEvent: vi.fn(async (id: string, delta: Doc) => {
            hoisted.applied.push({ id, ...delta });
            const session = hoisted.sessions.get(id);
            if (!session) return;
            session.totalEvents = num(session.totalEvents) + 1;
            session.totalInputTokens = num(session.totalInputTokens) + num(delta.inputTokens);
            session.totalOutputTokens = num(session.totalOutputTokens) + num(delta.outputTokens);
            session.errorEvents = num(session.errorEvents) + num(delta.errorEvents);
            session.updatedAt = new Date();
        }),
    };
    return {
        ...actual,
        getDatabase: vi.fn(async () => db),
        runWithTenantScope: vi.fn(async (_tenant: string, fn: (db: unknown) => unknown) => fn(db)),
    };
});
vi.mock('@/lib/services/tracing/traceEntityMetrics', async (importActual) => ({
    ...(await importActual<typeof import('@/lib/services/tracing/traceEntityMetrics')>()),
    recordTraceEventMetrics: vi.fn(async (params: { events: Array<{ sequence?: number }>; previousEvents?: Array<{ sequence?: number }>; agentName?: string }) => {
        hoisted.metrics.push({
            events: params.events.map((event) => event.sequence ?? -1),
            previous: (params.previousEvents ?? []).map((event) => event.sequence ?? -1),
            agentName: params.agentName,
        });
    }),
    recordAgentSessionOutcome: vi.fn(async (params: { session: { status?: string } }) => { hoisted.outcomes.push(String(params.session.status)); }),
}));
vi.mock('@/lib/services/agentTracing', () => ({ recordTracingSessionCreated: vi.fn(() => ({ userId: 'user-1', actorType: 'user' })) }));

import { createInternalTracingSink } from '@/lib/services/agents/agentService';

type Sink = { onEvent: (event: unknown) => void; onSession: (session: unknown) => Promise<void> };

const SEED = { threadId: 'thread-1', agent: { name: 'Helper', version: '3', model: 'gpt-5' }, metadata: { source: 'chat' } };

function sinkFor(sessionId: string, approvalSubagents = new Map<string, string>()) {
    const saved: string[] = [];
    const make = async () => (await createInternalTracingSink('tenant-db', 'tenant-1', 'project-1', undefined, 'agent-1', (id) => saved.push(id), approvalSubagents, SEED)) as unknown as Sink;
    return { make, saved, sessionId };
}

const at = (sequence: number) => new Date(Date.UTC(2026, 9, 21, 10, 0, sequence)).toISOString();

function aiCall(sessionId: string, sequence: number, tokens: { input: number; output: number }) {
    return {
        sessionId, id: `ev-${sequence}`, sequence, type: 'ai_call', label: `Model call #${sequence}`, status: 'success', timestamp: at(sequence),
        model: 'gpt-5', actor: { scope: 'agent', name: 'Helper' }, durationMs: 1200,
        usage: { inputTokens: tokens.input, outputTokens: tokens.output },
    };
}

function toolCall(sessionId: string, sequence: number, failed = false) {
    return {
        sessionId, id: `ev-${sequence}`, sequence, type: 'tool_call', label: `search #${sequence}`, status: failed ? 'error' : 'success', timestamp: at(sequence),
        actor: { scope: 'tool', name: 'search' }, toolName: 'search', durationMs: 300,
        ...(failed ? { error: { message: 'upstream 502' } } : {}),
    };
}

function sessionFile(sessionId: string, events: unknown[], extra: Doc = {}) {
    return {
        sessionId, traceId: 'trace-1', threadId: 'thread-1', startedAt: at(0), endedAt: at(9), durationMs: 9000,
        agent: { name: 'Helper', version: '3', model: 'gpt-5' }, metadata: { source: 'chat' }, config: {},
        summary: { totalInputTokens: 300, totalOutputTokens: 60, totalCachedInputTokens: 0, eventCounts: { ai_call: 2, tool_call: 2 } },
        status: 'success', errors: [], events, ...extra,
    };
}

const streamed = () => vi.waitFor(() => expect(hoisted.applied.length).toBeGreaterThan(0));
const streamedCount = (n: number) => vi.waitFor(() => expect(hoisted.applied).toHaveLength(n));

beforeEach(() => {
    hoisted.sessions.clear();
    hoisted.events.length = 0;
    hoisted.applied.length = 0;
    hoisted.metrics.length = 0;
    hoisted.outcomes.length = 0;
    hoisted.deletes = 0;
    hoisted.failWritesOfSequence.clear();
});

describe('a hosted run is traced while it runs', () => {
    it('opens the session on the first event, with what the console knows of the run, and stores every event as it happens', async () => {
        const { make, saved, sessionId } = sinkFor('s-live');
        const sink = await make();
        sink.onEvent(aiCall(sessionId, 1, { input: 100, output: 20 }));
        sink.onEvent(toolCall(sessionId, 2));
        sink.onEvent(aiCall(sessionId, 3, { input: 200, output: 40 }));
        await streamedCount(3);

        const session = hoisted.sessions.get(sessionId)!;
        expect(session).toMatchObject({
            status: 'in_progress', statusExplicit: false, source: 'custom',
            agentName: 'Helper', agentVersion: '3', agentModel: 'gpt-5', threadId: 'thread-1',
            metadata: { source: 'chat', agentKey: 'agent-1' },
            userId: 'user-1', actorType: 'user',
            totalEvents: 3, totalInputTokens: 300, totalOutputTokens: 60,
        });
        expect(saved).toEqual([sessionId]);
        expect(hoisted.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
        expect(hoisted.events[0]).toMatchObject({ sessionId, tenantId: 'tenant-1', projectId: 'project-1', type: 'ai_call', model: 'gpt-5', inputTokens: 100, outputTokens: 20 });
        expect(hoisted.events[1]).toMatchObject({ type: 'tool_call', toolName: 'search' });
        // Each event feeds the running totals and the agent's health as it lands.
        expect(hoisted.applied.map((delta) => delta.eventType)).toEqual(['ai_call', 'tool_call', 'ai_call']);
        expect(hoisted.metrics.map((call) => call.events)).toEqual([[1], [2], [3]]);
        expect(hoisted.metrics.every((call) => call.agentName === 'Helper')).toBe(true);
        // No end-of-run save yet: a run cut off here leaves exactly this behind, for the stale-session finalizer to close.
        expect(hoisted.outcomes).toEqual([]);
    });

    it('completes the session at the end without storing an event twice, deleting what was streamed, or booking it again', async () => {
        const { make, sessionId } = sinkFor('s-done');
        const sink = await make();
        const events = [aiCall(sessionId, 1, { input: 100, output: 20 }), toolCall(sessionId, 2, true), aiCall(sessionId, 3, { input: 200, output: 40 }), toolCall(sessionId, 4)];
        hoisted.failWritesOfSequence.add(2); // one streamed write fails: the run goes on, the save makes up for it
        for (const event of events) sink.onEvent(event);
        await streamedCount(3);
        expect(hoisted.events.map((event) => event.sequence)).toEqual([1, 3, 4]);

        await sink.onSession(sessionFile(sessionId, events));

        expect(hoisted.deletes).toBe(0);
        expect(hoisted.events.map((event) => event.sequence).sort()).toEqual([1, 2, 3, 4]);
        const session = hoisted.sessions.get(sessionId)!;
        expect(session).toMatchObject({
            status: 'success', totalEvents: 4, totalInputTokens: 300, totalOutputTokens: 60,
            errorEvents: 1, toolErrors: 1, aiErrors: 0, agentName: 'Helper', threadId: 'thread-1',
        });
        expect(session.modelsUsed).toEqual(['gpt-5']);
        expect(session.toolsUsed).toEqual(['search']);
        expect(session.endedAt).toBeInstanceOf(Date);
        // The final booking adds only the event the stream missed; what streamed was booked as it was written.
        const final = hoisted.metrics.at(-1)!;
        expect(final.events.sort()).toEqual([1, 2, 3, 4]);
        expect(final.previous.sort()).toEqual([1, 3, 4]);
        expect(hoisted.outcomes).toEqual(['success']);
    });

    it('names the sub-agent an approval came from, learned from the SDK event that follows the trace record', async () => {
        const approvalSubagents = new Map<string, string>();
        const { make, sessionId } = sinkFor('s-approval', approvalSubagents);
        const sink = await make();
        sink.onEvent({
            sessionId, id: 'ev-1', sequence: 1, type: 'tool_approval', label: 'Approval requested #1', status: 'pending', timestamp: at(1),
            actor: { scope: 'tool', name: 'sandbox_exec' }, sections: [{ kind: 'data', label: 'Approval ids', data: { approvalId: 'ap-1' } }],
        });
        approvalSubagents.set('ap-1', 'worker'); // the SDK's tool_approval event, same tick
        await streamed();
        expect(hoisted.events[0]).toMatchObject({ label: 'Approval requested (sub-agent worker) #1', metadata: { subagent: 'worker' } });
    });
});

describe('a run that paused and resumed', () => {
    it('shows as running again on the first event of the resumed part, and its save appends', async () => {
        const sessionId = 's-resumed';
        hoisted.sessions.set(sessionId, {
            sessionId, tenantId: 'tenant-1', projectId: 'project-1', status: 'paused', statusExplicit: true, agentName: 'Helper', threadId: 'thread-1',
            metadata: { source: 'chat', agentKey: 'agent-1', agentModelReason: 'routed' }, startedAt: new Date(at(0)), totalEvents: 2, userId: 'user-1',
        });
        hoisted.events.push(
            { sessionId, id: 'ev-1', sequence: 1, type: 'ai_call', label: 'Model call #1', status: 'success', model: 'gpt-5', timestamp: new Date(at(1)), inputTokens: 100, outputTokens: 20 },
            { sessionId, id: 'ev-2', sequence: 2, type: 'tool_approval', label: 'Approval requested #2', status: 'pending', timestamp: new Date(at(2)) },
        );
        const { make } = sinkFor(sessionId);
        const sink = await make();
        const part = [toolCall(sessionId, 3), aiCall(sessionId, 4, { input: 200, output: 40 })];
        sink.onEvent(part[0]);
        await streamed();
        expect(hoisted.sessions.get(sessionId)).toMatchObject({ status: 'in_progress', statusExplicit: false });
        sink.onEvent(part[1]);
        await streamedCount(2);

        await sink.onSession(sessionFile(sessionId, part, { continuation: { part: 2, firstSequence: 3 } }));

        expect(hoisted.deletes).toBe(0);
        expect(hoisted.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
        const session = hoisted.sessions.get(sessionId)!;
        expect(session).toMatchObject({ status: 'success', totalEvents: 4, startedAt: new Date(at(0)) });
        expect(session.modelsUsed).toEqual(['gpt-5']);
        expect(session.toolsUsed).toEqual(['search']);
        // Attribution from the first part survives the save of the second.
        expect(session.metadata).toMatchObject({ agentModelReason: 'routed', agentKey: 'agent-1' });
        // This part's events were booked as they streamed; the earlier part's are not touched.
        const final = hoisted.metrics.at(-1)!;
        expect(final.events.sort()).toEqual([3, 4]);
        expect(final.previous.sort()).toEqual([3, 4]);
    });
});

describe('a session that was not streamed', () => {
    it('is still saved the old way: its stored events are replaced and the difference is booked', async () => {
        const sessionId = 's-batch';
        hoisted.sessions.set(sessionId, { sessionId, tenantId: 'tenant-1', projectId: 'project-1', status: 'success', agentName: 'Helper', totalEvents: 1 });
        hoisted.events.push({ sessionId, id: 'ev-old', sequence: 1, type: 'ai_call', label: 'Model call #1', status: 'success', model: 'gpt-4', timestamp: new Date(at(1)) });
        const { make } = sinkFor(sessionId);
        const sink = await make();
        const events = [aiCall(sessionId, 1, { input: 100, output: 20 }), toolCall(sessionId, 2)];

        await sink.onSession(sessionFile(sessionId, events));

        expect(hoisted.deletes).toBe(1);
        expect(hoisted.events.map((event) => event.id)).toEqual(['ev-1', 'ev-2']);
        expect(hoisted.sessions.get(sessionId)).toMatchObject({ status: 'success', totalEvents: 2 });
        expect(hoisted.sessions.get(sessionId)!.modelsUsed).toEqual(['gpt-5']);
        const final = hoisted.metrics.at(-1)!;
        expect(final.events).toEqual([1, 2]);
        expect(final.previous).toEqual([1]);
    });
});
