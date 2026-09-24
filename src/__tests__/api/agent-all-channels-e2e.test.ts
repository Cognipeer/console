/**
 * One agent, reached through every channel that can reach it.
 *
 * The agent surface grew one channel at a time — Responses, Assistants, A2A,
 * the dashboard's own routes, and now OpenAI chat/completions — and each was
 * tested where it was written. That leaves the question nobody was asking:
 * does the SAME agent, with the same config, behave the same whichever door
 * you come through? A channel that quietly runs the draft instead of the
 * published version, drops the runtime context, or forgets to scope a
 * conversation to its project is not a broken route; it is a broken promise,
 * and it looks perfectly healthy from inside its own test file.
 *
 * So these tests mock ONE boundary — `executeAgentChat`, the single entry
 * point every channel delegates to — and drive each channel through its real
 * Fastify route, asserting both what comes back and what the runtime was
 * asked to do.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
    class ApiTokenAuthError extends Error {
        status: number;
        constructor(message: string, status = 401) {
            super(message);
            this.name = 'ApiTokenAuthError';
            this.status = status;
        }
    }
    return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/security/rbac', () => ({
    getPermissionServiceForPath: vi.fn(),
    authorizeServiceRequest: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

// The chat/completions route asks this first, to decide whether `model` names
// a model before it considers an agent. Returning null is "no such model",
// which is what lets the agent branch run at all.
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));

vi.mock('@/lib/services/agents/agentService', () => ({
    getAgentByKey: vi.fn(),
    executeAgentChat: vi.fn(),
    createConversation: vi.fn(),
    getConversationById: vi.fn(),
    executePlaygroundChatLocal: vi.fn(),
    AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {
        status = 403;
        reason = 'policy';
        guardrailKey = 'pii-redaction';
        hook = 'input.pre';
    },
}));

vi.mock('@/lib/services/agents', () => {
    const executeAgentChat = vi.fn();
    return {
        getAgentByKey: vi.fn(),
        executeAgentChat,
        createConversation: vi.fn(),
        getConversationById: vi.fn(),
        // The dashboard plugin pulls a wider slice of the barrel; every name it
        // imports has to exist here or the module fails to load.
        createAgentRecord: vi.fn(),
        deleteAgentRecord: vi.fn(),
        deleteConversation: vi.fn(),
        executePlaygroundChat: vi.fn(),
        getAgentById: vi.fn(),
        getAgentVersion: vi.fn(),
        listAgents: vi.fn(),
        listAgentVersions: vi.fn(),
        listConversations: vi.fn(),
        normalizeA2aMetadataUpdate: vi.fn(),
        prepareConnectionForStorage: vi.fn(),
        publishAgent: vi.fn(),
        updateAgentRecord: vi.fn(),
        // Background execution (docs/guide/agent-background-execution.md):
        // `runSyncAgentTurn` delegates to the SAME `executeAgentChat` mock
        // above so `runCalls()` (which reads `executeAgentChat.mock.calls`)
        // keeps observing exactly what each channel asked the runtime to do
        // — these tests are about the CHANNEL wiring, not the sync-ceiling
        // orchestration itself (covered by agent-run-sync-ceiling.test.ts).
        runSyncAgentTurn: vi.fn(async ({ request }: { request: unknown }) => ({
            kind: 'ok',
            response: await executeAgentChat(request),
        })),
        createBackgroundAgentRun: vi.fn(),
        getAgentRunStatus: vi.fn(),
        requestAgentRunCancellation: vi.fn(),
        isBackgroundModeRequested: vi.fn().mockReturnValue(false),
        agentRunConflictErrorBody: vi.fn(() => ({ error: { type: 'agent_run_conflict', message: 'conflict' } })),
        agentSyncTimeoutErrorBody: vi.fn(() => ({ error: { type: 'timeout', message: 'timed out' } })),
        idempotencyKeyRequiresBackgroundErrorBody: vi.fn(() => ({
            error: { type: 'invalid_request_error', message: 'Idempotency-Key requires background: true' },
        })),
    };
});

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { getPermissionServiceForPath, authorizeServiceRequest } from '@/lib/security/rbac';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

import { getModelByKey } from '@/lib/services/models/modelService';
import * as agentsBarrel from '@/lib/services/agents';
import * as agentServiceModule from '@/lib/services/agents/agentService';

const AUTH_CTX = {
    token: 'tok_abc',
    tokenRecord: { _id: 'tok-1', userId: 'user-1' },
    tenant: { licenseType: 'ENTERPRISE' },
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantDbName: 'tenant_acme',
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'user', tenantId: 'tenant-1' },
};

/** The same fully-configured agent every channel is pointed at. */
const AGENT = {
    _id: 'agent-1',
    key: 'field-ops',
    name: 'Field Ops',
    description: 'Answers operational questions from the runbooks.',
    status: 'active',
    publishedVersion: 4,
    tenantId: 'tenant-1',
    config: {
        modelKey: 'gpt-5-terra',
        systemPrompt: 'You help during an incident.',
        knowledgeEngineKey: 'runbooks',
        guardrails: [{ key: 'pii-redaction' }],
        toolBindings: [
            { source: 'tool', sourceKey: 'pagerduty', toolNames: ['list_incidents'] },
            { source: 'mcp', sourceKey: 'grafana', toolNames: ['query_range'] },
            { source: 'system', sourceKey: 'web_search', toolNames: ['web_search'] },
        ],
        runtime: { profile: 'deep', limits: { maxToolCalls: 25 } },
        skills: ['incident-comms'],
        memory: { enabled: true, memoryStoreKey: 'ops-memory', scope: 'user' },
    },
    metadata: { a2a: { enabled: true } },
};

