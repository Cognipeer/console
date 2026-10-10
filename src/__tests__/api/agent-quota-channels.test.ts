/**
 * An agent run refused by a quota (domain `agent`) reads like every other quota
 * refusal, whichever channel the caller came through: HTTP 429 and an error of
 * type `rate_limit_error` on the REST channels, the same type and code carried
 * in the JSON-RPC error of A2A.
 *
 * Same boundary as agent-all-channels-e2e.test.ts: `executeAgentChat` is the one
 * mock, every channel is driven through its real Fastify route.
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

vi.mock('@/lib/database', async () => {
  const errors = await import('@/lib/database/provider/errors');
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
    AgentRunConflictError: errors.AgentRunConflictError,
    AgentRunIdempotencyKeyTakenError: errors.AgentRunIdempotencyKeyTakenError,
  };
});

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
import { createMockDb } from '../helpers/db.mock';
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

// Turns on an existing conversation hold its single active-run slot (a
// `mode: 'sync'` AgentRun reservation) for their whole duration.
const agentRunReservation = {
  create: vi.fn(async (record: Record<string, unknown>) => ({ _id: 'reservation-1', ...record })),
  remove: vi.fn(async () => true),
};

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

beforeEach(() => {
    vi.clearAllMocks();
    mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
    mockFn(getDatabase).mockResolvedValue(createMockDb({
        runWithTenant,
        createAgentRun: agentRunReservation.create,
        deleteAgentRun: agentRunReservation.remove,
    } as never));
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

// ── The quota refusal, per channel ───────────────────────────────────────

import { AgentQuotaExceededError } from '@/lib/services/agents/agentErrors';

const REFUSAL = 'Group rate limit exceeded for requests perDay (201/200)';

function refuseRuns() {
    const refusal = new AgentQuotaExceededError(REFUSAL);
    mockFn(agentsBarrel.executeAgentChat).mockRejectedValue(refusal);
    mockFn(agentServiceModule.executeAgentChat).mockRejectedValue(refusal);
}

/** What the model endpoints answer when a quota says no (quotaExceededPayload in client-inference.ts). */
const MODEL_ENDPOINT_QUOTA_ERROR = { message: expect.any(String), type: 'rate_limit_error' };

// The first import of each plugin pulls in a large module graph: on a busy machine that is well over the default 5 s.
const IMPORT_TIMEOUT_MS = 60_000;

describe('an agent run over its quota', () => {
    beforeEach(() => refuseRuns());

    it('Responses API: 429 with the rate_limit_error shape every quota refusal has', async () => {
        const { clientAgentsApiPlugin } = await import('@/server/api/plugins/client-agents');
        const app = await createFastifyApiTestApp(clientAgentsApiPlugin);
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/agents/responses',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', input: 'what is broken?' },
        });

        expect(res.statusCode).toBe(429);
        const { error } = parseJsonBody<{ error: Record<string, unknown> }>(res.body);
        expect(error).toMatchObject(MODEL_ENDPOINT_QUOTA_ERROR);
        expect(error).toEqual({ message: REFUSAL, type: 'rate_limit_error', code: 'agent_quota_exceeded' });
    }, IMPORT_TIMEOUT_MS);

    it('OpenAI chat/completions: the same 429 and error object', async () => {
        const { clientInferenceApiPlugin } = await import('@/server/api/plugins/client-inference');
        const app = await createFastifyApiTestApp(clientInferenceApiPlugin);
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/chat/completions',
            headers: { authorization: 'Bearer tok' },
            payload: { model: 'field-ops', messages: [{ role: 'user', content: 'hi' }] },
        });

        expect(res.statusCode).toBe(429);
        const { error } = parseJsonBody<{ error: Record<string, unknown> }>(res.body);
        expect(error).toMatchObject(MODEL_ENDPOINT_QUOTA_ERROR);
        expect(error.code).toBe('agent_quota_exceeded');
    }, IMPORT_TIMEOUT_MS);

    it('A2A: a JSON-RPC error that carries the type and the code', async () => {
        const { clientA2aApiPlugin } = await import('@/server/api/plugins/client-a2a');
        const app = await createFastifyApiTestApp(clientA2aApiPlugin);
        const res = await app.inject({
            method: 'POST',
            url: '/api/client/v1/a2a/field-ops',
            headers: { authorization: 'Bearer tok' },
            payload: {
                jsonrpc: '2.0',
                id: 9,
                method: 'message/send',
                params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
            },
        });

        const rpc = parseJsonBody<{ error: { message: string; data: Record<string, unknown> } }>(res.body);
        expect(rpc.error.message).toBe(REFUSAL);
        expect(rpc.error.data).toEqual({ type: 'rate_limit_error', code: 'agent_quota_exceeded' });
    }, IMPORT_TIMEOUT_MS);
});
