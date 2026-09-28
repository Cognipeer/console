/**
 * The Agent Studio dashboard routes: export / import, schedules, code export,
 * sessions and the skill library — over their real Fastify handlers.
 *
 * Each one is checked for the thing that would hurt if it regressed: an agent
 * outside the caller's project must 404 (never leak or mutate another
 * project's agent), bad input must be a 400 rather than a 500, and the happy
 * path must hand the service layer what the request asked for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
    return {
        ...actual,
        requireProjectContextForRequest: vi.fn(),
        sendProjectContextError: vi.fn().mockReturnValue(null),
    };
});

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/services/agents', () => ({
    createAgentRecord: vi.fn(),
    createConversation: vi.fn(),
    deleteAgentRecord: vi.fn(),
    deleteConversation: vi.fn(),
    executePlaygroundChat: vi.fn(),
    getAgentById: vi.fn(),
    getAgentVersion: vi.fn(),
    getConversationById: vi.fn(),
    listAgents: vi.fn(),
    listAgentVersions: vi.fn(),
    listConversations: vi.fn(),
    normalizeA2aMetadataUpdate: vi.fn(),
    prepareConnectionForStorage: vi.fn(),
    publishAgent: vi.fn(),
    updateAgentRecord: vi.fn(),
}));

vi.mock('@/lib/services/agents/agentService', () => ({
    executePlaygroundChatLocal: vi.fn(),
    checkAgentModel: vi.fn(),
    AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
}));

vi.mock('@/lib/services/agents/agentSandboxTools', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/agentSandboxTools')>();
    return { ...actual, resolveSandboxAvailability: vi.fn() };
});

vi.mock('@/lib/services/agents/agentConfigValidation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/agentConfigValidation')>();
    return { ...actual, validateAgentConfig: vi.fn() };
});

vi.mock('@/lib/services/agents/agentManifest', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/agentManifest')>();
    return { ...actual, previewAgentImport: vi.fn(), applyAgentManifest: vi.fn() };
});

vi.mock('@/lib/services/agents/agentScheduleService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/agentScheduleService')>();
    return { ...actual, upsertAgentSchedule: vi.fn(), deleteAgentSchedule: vi.fn(), runAgentSchedule: vi.fn() };
});

vi.mock('@/lib/services/agents/agentRunService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/agentRunService')>();
    return {
        ...actual,
        resolveAgentExecutionLimits: vi.fn(),
        listAgentRuns: vi.fn(),
        getAgentRunStatus: vi.fn(),
        requestAgentRunCancellation: vi.fn(),
    };
});

vi.mock('@/lib/services/agents/manifestResources', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/manifestResources')>();
    return {
        ...actual,
        collectManifestResources: vi.fn(async () => ({
            resources: { skills: [{ key: 'refunds', title: 'Refunds', header: 'h', body: 'b' }] },
            skipped: [{ type: 'mcpServers', key: 'kb', reason: 'internal' }],
        })),
    };
});
vi.mock('@/lib/services/agents/import/importService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/import/importService')>();
    return { ...actual, previewAgentDocumentImport: vi.fn(), applyAgentDocumentImport: vi.fn() };
});

vi.mock('@/lib/services/agents/skillService', () => ({
    createSkill: vi.fn(),
    deleteSkill: vi.fn(),
    getSkillById: vi.fn(),
    listSkills: vi.fn(),
    updateSkill: vi.fn(),
}));

import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { getDatabase } from '@/lib/database';
import {
    createConversation,
    deleteConversation,
    getAgentById,
    updateAgentRecord,
    getConversationById,
    listConversations,
} from '@/lib/services/agents';
import { applyAgentManifest, previewAgentImport } from '@/lib/services/agents/agentManifest';
import { deleteAgentSchedule, runAgentSchedule, upsertAgentSchedule } from '@/lib/services/agents/agentScheduleService';
import { createSkill, deleteSkill, getSkillById, listSkills, updateSkill } from '@/lib/services/agents/skillService';
import { checkAgentModel } from '@/lib/services/agents/agentService';
import { validateAgentConfig } from '@/lib/services/agents/agentConfigValidation';
import { resolveSandboxAvailability } from '@/lib/services/agents/agentSandboxTools';
import {
    getAgentRunStatus,
    listAgentRuns,
    requestAgentRunCancellation,
    resolveAgentExecutionLimits,
} from '@/lib/services/agents/agentRunService';
import {
    AgentImportError,
    applyAgentDocumentImport,
    previewAgentDocumentImport,
} from '@/lib/services/agents/import/importService';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { skillsApiPlugin } from '@/server/api/plugins/skills';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const SESSION_CTX = {
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'user' },
    session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' },
};

const AGENT = {
    _id: 'agent-1',
    key: 'field-ops',
    name: 'Field Ops',
    description: 'Answers operational questions.',
    status: 'active',
    projectId: 'proj-1',
    publishedVersion: 2,
    config: { modelKey: 'gpt-5-terra', systemPrompt: 'You help on call.' },
    metadata: { schedules: [{ id: 's1', name: 'Nightly', cron: '0 2 * * *', message: 'Summarise.', enabled: true }] },
};

/** An agent that belongs to a different project — must be invisible. */
const FOREIGN_AGENT = { ...AGENT, _id: 'agent-9', projectId: 'proj-other' };