const ANSWER = {
    id: 'resp-1',
    object: 'response',
    model: 'field-ops',
    status: 'completed',
    created_at: 1_700_000_000,
    previous_response_id: null,
    version: 4,
    output: [
        { id: 'r1', type: 'reasoning', content: [{ type: 'reasoning_text', text: 'checking the runbook' }] },
        { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The database is down.' }] },
    ],
    usage: { input_tokens: 1200, output_tokens: 42, total_tokens: 1242 },
    _conversation_messages: [{ role: 'user' }, { role: 'assistant' }],
};

const runWithTenant = vi.fn(<T>(_db: string, fn: () => T | Promise<T>) => fn());

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
    return fn as ReturnType<typeof vi.fn>;
}

/** Both the barrel and the module are mocked; channels import from either. */
function setAgentLookup(agent: unknown) {
    mockFn(agentsBarrel.getAgentByKey).mockResolvedValue(agent);
    mockFn(agentServiceModule.getAgentByKey).mockResolvedValue(agent);
}

function setRunResult(result: unknown) {
    mockFn(agentsBarrel.executeAgentChat).mockResolvedValue(result);
    mockFn(agentServiceModule.executeAgentChat).mockResolvedValue(result);
}

/** Makes the mocked run emit deltas through the caller's callback. */
function setRunResultStreaming(text: string) {
    const impl = async (request: { onTextChunk?: (chunk: string) => void }) => {
        for (const word of text.split(/(?<=\s)/)) request.onTextChunk?.(word);
        return ANSWER;
    };
    mockFn(agentsBarrel.executeAgentChat).mockImplementation(impl);
    mockFn(agentServiceModule.executeAgentChat).mockImplementation(impl);
}

function runCalls() {
    const fromBarrel = mockFn(agentsBarrel.executeAgentChat).mock.calls;
    return fromBarrel.length > 0
        ? fromBarrel
        : mockFn(agentServiceModule.executeAgentChat).mock.calls;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
    mockFn(getDatabase).mockResolvedValue({ runWithTenant });
    mockFn(getPermissionServiceForPath).mockReturnValue(null);
    mockFn(authorizeServiceRequest).mockReturnValue({ allowed: true });
    mockFn(getModelByKey).mockResolvedValue(null);
    setAgentLookup(AGENT);
    setRunResult(ANSWER);
    mockFn(agentsBarrel.createConversation).mockResolvedValue({ _id: 'conv-1' });
    mockFn(agentServiceModule.createConversation).mockResolvedValue({ _id: 'conv-1' });
    mockFn(agentsBarrel.getConversationById).mockResolvedValue({
        _id: 'conv-1', agentKey: AGENT.key, projectId: AUTH_CTX.projectId,
    });
    mockFn(agentServiceModule.getConversationById).mockResolvedValue({
        _id: 'conv-1', agentKey: AGENT.key, projectId: AUTH_CTX.projectId,
    });
});

