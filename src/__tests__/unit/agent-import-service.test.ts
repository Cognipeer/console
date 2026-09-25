import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = {
    switchToTenant: vi.fn(),
    listModels: vi.fn(),
    findAgentByKey: vi.fn(),
    deleteSkill: vi.fn(),
    updateAgent: vi.fn(),
    findSkillByKey: vi.fn(),
    findPromptByKey: vi.fn(),
    findToolByKey: vi.fn(),
};
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(async () => db) }));
vi.mock('@/lib/services/mcp/mcpService', () => ({
    createMcpServer: vi.fn(),
    deleteMcpServer: vi.fn(),
    listMcpServers: vi.fn(),
}));
vi.mock('@/lib/services/agents/skillService', () => ({ createSkill: vi.fn(), listSkills: vi.fn() }));
vi.mock('@/lib/services/prompts/promptService', () => ({ createPrompt: vi.fn(), deletePrompt: vi.fn() }));
vi.mock('@/lib/services/tools/toolService', () => ({ createTool: vi.fn(), deleteTool: vi.fn() }));
vi.mock('@/lib/services/webSearch/webSearchService', () => ({ listWebSearchProviders: vi.fn() }));
vi.mock('@/lib/services/agents/agentConfigValidation', () => ({ validateAgentConfig: vi.fn() }));
vi.mock('@/lib/services/agents/agentSandboxTools', () => ({ resolveSandboxAvailability: vi.fn() }));
vi.mock('@/lib/services/agents/agentManifest', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/agentManifest')>();
    return { ...actual, applyAgentManifest: vi.fn(), previewAgentImport: vi.fn() };
});

import { createMcpServer, deleteMcpServer, listMcpServers } from '@/lib/services/mcp/mcpService';
import { createSkill, listSkills } from '@/lib/services/agents/skillService';
import { createPrompt, deletePrompt } from '@/lib/services/prompts/promptService';
import { createTool, deleteTool } from '@/lib/services/tools/toolService';
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
    fn(db.findSkillByKey).mockResolvedValue(null);
    fn(db.findPromptByKey).mockResolvedValue(null);
    fn(db.findToolByKey).mockResolvedValue(null);
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

const MANIFEST = {
    apiVersion: 'cognipeer.console/v1',
    kind: 'Agent',
    metadata: { key: 'support', name: 'Support', exportedAt: '2026-09-25T00:00:00Z' },
    spec: {
        modelKey: 'gpt',
        promptKey: 'support-prompt',
        skills: ['refunds', 'tone'],
        toolBindings: [
            { source: 'mcp', sourceKey: 'github', toolNames: ['get_issue'] },
            { source: 'mcp', sourceKey: 'jira', toolNames: ['search'] },
            { source: 'tool', sourceKey: 'crm', toolNames: ['lookup'] },
        ],
    },
    dependencies: [],
    resources: {
        skills: [{ key: 'refunds', title: 'Refunds', header: 'When refunding', body: 'Steps' }],
        prompts: [{ key: 'support-prompt', name: 'Support', template: 'Be kind' }],
        mcpServers: [
            { key: 'github', name: 'GitHub', sourceType: 'remote', remoteConfig: { url: 'https://api.githubcopilot.com/mcp/', transport: 'streamable-http' }, auth: { type: 'token' } },
            { key: 'jira-cloud', name: 'Jira', sourceType: 'remote', remoteConfig: { url: 'https://jira.example.com/mcp', transport: 'streamable-http' }, auth: { type: 'none' } },
        ],
        tools: [{ key: 'crm', name: 'CRM', type: 'openapi', openApiSpec: '{}', upstreamBaseUrl: 'https://crm.example.com', auth: { type: 'header', headerName: 'X-Key' } }],
    },
};
const MANIFEST_TEXT = JSON.stringify(MANIFEST);