beforeEach(() => {
    vi.clearAllMocks();
    mockFn(requireProjectContextForRequest).mockResolvedValue(SESSION_CTX);
    mockFn(getDatabase).mockResolvedValue({});
    mockFn(getAgentById).mockImplementation(async (_db: string, id: string) =>
        (id === AGENT._id ? AGENT : id === FOREIGN_AGENT._id ? FOREIGN_AGENT : null));
});

const agentsApp = () => createFastifyApiTestApp(agentsApiPlugin);
const skillsApp = () => createFastifyApiTestApp(skillsApiPlugin);

describe('export / import', () => {
    it('GET /agents/:agentId/export returns a manifest for the caller\'s agent', async () => {
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-1/export?format=json' });
        expect(res.statusCode).toBe(200);
        const body = parseJsonBody<{ manifest: { metadata: { key: string }; spec: { modelKey: string } } }>(res.body);
        expect(body.manifest.metadata.key).toBe('field-ops');
        expect(body.manifest.spec.modelKey).toBe('gpt-5-terra');
    });

    it('GET /agents/:agentId/export?include= embeds definitions and reports what stayed a reference', async () => {
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-1/export?format=json&include=skills,mcp' });
        expect(res.statusCode).toBe(200);
        const body = parseJsonBody<{ manifest: { resources?: { skills?: unknown[] } }; skippedResources: unknown[] }>(res.body);
        expect(body.manifest.resources?.skills).toHaveLength(1);
        expect(body.skippedResources).toEqual([{ type: 'mcpServers', key: 'kb', reason: 'internal' }]);
        const bad = await app.inject({ method: 'GET', url: '/api/agents/agent-1/export?include=secrets' });
        expect(bad.statusCode).toBe(400);
    });

    it('GET /agents/:agentId/export 404s for another project\'s agent', async () => {
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-9/export' });
        expect(res.statusCode).toBe(404);
    });

    it('POST /agents/import rejects an empty request as a 400', async () => {
        const app = await agentsApp();
        const res = await app.inject({ method: 'POST', url: '/api/agents/import', payload: {} });
        expect(res.statusCode).toBe(400);
        expect(mockFn(applyAgentManifest)).not.toHaveBeenCalled();
    });

    it('POST /agents/import with dryRun previews without writing', async () => {
        mockFn(previewAgentImport).mockResolvedValue({ ok: true, missing: [] });
        const app = await agentsApp();
        const exported = parseJsonBody<{ content: string }>((await app.inject({ method: 'GET', url: '/api/agents/agent-1/export?format=yaml' })).body);
        const res = await app.inject({ method: 'POST', url: '/api/agents/import', payload: { content: exported.content, dryRun: true } });
        expect(res.statusCode).toBe(200);
        expect(mockFn(previewAgentImport)).toHaveBeenCalled();
        expect(mockFn(applyAgentManifest)).not.toHaveBeenCalled();
    });
});