// ── Channel: Responses API ───────────────────────────────────────────────

describe('channel: Responses API', () => {
    const build = async () => {
        const { clientAgentsApiPlugin } = await import('@/server/api/plugins/client-agents');
        return createFastifyApiTestApp(clientAgentsApiPlugin);
    };

    it('runs the agent and answers in the Responses shape', async () => {
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/agents/responses',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', input: 'what is broken?' },
        });

        expect(res.statusCode).toBe(200);
        const body = parseJsonBody<Record<string, unknown>>(res.body);
        expect(body.object).toBe('response');
        expect(body.version).toBe(4);
        // The dashboard-only transcript must not leak onto the API surface.
        expect(body._conversation_messages).toBeUndefined();
    });

    it('/agents/responses runs the PUBLISHED version, /responses does not', async () => {
        // Deliberately different defaults, and the kind of thing that silently
        // swaps if either handler is refactored in isolation.
        const app = await build();
        await app.inject({
            method: 'POST',
            url: '/api/client/v1/agents/responses',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', input: 'hi' },
        });
        expect(runCalls()[0][0].usePublished).toBe(true);

        vi.clearAllMocks();
        setAgentLookup(AGENT);
        setRunResult(ANSWER);
        mockFn(agentsBarrel.createConversation).mockResolvedValue({ _id: 'conv-1' });
        mockFn(agentServiceModule.createConversation).mockResolvedValue({ _id: 'conv-1' });
        mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);

        await app.inject({
            method: 'POST',
            url: '/api/client/v1/responses',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', input: 'hi' },
        });
        expect(runCalls()[0][0].usePublished).toBe(false);
    });

    it('refuses a draft agent rather than running it', async () => {
        setAgentLookup({ ...AGENT, status: 'draft' });
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/agents/responses',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', input: 'hi' },
        });
        expect(res.statusCode).toBe(400);
    });

    it('will not continue a conversation belonging to another agent', async () => {
        // Cross-tenant/-project history leak: the check exists, so it is
        // asserted rather than assumed.
        mockFn(agentsBarrel.getConversationById).mockResolvedValue({
            _id: 'conv-x', agentKey: 'someone-else', projectId: AUTH_CTX.projectId,
        });
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/agents/responses',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', input: 'hi', previous_response_id: 'resp_conv-x' },
        });
        expect(res.statusCode).toBe(404);
    });
});

// ── Channel: A2A ─────────────────────────────────────────────────────────

