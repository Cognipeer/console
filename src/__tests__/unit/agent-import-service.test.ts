import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = {
    switchToTenant: vi.fn(),
    listModels: vi.fn(),
    findAgentByKey: vi.fn(),
    deleteSkill: vi.fn(),
    updateAgent: vi.fn(),
};
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(async () => db) }));
vi.mock('@/lib/services/mcp/mcpService', () => ({
    createMcpServer: vi.fn(),
    deleteMcpServer: vi.fn(),
    listMcpServers: vi.fn(),
}));
vi.mock('@/lib/services/agents/skillService', () => ({ createSkill: vi.fn(), listSkills: vi.fn() }));
vi.mock('@/lib/services/webSearch/webSearchService', () => ({ listWebSearchProviders: vi.fn() }));
vi.mock('@/lib/services/agents/agentConfigValidation', () => ({ validateAgentConfig: vi.fn() }));
vi.mock('@/lib/services/agents/agentSandboxTools', () => ({ resolveSandboxAvailability: vi.fn() }));
vi.mock('@/lib/services/agents/agentManifest', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/agentManifest')>();
    return { ...actual, applyAgentManifest: vi.fn(), previewAgentImport: vi.fn() };
});

import { createMcpServer, deleteMcpServer, listMcpServers } from '@/lib/services/mcp/mcpService';
import { createSkill, listSkills } from '@/lib/services/agents/skillService';
import { listWebSearchProviders } from '@/lib/services/webSearch/webSearchService';
import { validateAgentConfig } from '@/lib/services/agents/agentConfigValidation';
import { resolveSandboxAvailability } from '@/lib/services/agents/agentSandboxTools';
import { applyAgentManifest, previewAgentImport } from '@/lib/services/agents/agentManifest';
import {
    AgentImportError,
    applyAgentDocumentImport,
    previewAgentDocumentImport,
} from '@/lib/services/agents/import/importService';

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const CTX = { tenantDbName: 't_db', tenantId: 't1', projectId: 'p1', userId: 'u1' };

const DOC = `---
name: Support Bot
model: claude-opus-5-5
tools:
  - type: agent_toolset_20260401
    default_config:
      enabled: false
    configs:
      - name: web_search
        enabled: true
      - name: bash
        enabled: true
  - type: mcp_toolset
    mcp_server_name: github
    configs:
      - name: delete_repo
        enabled: false
  - type: mcp_toolset
    mcp_server_name: jira
mcp_servers:
  - type: url
    name: github
    url: https://api.githubcopilot.com/mcp/
  - type: url
    name: jira
    url: https://jira.example.com/mcp
skills:
  - type: custom
    skill_id: skill_refunds
---
You help customers.`;

beforeEach(() => {
    vi.clearAllMocks();
    fn(db.listModels).mockResolvedValue([
        { key: 'opus', name: 'Opus', modelId: 'anthropic.claude-opus-5-5-v1:0' },
        { key: 'gpt', name: 'GPT', modelId: 'gpt-5.6-luna' },
    ]);
    fn(db.findAgentByKey).mockResolvedValue(null);
    fn(db.updateAgent).mockResolvedValue({});
    fn(listSkills).mockResolvedValue([{ key: 'refunds', title: 'Refunds', status: 'active' }]);
    fn(listMcpServers).mockResolvedValue([{ _id: 'm-jira', key: 'jira', name: 'Jira', remoteConfig: { url: 'https://jira.example.com/mcp' }, status: 'active', tools: [{ name: 'search' }, { name: 'create' }] }]);
    fn(listWebSearchProviders).mockResolvedValue([{ status: 'active' }]);
    fn(resolveSandboxAvailability).mockResolvedValue({ available: false, reason: 'license' });
    fn(validateAgentConfig).mockResolvedValue({ errors: [], warnings: [] });
    fn(applyAgentManifest).mockResolvedValue({ agent: { _id: 'agent-1', key: 'support-bot', metadata: {} }, action: 'created', missing: [] });
});

describe('previewAgentDocumentImport', () => {
    it('detects the Claude format, suggests the matching model and the reusable MCP server', async () => {
        const preview = await previewAgentDocumentImport(CTX, DOC);
        expect(preview.format).toMatchObject({ id: 'claude-managed-agent', detected: true });
        expect(preview.agent).toMatchObject({ name: 'Support Bot', key: 'support-bot', exists: false });
        expect(preview.model?.suggestedKey).toBe('opus');
        expect(preview.mcpServers.find((s) => s.ref === 'jira')?.existing).toEqual({ key: 'jira', name: 'Jira' });
        expect(preview.mcpServers.find((s) => s.ref === 'github')?.existing).toBeUndefined();
        expect(preview.capabilities.sandbox).toMatchObject({ requested: ['bash'], available: false });
        expect(preview.warnings.some((w) => w.code === 'sandbox_unavailable')).toBe(true);
    });

    it('returns format null with candidates when nothing is confident, and honours an explicit format', async () => {
        const unknown = await previewAgentDocumentImport(CTX, 'name: Something\ndescription: plain');
        expect(unknown.format.id).toBeNull();
        const forced = await previewAgentDocumentImport(CTX, 'name: Something\nsystem: hi', 'claude-managed-agent');
        expect(forced.format).toMatchObject({ id: 'claude-managed-agent', detected: false });
    });

    it('previews a console manifest through the existing manifest preview', async () => {
        fn(previewAgentImport).mockResolvedValue({ exists: false, dependencies: [], missing: [{ type: 'model', key: 'gone', usedBy: 'spec.modelKey' }] });
        const preview = await previewAgentDocumentImport(CTX, JSON.stringify({
            apiVersion: 'cognipeer.console/v1', kind: 'Agent', metadata: { key: 'a', name: 'A' }, spec: { modelKey: 'gone' }, dependencies: [],
        }));
        expect(preview.format.id).toBe('cognipeer');
        expect(preview.warnings[0].code).toBe('missing_dependency');
    });
});