describe('schedules', () => {
    it('GET /agents/:agentId/schedules lists the agent\'s schedules', async () => {
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-1/schedules' });
        expect(res.statusCode).toBe(200);
        expect(parseJsonBody<{ schedules: Array<{ id: string }> }>(res.body).schedules.map((s) => s.id)).toEqual(['s1']);
    });

    it('POST /agents/:agentId/schedules creates one (201) and 404s across projects', async () => {
        mockFn(upsertAgentSchedule).mockResolvedValue({ schedule: { id: 's2' }, schedules: [] });
        const app = await agentsApp();
        const created = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/schedules',
            payload: { name: 'Hourly', cron: '0 * * * *', message: 'Check.', enabled: true },
        });
        expect(created.statusCode).toBe(201);
        const foreign = await app.inject({ method: 'POST', url: '/api/agents/agent-9/schedules', payload: { name: 'x' } });
        expect(foreign.statusCode).toBe(404);
        expect(mockFn(upsertAgentSchedule)).toHaveBeenCalledTimes(1);
    });

    it('DELETE /agents/:agentId/schedules/:scheduleId removes it', async () => {
        mockFn(deleteAgentSchedule).mockResolvedValue([]);
        const app = await agentsApp();
        const res = await app.inject({ method: 'DELETE', url: '/api/agents/agent-1/schedules/s1' });
        expect(res.statusCode).toBe(200);
        expect(mockFn(deleteAgentSchedule).mock.calls[0][2]).toBe('s1');
    });

    it('POST /agents/:agentId/schedules/:scheduleId/run refuses an unpublished agent', async () => {
        mockFn(getAgentById).mockResolvedValue({ ...AGENT, publishedVersion: null });
        const app = await agentsApp();
        const res = await app.inject({ method: 'POST', url: '/api/agents/agent-1/schedules/s1/run' });
        // A scheduled run always uses the published version — there is none.
        expect(res.statusCode).toBe(409);
        expect(mockFn(runAgentSchedule)).not.toHaveBeenCalled();
    });

    it('POST /agents/:agentId/schedules/:scheduleId/run runs a published agent\'s schedule', async () => {
        mockFn(runAgentSchedule).mockResolvedValue({ conversationId: 'c1', status: 'success' });
        const app = await agentsApp();
        const res = await app.inject({ method: 'POST', url: '/api/agents/agent-1/schedules/s1/run' });
        expect(res.statusCode).toBe(200);
        expect(mockFn(runAgentSchedule)).toHaveBeenCalledTimes(1);
    });
});

describe('code export', () => {
    it('POST /agents/:agentId/codegen rejects an unknown target', async () => {
        const app = await agentsApp();
        const res = await app.inject({ method: 'POST', url: '/api/agents/agent-1/codegen', payload: { target: 'mainframe' } });
        expect(res.statusCode).toBe(400);
    });

    it('POST /agents/:agentId/codegen generates a project with a package.json', async () => {
        const app = await agentsApp();
        const res = await app.inject({ method: 'POST', url: '/api/agents/agent-1/codegen', payload: { target: 'server' } });
        expect(res.statusCode).toBe(200);
        const body = parseJsonBody<{ files: Array<{ path: string }> }>(res.body);
        expect(body.files.some((f) => f.path.endsWith('package.json'))).toBe(true);
    });
});