describe('channel: A2A', () => {
    const build = async () => {
        const { clientA2aApiPlugin } = await import('@/server/api/plugins/client-a2a');
        return createFastifyApiTestApp(clientA2aApiPlugin);
    };

    it('advertises the agent card with its bound tools as skills', async () => {
        const app = await build();
        const res = await app.inject({
            method: 'GET',
            url: '/api/client/v1/a2a/field-ops/.well-known/agent-card.json',
            headers: { authorization: 'Bearer tok', host: 'console.example.com', 'x-forwarded-proto': 'https' },
        });
        expect(res.statusCode).toBe(200);
        const card = parseJsonBody<Record<string, unknown>>(res.body);
        expect(card.name).toBe('Field Ops');
        expect(card.version).toBe('4');
        expect((card.skills as Array<{ tags: string[] }>)[0].tags).toContain('list_incidents');
    });

    it('runs the same agent over JSON-RPC and stamps the A2A source', async () => {
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/a2a/field-ops',
            headers: { authorization: 'Bearer tok' },
            payload: {
                jsonrpc: '2.0',
                id: 7,
                method: 'message/send',
                params: { message: { role: 'user', parts: [{ kind: 'text', text: 'what is broken?' }] } },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(runCalls()[0][0].agentKey).toBe('field-ops');
        expect(runCalls()[0][0].runtimeContext?.source).toBe('a2a');
    });

    it('hides an agent that was never exposed, as a 404 rather than a 403', async () => {
        // Same answer as a missing agent on purpose: whether a given agent
        // exists is not something an unexposed endpoint should confirm.
        setAgentLookup({ ...AGENT, metadata: {} });
        const app = await build();
        const res = await app.inject({
            method: 'GET',
            url: '/api/client/v1/a2a/field-ops/.well-known/agent-card.json',
            headers: { authorization: 'Bearer tok' },
        });
        expect(res.statusCode).toBe(404);
    });
});

// ── Channel: OpenAI chat/completions ─────────────────────────────────────

describe('channel: OpenAI chat/completions', () => {
    const build = async () => {
        const { clientInferenceApiPlugin } = await import('@/server/api/plugins/client-inference');
        return createFastifyApiTestApp(clientInferenceApiPlugin);
    };

    it('runs the agent and answers in the chat-completion shape', async () => {
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/chat/completions',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', messages: [{ role: 'user', content: 'what is broken?' }] },
        });

        expect(res.statusCode).toBe(200);
        const body = parseJsonBody<Record<string, unknown>>(res.body);
        expect(body.object).toBe('chat.completion');
        const choice = (body.choices as Array<Record<string, unknown>>)[0];
        expect((choice.message as { content: string }).content).toBe('The database is down.');
        // The reasoning item must not be pasted in front of the answer.
        expect((choice.message as { content: string }).content).not.toContain('checking the runbook');
        expect(choice.finish_reason).toBe('stop');
        // An agent is stateful, so the thread handle comes back.
        expect(body.conversation_id).toBe('conv-1');
        expect((body.usage as { total_tokens: number }).total_tokens).toBe(1242);
    });

    it('API traffic runs the published version', async () => {
        const app = await build();
        await app.inject({
            method: 'POST',
            url: '/api/client/v1/chat/completions',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', messages: [{ role: 'user', content: 'hi' }] },
        });
        // A draft saved mid-afternoon must not become what callers get.
        expect(runCalls()[0][0].usePublished).toBe(true);
    });

    it('sends only the last user turn, not the replayed transcript', async () => {
        const app = await build();
        await app.inject({
            method: 'POST',
            url: '/api/client/v1/chat/completions',
            headers: { authorization: 'Bearer tok' },
            payload: {
                model: 'field-ops',
                messages: [
                    { role: 'user', content: 'first' },
                    { role: 'assistant', content: 'answered' },
                    { role: 'user', content: 'second' },
                ],
            },
        });
        // The agent owns its history; replaying would duplicate every turn.
        expect(runCalls()[0][0].userMessage).toBe('second');
    });

    it('continues a named conversation instead of starting a new one', async () => {
        const app = await build();
        await app.inject({
            method: 'POST',
            url: '/api/client/v1/chat/completions',
            headers: { authorization: 'Bearer tok' },
            payload: {
                model: 'field-ops',
                messages: [{ role: 'user', content: 'and now?' }],
                conversation_id: 'conv-1',
            },
        });
        expect(runCalls()[0][0].conversationId).toBe('conv-1');
        expect(mockFn(agentsBarrel.createConversation)).not.toHaveBeenCalled();
    });

    it('streams deltas and terminates the stream properly', async () => {
        setRunResultStreaming('The database is down.');
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/chat/completions',
            headers: { authorization: 'Bearer tok' },
            payload: {
                model: 'field-ops',
                messages: [{ role: 'user', content: 'what is broken?' }],
                stream: true,
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        const chunks = res.body
            .split('\n\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6));

        expect(chunks[chunks.length - 1]).toBe('[DONE]');
        const parsed = chunks.slice(0, -1).map((chunk) => JSON.parse(chunk));
        expect(parsed[0].object).toBe('chat.completion.chunk');
        const text = parsed.map((c) => c.choices[0].delta.content ?? '').join('');
        expect(text).toBe('The database is down.');
        expect(parsed[parsed.length - 1].choices[0].finish_reason).toBe('stop');
    });

    it('still delivers the answer when the run could not stream', async () => {
        // A run routed to another node cannot carry the callback over the
        // queue. The caller asked for a stream and must still get the answer,
        // not an empty one followed by [DONE].
        setRunResult(ANSWER);
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/chat/completions',
            headers: { authorization: 'Bearer tok' },
            payload: {
                model: 'field-ops',
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
            },
        });
        expect(res.body).toContain('The database is down.');
        expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    });

    it('rejects a call with no user message', async () => {
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/chat/completions',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', messages: [{ role: 'assistant', content: 'hello' }] },
        });
        expect(res.statusCode).toBe(400);
    });

    it('leaves an inactive agent to the model path rather than running it', async () => {
        // Reaches the agent branch (no model by that name) and is still
        // refused: a draft must not start answering production traffic
        // because its key was typed into `model`.
        setAgentLookup({ ...AGENT, status: 'draft' });
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/chat/completions',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', messages: [{ role: 'user', content: 'hi' }] },
        });
        // Whatever the model path answers, the agent must NOT have run.
        expect(runCalls()).toHaveLength(0);
        expect(res.statusCode).not.toBe(200);
    });
});