describe('cognipeer manifest with embedded definitions', () => {
    beforeEach(() => {
        fn(previewAgentImport).mockResolvedValue({
            exists: false,
            dependencies: [],
            missing: [
                { type: 'skill', key: 'refunds', usedBy: 'spec.skills' },
                { type: 'skill', key: 'tone', usedBy: 'spec.skills' },
                { type: 'prompt', key: 'support-prompt', usedBy: 'spec.promptKey' },
            ],
        });
        fn(db.findPromptByKey).mockResolvedValue({ key: 'support-prompt', name: 'Support (here)' });
    });

    it('preview lists the definitions with what already exists (key, or MCP URL) and hides embedded ones from "missing"', async () => {
        const preview = await previewAgentDocumentImport(CTX, MANIFEST_TEXT);
        expect(preview.format.id).toBe('cognipeer');
        const byRef = Object.fromEntries(preview.resources.map((r) => [`${r.type}:${r.key}`, r]));
        expect(byRef['prompts:support-prompt'].existing).toEqual({ key: 'support-prompt', name: 'Support (here)' });
        expect(byRef['skills:refunds'].existing).toBeUndefined();
        expect(byRef['mcpServers:jira-cloud'].existing).toEqual({ key: 'jira', name: 'Jira' });
        expect(byRef['mcpServers:github'].auth).toEqual({ type: 'token' });
        expect(byRef['tools:crm'].auth).toEqual({ type: 'header', headerName: 'X-Key' });
        expect(preview.missing).toEqual([{ type: 'skill', key: 'tone', usedBy: 'spec.skills' }]);
    });

    it('creates the missing ones with the supplied credentials, reuses the rest and remaps changed keys', async () => {
        fn(createSkill).mockResolvedValue({ _id: 's1', key: 'refunds', title: 'Refunds' });
        fn(createTool).mockResolvedValue({ _id: 't1', key: 'crm-1', name: 'CRM' });
        fn(createMcpServer).mockResolvedValue({ _id: 'm1', key: 'github', name: 'GitHub', tools: [] });
        const result = await applyAgentDocumentImport(CTX, {
            content: MANIFEST_TEXT,
            resources: {
                'mcpServers:github': { action: 'create', auth: { token: 'ghp_x' } },
                'tools:crm': { action: 'create', auth: { headerValue: 'k' } },
            },
        });
        expect(fn(createMcpServer).mock.calls[0][4]).toMatchObject({ key: 'github', sourceType: 'remote', upstreamAuth: { type: 'token', token: 'ghp_x' } });
        expect(fn(createTool).mock.calls[0][4]).toMatchObject({ upstreamAuth: { type: 'header', headerName: 'X-Key', headerValue: 'k' } });
        expect(createPrompt).not.toHaveBeenCalled();
        const written = fn(applyAgentManifest).mock.calls[0][4];
        expect(written.resources).toBeUndefined();
        expect(written.spec.promptKey).toBe('support-prompt');
        expect(written.spec.toolBindings.map((b: { sourceKey: string }) => b.sourceKey)).toEqual(['github', 'jira', 'crm-1']);
        expect(result.created.tools).toEqual([{ key: 'crm-1', name: 'CRM' }]);
        expect(result.warnings.some((w) => w.code === 'credentials_missing')).toBe(false);
    });

    it('warns when a non-remote definition is created without its credential', async () => {
        fn(createSkill).mockResolvedValue({ _id: 's1', key: 'refunds', title: 'Refunds' });
        fn(createTool).mockResolvedValue({ _id: 't1', key: 'crm', name: 'CRM' });
        const result = await applyAgentDocumentImport(CTX, {
            content: MANIFEST_TEXT,
            resources: { 'mcpServers:github': { action: 'skip' } },
        });
        expect(result.warnings.find((w) => w.code === 'credentials_missing')?.message).toContain('CRM');
    });

    it('rolls back every created definition when a later one fails', async () => {
        fn(createSkill).mockResolvedValue({ _id: 's1', key: 'refunds', title: 'Refunds' });
        fn(createPrompt).mockResolvedValue({ id: 'p1', key: 'support-prompt-1', name: 'Support' });
        fn(createTool).mockResolvedValue({ _id: 't1', key: 'crm', name: 'CRM' });
        fn(createMcpServer).mockRejectedValue(new Error('401 Unauthorized'));
        await expect(applyAgentDocumentImport(CTX, {
            content: MANIFEST_TEXT,
            resources: { 'prompts:support-prompt': { action: 'create' }, 'mcpServers:github': { action: 'create' } },
        })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('GitHub') });
        expect(db.deleteSkill).toHaveBeenCalledWith('s1');
        expect(deletePrompt).toHaveBeenCalledWith('t_db', 'p1', 'p1');
        expect(deleteTool).toHaveBeenCalledWith('t_db', 't1');
        expect(applyAgentManifest).not.toHaveBeenCalled();
    });

    it('refuses an existing agent key before creating anything', async () => {
        fn(db.findAgentByKey).mockResolvedValue({ _id: 'x' });
        await expect(applyAgentDocumentImport(CTX, { content: MANIFEST_TEXT })).rejects.toMatchObject({ status: 409 });
        expect(createSkill).not.toHaveBeenCalled();
        expect(createMcpServer).not.toHaveBeenCalled();
    });
});