describe('sessions', () => {
    it('GET /agents/:agentId/sessions returns summaries, not transcripts', async () => {
        mockFn(listConversations).mockResolvedValue([{
            _id: 'c1', title: 'Incident', agentKey: 'field-ops', projectId: 'proj-1', metadata: {},
            messages: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'ok', latencyMs: 1200, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001 } },
            ],
        }]);
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-1/sessions' });
        expect(res.statusCode).toBe(200);
        const [row] = parseJsonBody<{ sessions: Array<Record<string, unknown>> }>(res.body).sessions;
        expect(row).toMatchObject({ _id: 'c1', turns: 1, totalTokens: 15, activeMs: 1200 });
        expect(row.messages).toBeUndefined();
    });

    it('POST /agents/:agentId/sessions stores the session context with the caller stamped on it', async () => {
        mockFn(createConversation).mockResolvedValue({ _id: 'c2' });
        const app = await agentsApp();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/sessions',
            payload: { title: 'Triage', context: { metadata: { customer: 'Acme' } } },
        });
        expect(res.statusCode).toBe(201);
        const call = mockFn(createConversation).mock.calls[0];
        expect(call[5]).toBe('Triage');
        expect(call[6].runtimeContext).toMatchObject({ metadata: { customer: 'Acme' }, userId: 'user-1', source: 'playground' });
    });

    it('GET /agents/:agentId/sessions/:sessionId 404s for a session of another agent', async () => {
        mockFn(getConversationById).mockResolvedValue({ _id: 'c3', agentKey: 'someone-else', projectId: 'proj-1', messages: [] });
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-1/sessions/c3' });
        expect(res.statusCode).toBe(404);
    });

    it('DELETE /agents/:agentId/sessions/:sessionId deletes only a session the agent owns', async () => {
        mockFn(getConversationById).mockResolvedValue({ _id: 'c1', agentKey: 'field-ops', projectId: 'proj-1', messages: [] });
        const app = await agentsApp();
        const res = await app.inject({ method: 'DELETE', url: '/api/agents/agent-1/sessions/c1' });
        expect(res.statusCode).toBe(200);
        expect(mockFn(deleteConversation)).toHaveBeenCalledWith('tenant_acme', 'c1');
    });
});

describe('skill library', () => {
    it('GET /skills lists the project\'s skills', async () => {
        mockFn(listSkills).mockResolvedValue([{ key: 'triage' }]);
        const app = await skillsApp();
        const res = await app.inject({ method: 'GET', url: '/api/skills' });
        expect(res.statusCode).toBe(200);
        expect(mockFn(listSkills).mock.calls[0][1]).toBe('proj-1');
    });

    it('POST /skills requires a title and a header', async () => {
        const app = await skillsApp();
        expect((await app.inject({ method: 'POST', url: '/api/skills', payload: { header: 'h' } })).statusCode).toBe(400);
        expect((await app.inject({ method: 'POST', url: '/api/skills', payload: { title: 't' } })).statusCode).toBe(400);
        mockFn(createSkill).mockResolvedValue({ key: 't' });
        expect((await app.inject({ method: 'POST', url: '/api/skills', payload: { title: 't', header: 'h', body: 'b' } })).statusCode).toBe(201);
    });

    it('GET /skills/:id 404s for a missing skill', async () => {
        mockFn(getSkillById).mockResolvedValue(null);
        const app = await skillsApp();
        expect((await app.inject({ method: 'GET', url: '/api/skills/nope' })).statusCode).toBe(404);
    });

    it('PATCH /skills/:id updates and 404s when absent', async () => {
        mockFn(updateSkill).mockResolvedValueOnce({ key: 't', title: 'new' }).mockResolvedValueOnce(null);
        const app = await skillsApp();
        expect((await app.inject({ method: 'PATCH', url: '/api/skills/s1', payload: { title: 'new' } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'PATCH', url: '/api/skills/s2', payload: { title: 'x' } })).statusCode).toBe(404);
    });

    it('DELETE /skills/:id deletes and 404s when absent', async () => {
        mockFn(deleteSkill).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const app = await skillsApp();
        expect((await app.inject({ method: 'DELETE', url: '/api/skills/s1' })).statusCode).toBe(200);
        expect((await app.inject({ method: 'DELETE', url: '/api/skills/s2' })).statusCode).toBe(404);
    });
});