describe('applyAgentDocumentImport', () => {
    it('creates the new MCP server, reuses the existing one, binds filtered tools, creates the skill, writes the agent', async () => {
        fn(createMcpServer).mockResolvedValue({ _id: 'm-gh', key: 'github', name: 'github', tools: [{ name: 'get_issue' }, { name: 'delete_repo' }] });
        fn(createSkill).mockResolvedValue({ _id: 's1', key: 'refund-policy', title: 'Refund policy' });
        const result = await applyAgentDocumentImport(CTX, {
            content: DOC,
            modelKey: 'opus',
            mcp: { github: { action: 'create', auth: { type: 'token', token: 'ghp_x' } }, jira: { action: 'reuse', key: 'jira' } },
            skills: { 'custom:skill_refunds': { action: 'create', title: 'Refund policy', header: 'Refund rules', body: '...' } },
        });
        expect(fn(createMcpServer).mock.calls[0][4]).toMatchObject({
            sourceType: 'remote',
            remoteConfig: { url: 'https://api.githubcopilot.com/mcp/', transport: 'streamable-http' },
            upstreamAuth: { type: 'token', token: 'ghp_x' },
        });
        const manifest = fn(applyAgentManifest).mock.calls[0][4];
        expect(manifest.spec).toMatchObject({
            modelKey: 'opus',
            systemPrompt: 'You help customers.',
            skills: ['refund-policy'],
        });
        expect(manifest.spec.toolBindings).toEqual([
            { source: 'mcp', sourceKey: 'github', toolNames: ['get_issue'] },
            { source: 'mcp', sourceKey: 'jira', toolNames: ['search', 'create'] },
            { source: 'system', sourceKey: 'web_search', toolNames: ['web_search'] },
        ]);
        // Sandbox unavailable → not configured, but reported.
        expect(manifest.spec.sandbox).toBeUndefined();
        expect(result.warnings.some((w) => w.code === 'sandbox_unavailable')).toBe(true);
        expect(result.created).toEqual({ mcpServers: [{ key: 'github', name: 'github' }], skills: [{ key: 'refund-policy', title: 'Refund policy' }] });
        expect(fn(db.updateAgent).mock.calls[0][1].metadata.imported).toMatchObject({ format: 'claude-managed-agent', requestedModel: 'claude-opus-5-5' });
    });

    it('rolls back everything it created when an MCP server cannot be connected — no agent is written', async () => {
        fn(createSkill).mockResolvedValue({ _id: 's1', key: 'k', title: 't' });
        fn(createMcpServer)
            .mockResolvedValueOnce({ _id: 'm-gh', key: 'github', name: 'github', tools: [] })
            .mockRejectedValueOnce(new Error('401 Unauthorized'));
        await expect(applyAgentDocumentImport(CTX, {
            content: DOC,
            modelKey: 'opus',
            mcp: { github: { action: 'create' }, jira: { action: 'create' } },
        })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('"jira"') });
        expect(fn(deleteMcpServer)).toHaveBeenCalledWith('t_db', 'm-gh');
        expect(fn(applyAgentManifest)).not.toHaveBeenCalled();
    });

    it('rolls back when the final config does not validate', async () => {
        fn(createMcpServer).mockResolvedValue({ _id: 'm-gh', key: 'github', name: 'github', tools: [{ name: 'x' }] });
        fn(validateAgentConfig).mockResolvedValue({ errors: [{ field: 'modelKey', message: 'bad' }], warnings: [] });
        await expect(applyAgentDocumentImport(CTX, { content: DOC, modelKey: 'opus', mcp: { jira: { action: 'skip' } } }))
            .rejects.toBeInstanceOf(AgentImportError);
        expect(fn(deleteMcpServer)).toHaveBeenCalledWith('t_db', 'm-gh');
    });

    it('requires a model, refuses an existing key, and asks for a format it cannot detect', async () => {
        await expect(applyAgentDocumentImport(CTX, { content: DOC })).rejects.toThrow(/Choose a model/);
        fn(db.findAgentByKey).mockResolvedValue({ _id: 'x' });
        await expect(applyAgentDocumentImport(CTX, { content: DOC, modelKey: 'opus' })).rejects.toMatchObject({ status: 409 });
        await expect(applyAgentDocumentImport(CTX, { content: 'name: x', modelKey: 'opus' })).rejects.toMatchObject({ status: 422 });
    });

    it('turns on the sandbox when it is available', async () => {
        fn(resolveSandboxAvailability).mockResolvedValue({ available: true });
        await applyAgentDocumentImport(CTX, { content: DOC, modelKey: 'opus', mcp: { github: { action: 'skip' }, jira: { action: 'skip' } } });
        expect(fn(applyAgentManifest).mock.calls[0][4].spec.sandbox).toEqual({ enabled: true, mode: 'ephemeral' });
    });
});
