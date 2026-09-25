import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = {
    switchToTenant: vi.fn(),
    findSkillByKey: vi.fn(),
    findPromptByKey: vi.fn(),
    findMcpServerByKey: vi.fn(),
    findToolByKey: vi.fn(),
};
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(async () => db) }));

import {
    collectManifestResources,
    parseResourceInclude,
    referencedResourceKeys,
    remapSpecResourceKeys,
} from '@/lib/services/agents/manifestResources';
import { buildAgentManifest } from '@/lib/services/agents/agentManifest';

const SPEC = {
    modelKey: 'gpt',
    promptKey: 'support-prompt',
    skills: ['refunds'],
    toolBindings: [
        { source: 'mcp' as const, sourceKey: 'github', toolNames: ['get_issue'] },
        { source: 'mcp' as const, sourceKey: 'kb', toolNames: ['search'] },
        { source: 'tool' as const, sourceKey: 'crm', toolNames: ['lookup'] },
        { source: 'system' as const, sourceKey: 'web_search', toolNames: ['web_search'] },
    ],
    subagents: [{ kind: 'inline' as const, name: 'helper', toolBindings: [{ source: 'mcp' as const, sourceKey: 'files', toolNames: ['read'] }] }],
};

beforeEach(() => {
    vi.clearAllMocks();
    fn(db.findSkillByKey).mockImplementation(async (key: string) => (key === 'refunds' ? { key, title: 'Refunds', header: 'When refunding', body: 'Steps…' } : null));
    fn(db.findPromptByKey).mockResolvedValue({ key: 'support-prompt', name: 'Support', template: 'You are {{tone}}', metadata: {} });
    fn(db.findMcpServerByKey).mockImplementation(async (key: string) => ({
        github: {
            key: 'github', name: 'GitHub', sourceType: 'remote',
            remoteConfig: { url: 'https://api.githubcopilot.com/mcp/', transport: 'streamable-http' },
            upstreamAuth: { type: 'token', token: 'ghp_SECRET', sealed: 'x' },
        },
        kb: { key: 'kb', name: 'KB', sourceType: 'internal', upstreamAuth: { type: 'none' } },
        files: {
            key: 'files', name: 'Files', sourceType: 'stdio', upstreamAuth: { type: 'none' },
            stdioConfig: { runtime: 'npx', packageName: '@x/files', env: { ROOT: '/data', API_KEY: 'SECRET' }, envSealed: 'enc', executionMode: 'subprocess' },
        },
    } as Record<string, unknown>)[key] ?? null);
    fn(db.findToolByKey).mockResolvedValue({
        key: 'crm', name: 'CRM', type: 'openapi', openApiSpec: '{}', upstreamBaseUrl: 'https://crm.example.com',
        upstreamAuth: { type: 'header', headerName: 'X-Key', headerValue: 'SECRET' },
    });
});

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

describe('parseResourceInclude', () => {
    it('accepts all, aliases, arrays and none; rejects unknown names', () => {
        expect([...parseResourceInclude('all')].sort()).toEqual(['mcpServers', 'prompts', 'skills', 'tools']);
        expect([...parseResourceInclude('skill, MCP')]).toEqual(['skills', 'mcpServers']);
        expect(parseResourceInclude(['tools']).has('tools')).toBe(true);
        expect(parseResourceInclude(undefined).size).toBe(0);
        expect(parseResourceInclude('none').size).toBe(0);
        expect(() => parseResourceInclude('secrets')).toThrow(/Unknown include/);
    });
});

describe('collectManifestResources', () => {
    it('references cover inline sub-agents; system bindings are not resources', () => {
        expect(referencedResourceKeys(SPEC)).toEqual({
            skills: ['refunds'], prompts: ['support-prompt'], mcpServers: ['github', 'kb', 'files'], tools: ['crm'],
        });
    });

    it('embeds only the requested types', async () => {
        const { resources } = await collectManifestResources('t', 'p', SPEC, parseResourceInclude('skills'));
        expect(Object.keys(resources)).toEqual(['skills']);
        expect(db.findMcpServerByKey).not.toHaveBeenCalled();
    });

    it('never exports a secret: auth keeps its shape, stdio env only its names', async () => {
        const { resources, skipped } = await collectManifestResources('t', 'p', SPEC, parseResourceInclude('all'));
        const text = JSON.stringify(resources);
        expect(text).not.toContain('SECRET');
        expect(text).not.toContain('/data');
        expect(text).not.toContain('enc');
        expect(resources.mcpServers).toEqual([
            { key: 'github', name: 'GitHub', sourceType: 'remote', remoteConfig: { url: 'https://api.githubcopilot.com/mcp/', transport: 'streamable-http' }, auth: { type: 'token' } },
            { key: 'files', name: 'Files', sourceType: 'stdio', auth: { type: 'none' }, stdioConfig: { runtime: 'npx', packageName: '@x/files', envKeys: ['ROOT', 'API_KEY'], executionMode: 'subprocess' } },
        ]);
        expect(resources.tools?.[0].auth).toEqual({ type: 'header', headerName: 'X-Key' });
        expect(resources.skills?.[0]).toMatchObject({ key: 'refunds', body: 'Steps…' });
        expect(resources.prompts?.[0]).toMatchObject({ key: 'support-prompt', template: 'You are {{tone}}' });
        // Internal servers are bound to this project — reference only.
        expect(skipped).toEqual([{ type: 'mcpServers', key: 'kb', reason: expect.stringContaining('internal') }]);
    });

    it('reports a referenced resource that no longer exists', async () => {
        const { skipped } = await collectManifestResources('t', 'p', { ...SPEC, skills: ['gone'] }, parseResourceInclude('skills'));
        expect(skipped).toEqual([{ type: 'skills', key: 'gone', reason: 'not found in this project' }]);
    });

    it('buildAgentManifest omits an empty resources block', async () => {
        const agent = { key: 'a', name: 'A' };
        expect(buildAgentManifest(agent, SPEC, null, {}).resources).toBeUndefined();
        expect(buildAgentManifest(agent, SPEC, null, { skills: [] }).resources).toBeUndefined();
        expect(buildAgentManifest(agent, SPEC).dependencies).toContainEqual({ type: 'skill', key: 'refunds', usedBy: 'spec.skills' });
    });
});

describe('remapSpecResourceKeys', () => {
    it('rewrites prompt, skills, mcp/tool bindings and inline sub-agents; leaves the rest', () => {
        const next = remapSpecResourceKeys(SPEC, {
            prompts: { 'support-prompt': 'support-prompt-2' },
            skills: { refunds: 'refunds-2' },
            mcpServers: { github: 'github-2', files: 'files-2' },
            tools: { crm: 'crm-2' },
        });
        expect(next.promptKey).toBe('support-prompt-2');
        expect(next.skills).toEqual(['refunds-2']);
        expect(next.toolBindings?.map((b) => b.sourceKey)).toEqual(['github-2', 'kb', 'crm-2', 'web_search']);
        expect(next.subagents?.[0].toolBindings?.[0].sourceKey).toBe('files-2');
        expect(SPEC.promptKey).toBe('support-prompt');
    });
});