describe('config validation and model check', () => {
    it('POST /agents/:agentId/validate checks the stored draft, or the config in the body', async () => {
        mockFn(validateAgentConfig).mockResolvedValue({
            errors: [{ field: 'modelKey', message: 'Model "x" does not exist in this project' }],
            warnings: [],
        });
        const app = await agentsApp();

        const stored = await app.inject({ method: 'POST', url: '/api/agents/agent-1/validate', payload: {} });
        expect(stored.statusCode).toBe(200);
        expect(parseJsonBody<{ valid: boolean }>(stored.body).valid).toBe(false);
        expect(mockFn(validateAgentConfig).mock.calls[0][0]).toMatchObject({
            projectId: 'proj-1',
            agentKey: 'field-ops',
            config: AGENT.config,
        });

        const draft = { modelKey: 'other' };
        await app.inject({ method: 'POST', url: '/api/agents/agent-1/validate', payload: { config: draft } });
        expect(mockFn(validateAgentConfig).mock.calls[1][0].config).toEqual(draft);
    });

    it('POST /agents/:agentId/validate 404s for another project\'s agent', async () => {
        const app = await agentsApp();
        const res = await app.inject({ method: 'POST', url: '/api/agents/agent-9/validate', payload: {} });
        expect(res.statusCode).toBe(404);
        expect(mockFn(validateAgentConfig)).not.toHaveBeenCalled();
    });

    it('POST /agents/model-check needs a modelKey and returns the check verbatim', async () => {
        const app = await agentsApp();
        expect((await app.inject({ method: 'POST', url: '/api/agents/model-check', payload: {} })).statusCode).toBe(400);

        mockFn(checkAgentModel).mockResolvedValue({
            ok: false,
            latencyMs: 12,
            error: { message: 'The model provider rejected its credentials', type: 'provider_authentication_error' },
        });
        const res = await app.inject({ method: 'POST', url: '/api/agents/model-check', payload: { modelKey: 'gpt-5-terra' } });
        expect(res.statusCode).toBe(200);
        expect(parseJsonBody<{ error: { type: string } }>(res.body).error.type).toBe('provider_authentication_error');
        expect(mockFn(checkAgentModel)).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'gpt-5-terra');
    });

    it('POST /agents/:agentId/publish refuses a draft that fails validation', async () => {
        mockFn(validateAgentConfig).mockResolvedValue({
            errors: [{ field: 'toolBindings[0]', message: 'Tool "gone" does not exist' }],
            warnings: [],
        });
        const app = await agentsApp();
        const res = await app.inject({ method: 'POST', url: '/api/agents/agent-1/publish', payload: {} });
        expect(res.statusCode).toBe(400);
        expect(parseJsonBody<{ error: string }>(res.body).error).toContain('toolBindings[0]');
    });
});

describe('sandbox capabilities', () => {
    it('GET /agents/sandbox/capabilities lists templates when the module and the license allow it', async () => {
        mockFn(resolveSandboxAvailability).mockResolvedValue({
            available: true,
            runner: { listTemplates: vi.fn().mockResolvedValue([{ key: 'multi-base', name: 'Multi base' }]) },
        });
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/sandbox/capabilities' });
        expect(res.statusCode).toBe(200);
        expect(parseJsonBody(res.body)).toEqual({ available: true, templates: [{ key: 'multi-base', name: 'Multi base' }] });
        expect(mockFn(resolveSandboxAvailability)).toHaveBeenCalledWith('tenant-1');
    });

    it('GET /agents/sandbox/capabilities reports an unlicensed tenant as unavailable, with the reason', async () => {
        mockFn(resolveSandboxAvailability).mockResolvedValue({ available: false, reason: 'license' });
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/sandbox/capabilities' });
        expect(res.statusCode).toBe(200);
        expect(parseJsonBody(res.body)).toEqual({ available: false, reason: 'license', templates: [] });
    });
});