// ── A run a limit stopped, on every channel ─────────────────────────────

describe('a run stopped by a limit reports why, on every channel', () => {
    const STOPPED = {
        ...ANSWER,
        status: 'incomplete',
        incomplete_details: { reason: 'max_duration' },
        stop_reason: 'limit',
        stop_detail: 'maxWallClockMs (60000ms) exceeded',
        output: [
            { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking the infra logs next…' }] },
        ],
    };

    it('Responses: status incomplete with incomplete_details', async () => {
        setRunResult(STOPPED);
        const { clientAgentsApiPlugin } = await import('@/server/api/plugins/client-agents');
        const app = await createFastifyApiTestApp(clientAgentsApiPlugin);
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/responses',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', input: 'dig deeper' },
        });
        const body = parseJsonBody<Record<string, unknown>>(res.body);
        expect(body.status).toBe('incomplete');
        expect(body.incomplete_details).toEqual({ reason: 'max_duration' });
        expect(body.stop_reason).toBe('limit');
    });

    it('chat/completions: finish_reason "length" plus the precise reason', async () => {
        setRunResult(STOPPED);
        const { clientInferenceApiPlugin } = await import('@/server/api/plugins/client-inference');
        const app = await createFastifyApiTestApp(clientInferenceApiPlugin);
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/chat/completions',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', messages: [{ role: 'user', content: 'dig deeper' }] },
        });
        const body = parseJsonBody<Record<string, unknown>>(res.body);
        const choice = (body.choices as Array<Record<string, unknown>>)[0];
        expect(choice.finish_reason).toBe('length');
        expect((choice.message as { content: string }).content).toBe('Checking the infra logs next…');
        expect(body.stop_reason).toBe('limit');
        expect(body.stop_detail).toMatch(/^maxWallClockMs/);
    });

    it('A2A: the task carries the stop reason in its status message and metadata', async () => {
        setRunResult(STOPPED);
        const { clientA2aApiPlugin } = await import('@/server/api/plugins/client-a2a');
        const app = await createFastifyApiTestApp(clientA2aApiPlugin);
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/a2a/field-ops',
            headers: { authorization: 'Bearer tok' },
            payload: {
                jsonrpc: '2.0',
                id: 1,
                method: 'message/send',
                params: { message: { role: 'user', parts: [{ kind: 'text', text: 'dig deeper' }] } },
            },
        });
        const task = parseJsonBody<{ result: Record<string, any> }>(res.body).result;
        expect(task.metadata).toEqual({ stopReason: 'limit', stopDetail: 'maxWallClockMs (60000ms) exceeded' });
        expect(task.status.message.parts[0].text).toContain('maxWallClockMs');
    });
});