describe('sandbox secrets in API responses', () => {
    it('PATCH /agents/:agentId answers with secret keys masked and never the sealed payload', async () => {
        const { sealAgentSandboxConfig } = await import('@/lib/services/agents/agentSandboxSecrets');
        const sealed = sealAgentSandboxConfig({ enabled: true, secrets: { API_TOKEN: 'tok-123456' } }, undefined)!;
        mockFn(validateAgentConfig).mockResolvedValue({ errors: [], warnings: [] });
        mockFn(updateAgentRecord).mockResolvedValue({ ...AGENT, config: { ...AGENT.config, sandbox: sealed } });
        mockFn(getDatabase).mockResolvedValue({});
        const app = await agentsApp();
        const res = await app.inject({
            method: 'PATCH',
            url: '/api/agents/agent-1',
            payload: { config: { modelKey: 'gpt-5-terra', sandbox: { enabled: true, secrets: { API_TOKEN: 'tok-123456' } } } },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain('tok-123456');
        expect(res.body).not.toContain(sealed.secretsSealed!);
        const body = parseJsonBody<{ agent: { config: { sandbox: { secrets: Record<string, string> } } } }>(res.body);
        expect(body.agent.config.sandbox.secrets).toEqual({ API_TOKEN: '••••••' });
    });
});

describe('execution limits and background runs', () => {
    const RUN = {
        _id: 'run-1',
        mode: 'background',
        status: 'running',
        agentKey: AGENT.key,
        conversationId: 'conv-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        callbackUrl: 'https://example.com/hook',
        callbackSecret: 'sealed-secret',
        runtimeContext: { sealed: 'x' },
        createdAt: new Date('2026-09-24T10:00:00Z'),
    };

    it('GET /agents/execution/limits returns the effective ceilings for this project', async () => {
        mockFn(resolveAgentExecutionLimits).mockResolvedValue({
            syncTimeoutMs: 120_000,
            backgroundEnabled: true,
            backgroundMaxDurationMs: 600_000,
            defaultMode: 'sync',
            maxConcurrentRunsPerTenant: 5,
            maxConcurrentRunsPerProject: 0,
        });
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/execution/limits' });
        expect(res.statusCode).toBe(200);
        expect(parseJsonBody(res.body)).toEqual({
            syncTimeoutSeconds: 120,
            backgroundMaxDurationMinutes: 10,
            maxConcurrentRunsPerTenant: 5,
            maxConcurrentRunsPerProject: 0,
        });
        const call = mockFn(resolveAgentExecutionLimits).mock.calls[0][0];
        expect(call.quotaContext).toMatchObject({ tenantId: 'tenant-1', projectId: 'proj-1' });
    });

    it('GET /agents/:agentId/runs lists this agent\'s background runs without secrets or caller headers', async () => {
        mockFn(listAgentRuns).mockResolvedValue([RUN]);
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-1/runs?status=running,bogus' });
        expect(res.statusCode).toBe(200);
        const body = parseJsonBody<{ runs: Array<Record<string, unknown>> }>(res.body);
        expect(body.runs[0].id).toBe('run_run-1');
        expect(JSON.stringify(body)).not.toContain('sealed-secret');
        expect(JSON.stringify(body)).not.toContain('runtimeContext');
        expect(mockFn(listAgentRuns)).toHaveBeenCalledWith('tenant_acme', expect.objectContaining({
            agentKey: 'field-ops', projectId: 'proj-1', mode: 'background', status: ['running'],
        }));
    });

    it('GET /agents/:agentId/runs 404s for another project\'s agent', async () => {
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-9/runs' });
        expect(res.statusCode).toBe(404);
        expect(mockFn(listAgentRuns)).not.toHaveBeenCalled();
    });

    it('POST cancel refuses a run that belongs to a different agent, before touching it', async () => {
        mockFn(getAgentRunStatus).mockResolvedValue({ ...RUN, agentKey: 'someone-else' });
        const app = await agentsApp();
        const res = await app.inject({ method: 'POST', url: '/api/agents/agent-1/runs/run_run-1/cancel' });
        expect(res.statusCode).toBe(404);
        expect(mockFn(requestAgentRunCancellation)).not.toHaveBeenCalled();
    });

    it('POST cancel accepts this agent\'s active run and 409s a finished one', async () => {
        mockFn(getAgentRunStatus).mockResolvedValue(RUN);
        mockFn(requestAgentRunCancellation).mockResolvedValueOnce({ kind: 'accepted', run: { ...RUN, cancelRequestedAt: new Date() } });
        const app = await agentsApp();
        const ok = await app.inject({ method: 'POST', url: '/api/agents/agent-1/runs/run_run-1/cancel' });
        expect(ok.statusCode).toBe(200);
        mockFn(requestAgentRunCancellation).mockResolvedValueOnce({ kind: 'already_terminal', run: { ...RUN, status: 'succeeded' } });
        const done = await app.inject({ method: 'POST', url: '/api/agents/agent-1/runs/run_run-1/cancel' });
        expect(done.statusCode).toBe(409);
    });
});

describe('import from a definition document', () => {
    it('POST /agents/import/document/preview requires content and passes the format hint', async () => {
        const app = await agentsApp();
        const empty = await app.inject({ method: 'POST', url: '/api/agents/import/document/preview', payload: {} });
        expect(empty.statusCode).toBe(400);

        mockFn(previewAgentDocumentImport).mockResolvedValue({ format: { id: 'claude-managed-agent' }, warnings: [] });
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/import/document/preview',
            payload: { content: 'name: x\nmodel: claude-opus-5-5', format: 'claude-managed-agent' },
        });
        expect(res.statusCode).toBe(200);
        expect(mockFn(previewAgentDocumentImport)).toHaveBeenCalledWith(
            expect.objectContaining({ tenantDbName: 'tenant_acme', projectId: 'proj-1', userId: 'user-1' }),
            'name: x\nmodel: claude-opus-5-5',
            'claude-managed-agent',
        );
    });

    it('POST /agents/import/document answers 201 with what it created, and maps import errors to their status', async () => {
        mockFn(applyAgentDocumentImport).mockResolvedValueOnce({
            agent: { ...AGENT, _id: 'agent-new', key: 'support-bot' },
            action: 'created',
            created: { mcpServers: [{ key: 'github', name: 'github' }], skills: [] },
            warnings: [{ code: 'web_fetch', message: 'mapped' }],
        });
        const app = await agentsApp();
        const ok = await app.inject({ method: 'POST', url: '/api/agents/import/document', payload: { content: 'x', modelKey: 'opus' } });
        expect(ok.statusCode).toBe(201);
        const body = parseJsonBody<{ agent: { _id: string }; created: unknown; warnings: unknown[] }>(ok.body);
        expect(body.agent._id).toBe('agent-new');
        expect(body.warnings).toHaveLength(1);

        mockFn(applyAgentDocumentImport).mockRejectedValueOnce(new AgentImportError('MCP server "jira" could not be connected', 422, { mcpServer: 'jira' }));
        const failed = await app.inject({ method: 'POST', url: '/api/agents/import/document', payload: { content: 'x', modelKey: 'opus' } });
        expect(failed.statusCode).toBe(422);
        expect(parseJsonBody<{ details: unknown }>(failed.body).details).toEqual({ mcpServer: 'jira' });
    });
});
