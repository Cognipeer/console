/**
 * Finding #6: an invalid agent config saved with a 200. The runtime skips a
 * broken reference and runs anyway, so the operator only found out from an
 * agent that quietly had fewer tools — or a limit that never fired.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = {
    switchToTenant: vi.fn(),
    findModelByKey: vi.fn(),
    findPromptByKey: vi.fn(),
    findRagModuleByKey: vi.fn(),
    findMemoryStoreByKey: vi.fn(),
    findSkillByKey: vi.fn(),
    findToolByKey: vi.fn(),
    findMcpServerByKey: vi.fn(),
    findAgentByKey: vi.fn(),
    findAgentVersion: vi.fn(),
    findFileBucketByKey: vi.fn(),
    findProviderByKey: vi.fn(),
};

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(async () => db) }));

const sandboxAvailability = vi.hoisted(() => ({ value: { available: true } as Record<string, unknown> }));
vi.mock('@/lib/services/agents/agentSandboxTools', () => ({
    resolveSandboxAvailability: vi.fn(async () => sandboxAvailability.value),
}));

const getCrawler = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/crawler', async (importActual) => ({
    ...(await importActual<typeof import('@/lib/services/crawler')>()),
    getCrawler,
}));

import {
    invalidConfigBody,
    validateAgentConfig,
    validateAgentConfigShape,
} from '@/lib/services/agents/agentConfigValidation';
import type { IAgentConfig } from '@/lib/database';

const PRICED = { key: 'gpt-main', category: 'llm', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 4 } };

beforeEach(() => {
    vi.clearAllMocks();
    db.findModelByKey.mockImplementation(async (key: string) => (key === 'gpt-main' ? PRICED
        : key === 'unpriced' ? { key, category: 'llm', pricing: { inputTokenPer1M: 0, outputTokenPer1M: 0 } }
            : key === 'embedder' ? { key, category: 'embedding', pricing: {} } : null));
    db.findToolByKey.mockImplementation(async (key: string) => (key === 'logs'
        ? { key, status: 'active', actions: [{ key: 'search', name: 'search_logs' }] }
        : null));
    db.findMcpServerByKey.mockImplementation(async (key: string) => (key === 'grafana'
        ? { key, status: 'active', tools: [{ name: 'query' }, { name: 'admin' }], metadata: { disabledTools: ['admin'] } }
        : null));
    db.findAgentByKey.mockImplementation(async (key: string) => (key === 'helper'
        ? { key, publishedVersion: 1, config: { modelKey: 'gpt-main' } }
        : key === 'loopy'
            ? { key, publishedVersion: 1, config: { modelKey: 'gpt-main', subagents: [{ kind: 'ref', name: 'back', header: 'x', agentKey: 'me' }] } }
            : null));
    db.findRagModuleByKey.mockResolvedValue(null);
    db.findMemoryStoreByKey.mockResolvedValue(null);
    db.findSkillByKey.mockResolvedValue(null);
    db.findPromptByKey.mockResolvedValue(null);
    db.findFileBucketByKey.mockResolvedValue({ key: 'docs', providerKey: 'disk', status: 'active' });
    db.findProviderByKey.mockResolvedValue({ key: 'disk', type: 'file', status: 'active', driver: 'local-filesystem' });
});

const validate = (config: IAgentConfig) => validateAgentConfig({ tenantDbName: 't', projectId: 'p', config, agentKey: 'me' });
const fields = (issues: Array<{ field: string }>) => issues.map((issue) => issue.field);

describe('web_fetch (crawler system tool) binding', () => {
    const bind = (crawlerKey?: string) => ({
        modelKey: 'gpt-main',
        toolBindings: [{ source: 'system' as const, sourceKey: 'crawler', toolNames: ['crawler'], config: crawlerKey ? { crawlerKey } : {} }],
    });
    const withTenant = (config: IAgentConfig) => validateAgentConfig({ tenantDbName: 't', tenantId: 'tn', projectId: 'p', config, agentKey: 'me' });

    it('needs a crawler picked', () => {
        expect(fields(validateAgentConfigShape(bind() as IAgentConfig).errors)).toContain('toolBindings[0].config.crawlerKey');
    });

    it('accepts an active crawler pinned to hosts, even with credentials', async () => {
        getCrawler.mockResolvedValue({ key: 'docs', status: 'active', seeds: ['https://a.test'], scope: {}, http: { bearerToken: '********' } });
        expect((await withTenant(bind('docs') as IAgentConfig)).errors).toEqual([]);
    });

    it('rejects a missing or inactive crawler', async () => {
        getCrawler.mockResolvedValue(null);
        expect(fields((await withTenant(bind('gone') as IAgentConfig)).errors)).toContain('toolBindings[0].config.crawlerKey');
        getCrawler.mockResolvedValue({ key: 'docs', status: 'paused', seeds: ['https://a.test'], scope: {}, http: {} });
        expect((await withTenant(bind('docs') as IAgentConfig)).errors.some((e) => e.message.includes('not active'))).toBe(true);
    });

    it('rejects a credentialed crawler with no seed hosts or allow list (the model picks the URL)', async () => {
        getCrawler.mockResolvedValue({ key: 'docs', status: 'active', seeds: [], scope: {}, http: { bearerToken: '********' } });
        expect((await withTenant(bind('docs') as IAgentConfig)).errors.some((e) => e.message.includes('credentials'))).toBe(true);
    });
});

describe('validateAgentConfig', () => {
    it('accepts a correct config', async () => {
        const result = await validate({
            modelKey: 'gpt-main',
            systemPrompt: 'You triage incidents.',
            toolBindings: [{ source: 'tool', sourceKey: 'logs', toolNames: ['search_logs'] }],
            runtime: { limits: { maxCostUsd: 1, maxWallClockMs: 60_000 } },
        });
        expect(result.errors).toEqual([]);
    });

    it('rejects every reference that does not resolve — where the runtime would silently skip it', async () => {
        const result = await validate({
            modelKey: 'gone',
            promptKey: 'missing-prompt',
            knowledgeEngineKey: 'deleted-kb',
            skills: ['nope'],
            memory: { enabled: true, memoryStoreKey: 'no-store' },
            toolBindings: [
                { source: 'tool', sourceKey: 'logs', toolNames: ['search_logs', 'delete_logs'] },
                { source: 'tool', sourceKey: 'missing-tool', toolNames: ['x'] },
                { source: 'mcp', sourceKey: 'grafana', toolNames: ['query', 'admin', 'ghost'] },
            ],
        });
        expect(fields(result.errors)).toEqual(expect.arrayContaining([
            'modelKey',
            'promptKey',
            'knowledgeEngineKey',
            'skills',
            'memory.memoryStoreKey',
            'toolBindings[0].toolNames',
            'toolBindings[1]',
            'toolBindings[2].toolNames',
        ]));
        // A tool disabled on its server is skipped at run time: a warning, not a block.
        expect(result.warnings.some((w) => w.message.includes('"admin" is disabled'))).toBe(true);
    });

    it('rejects a cost limit on a model with no prices (#5 would otherwise be a silent no-op)', async () => {
        const result = await validate({ modelKey: 'unpriced', runtime: { limits: { maxCostUsd: 2 } } });
        expect(fields(result.errors)).toContain('runtime.limits.maxCostUsd');
    });

    it('rejects a non-chat model and out-of-range knobs', async () => {
        const result = await validate({
            modelKey: 'embedder',
            topP: 3,
            runtime: {
                limits: { maxToolCalls: 0, maxWallClockMs: 5, maxCostUsd: -1 },
                context: { policy: 'nonsense' as never, lastTurnsToKeep: 0 },
                planning: { replanPolicy: 'every_n_steps' },
            },
        });
        expect(fields(result.errors)).toEqual(expect.arrayContaining([
            'modelKey',
            'topP',
            'runtime.limits.maxToolCalls',
            'runtime.limits.maxWallClockMs',
            'runtime.limits.maxCostUsd',
            'runtime.context.policy',
            'runtime.context.lastTurnsToKeep',
            'runtime.planning.everyNSteps',
        ]));
    });

    it('catches sub-agent mistakes: self-reference, a cycle, duplicates, a missing target', async () => {
        const result = await validate({
            modelKey: 'gpt-main',
            subagents: [
                { kind: 'ref', name: 'self', header: 'x', agentKey: 'me' },
                { kind: 'ref', name: 'cycle', header: 'x', agentKey: 'loopy' },
                { kind: 'ref', name: 'ghost', header: 'x', agentKey: 'nobody' },
                { kind: 'inline', name: 'dup', header: 'x', systemPrompt: 'a' },
                { kind: 'inline', name: 'dup', header: '', systemPrompt: 'b' },
            ],
        });
        const messages = result.errors.map((e) => e.message).join(' | ');
        expect(messages).toContain('cannot delegate to itself');
        expect(messages).toContain('a cycle');
        expect(messages).toContain('"nobody" does not exist');
        expect(messages).toContain('Duplicate sub-agent name "dup"');
        expect(fields(result.errors)).toContain('subagents[4].header');
    });

    describe('a sub-agent that is another agent, and the variables it requires', () => {
        const target = { _id: 'a-support', key: 'tenant-support', publishedVersion: 3, config: { modelKey: 'gpt-main', variables: [] } };
        const published = (variables: unknown[]) => db.findAgentVersion.mockResolvedValue({ version: 3, snapshot: { config: { modelKey: 'gpt-main', variables } } });
        const ref = { kind: 'ref' as const, name: 'support', header: 'Answers customers', agentKey: 'tenant-support' };
        const warned = (result: { warnings: Array<{ field: string; message: string }> }) => result.warnings.filter((w) => w.field === 'subagents[0].agentKey').map((w) => w.message);

        beforeEach(() => {
            db.findAgentByKey.mockImplementation(async (key: string) => (key === 'tenant-support' ? target : null));
        });

        it('warns about a variable it requires and this agent does not declare, from the published version', async () => {
            published([
                { name: 'customer_id', type: 'string', required: true },
                { name: 'region', type: 'string', required: true },
                { name: 'tier', type: 'string', required: true, default: 'standard' },
                { name: 'note', type: 'string' },
            ]);
            const result = await validate({ modelKey: 'gpt-main', variables: [{ name: 'region', type: 'string' }], subagents: [ref] });
            expect(result.errors).toEqual([]);
            // `region` is declared here, `tier` has a default, `note` is optional: only `customer_id` cannot be filled.
            expect(warned(result)).toEqual([expect.stringContaining('requires the variable "customer_id"')]);
            expect(warned(result)[0]).toContain('stays empty');
        });

        it('names every one when several are missing', async () => {
            published([{ name: 'a', type: 'string', required: true }, { name: 'b', type: 'integer', required: true }]);
            const result = await validate({ modelKey: 'gpt-main', subagents: [ref] });
            expect(warned(result)).toEqual([expect.stringContaining('requires the variables "a", "b"')]);
        });

        it('says nothing when everything it requires can be supplied or defaulted', async () => {
            published([{ name: 'region', type: 'string', required: true }]);
            const result = await validate({ modelKey: 'gpt-main', variables: [{ name: 'region', type: 'string' }], subagents: [ref] });
            expect(warned(result)).toEqual([]);
        });
    });

    it('rejects a structured-output schema the provider cannot use', () => {
        const result = validateAgentConfigShape({
            modelKey: 'gpt-main',
            structuredOutput: { enabled: true, schema: { type: 'array' } },
        });
        expect(fields(result.errors)).toContain('structuredOutput.schema');
    });

    it('checks the declared variables: names, types, enums and defaults', () => {
        const ok = validateAgentConfigShape({
            modelKey: 'gpt-main',
            variables: [{ name: 'customer_id', type: 'string', required: true }, { name: 'tier', type: 'string', enum: ['a', 'b'], default: 'a' }],
        });
        expect(fields(ok.errors)).toEqual([]);
        const bad = validateAgentConfigShape({
            modelKey: 'gpt-main',
            variables: [
                { name: 'bad name', type: 'string' },
                { name: 'n', type: 'integer', default: 'x' },
                { name: 'n', type: 'string' },
            ],
        } as unknown as IAgentConfig);
        expect(fields(bad.errors)).toEqual(expect.arrayContaining(['variables[0].name', 'variables[1].default', 'variables[2].name']));
    });

    it('flags summary_only without summarization, and warns about the ignored askUser', () => {
        const result = validateAgentConfigShape({
            modelKey: 'gpt-main',
            runtime: { context: { policy: 'summary_only' }, summarization: { enable: false }, askUser: true },
        });
        expect(fields(result.errors)).toContain('runtime.context.policy');
        expect(fields(result.warnings)).toContain('runtime.askUser');
    });

    it('leaves a connected agent to its own connection checks', async () => {
        const result = await validate({ kind: 'external' });
        expect(result).toEqual({ errors: [], warnings: [] });
    });

    it('builds a 400 body that names the first problem and counts the rest', () => {
        const body = invalidConfigBody({
            errors: [{ field: 'modelKey', message: 'A model is required' }, { field: 'topP', message: 'x' }],
            warnings: [],
        });
        expect(body.error).toBe('Invalid agent config — modelKey: A model is required (and 1 more)');
        expect(body.validation.errors).toHaveLength(2);
    });

    it('sandbox: rejects bad limits, env names and a variable defined twice', () => {
        const result = validateAgentConfigShape({
            modelKey: 'gpt-main',
            sandbox: {
                enabled: true,
                mode: 'forever' as never,
                commandTimeoutSec: 900,
                resources: { memoryMb: 16 },
                env: { 'BAD-NAME': 'x', SHARED: 'a' },
                secrets: { SHARED: 'b' },
            },
        });
        expect(fields(result.errors)).toEqual(expect.arrayContaining([
            'sandbox.mode',
            'sandbox.commandTimeoutSec',
            'sandbox.resources.memoryMb',
            'sandbox.env.BAD-NAME',
            'sandbox.secrets',
        ]));
    });

    it('sandbox: LICENSE — refused for a tenant without Enterprise', async () => {
        sandboxAvailability.value = { available: false, reason: 'license' };
        const result = await validateAgentConfig({
            tenantDbName: 't', tenantId: 'tenant-1', projectId: 'p', agentKey: 'me',
            config: { modelKey: 'gpt-main', sandbox: { enabled: true } },
        });
        expect(result.errors).toContainEqual({ field: 'sandbox.enabled', message: 'Sandbox access requires an Enterprise license' });
        sandboxAvailability.value = { available: true };
    });

    it('sandbox: an unknown template is an error', async () => {
        sandboxAvailability.value = {
            available: true,
            runner: { listTemplates: async () => [{ key: 'multi-base', name: 'Multi base' }] },
        };
        const result = await validateAgentConfig({
            tenantDbName: 't', tenantId: 'tenant-1', projectId: 'p', agentKey: 'me',
            config: { modelKey: 'gpt-main', sandbox: { enabled: true, templateKey: 'gpu-xl' } },
        });
        expect(fields(result.errors)).toContain('sandbox.templateKey');
        sandboxAvailability.value = { available: true };
    });

    it('sandbox: enabled without a template is an error (no implicit default)', async () => {
        sandboxAvailability.value = {
            available: true,
            runner: { listTemplates: async () => [{ key: 'multi-base', name: 'Multi base' }] },
        };
        const result = await validateAgentConfig({
            tenantDbName: 't', tenantId: 'tenant-1', projectId: 'p', agentKey: 'me',
            config: { modelKey: 'gpt-main', sandbox: { enabled: true } },
        });
        expect(result.errors).toContainEqual({ field: 'sandbox.templateKey', message: 'Pick a sandbox template for this agent' });
        sandboxAvailability.value = { available: true };
    });
});

describe('validateAgentConfigShape — callback', () => {
    const shape = (callback: IAgentConfig['callback']) => validateAgentConfigShape({ modelKey: 'gpt-main', callback });

    it('accepts an https URL with a 16+ character secret', () => {
        expect(shape({ url: 'https://hooks.example.com/x', secret: 'a'.repeat(16) }).errors).toEqual([]);
    });

    it('rejects a non-http(s) callback URL, warns on plain http', () => {
        expect(fields(shape({ url: 'ftp://hooks.example.com' }).errors)).toContain('callback.url');
        const http = shape({ url: 'http://hooks.example.com/x' });
        expect(http.errors).toEqual([]);
        expect(fields(http.warnings)).toContain('callback.url');
    });

    it('rejects a short secret and a secret without a URL; the read-back mask is not re-validated', () => {
        expect(fields(shape({ url: 'https://h.example.com', secret: 'short' }).errors)).toContain('callback.secret');
        expect(fields(shape({ secret: 'a'.repeat(20) }).errors)).toContain('callback.secret');
        expect(shape({ url: 'https://h.example.com', secret: '••••••' }).errors).toEqual([]);
    });

    it('a read-back mask without a URL is accepted (it means: drop the callback secret)', () => {
        expect(shape({ secret: '••••••' }).errors).toEqual([]);
    });

    it('ignores the removed execution settings a stored config may still carry', () => {
        const legacy = { modelKey: 'gpt-main', execution: { syncTimeoutSeconds: 1, defaultMode: 'later' } } as unknown as IAgentConfig;
        expect(validateAgentConfigShape(legacy).errors).toEqual([]);
    });
});


describe('validateAgentConfig: where session files are kept', () => {
    const withFiles = (attachments: Record<string, unknown>) => validateAgentConfig({
        tenantDbName: 't', tenantId: 'tenant-1', projectId: 'p', agentKey: 'me', config: { modelKey: 'gpt-main', attachments } as IAgentConfig,
    });
    const bucketIssues = (result: { errors: Array<{ field: string; message: string }> }) => result.errors.filter((issue) => issue.field === 'attachments.bucketKey');

    it('accepts files on a bucket that can take a file — and asks the project, not the tenant at large', async () => {
        expect((await withFiles({ enabled: true, bucketKey: 'docs' })).errors).toEqual([]);
        expect(db.findFileBucketByKey).toHaveBeenCalledWith('tenant-1', 'docs', 'p');
        expect(db.findProviderByKey).toHaveBeenCalledWith('tenant-1', 'disk', 'p');
    });

    it('asks for a bucket when files are on without one', async () => {
        expect(bucketIssues(await withFiles({ enabled: true }))).toEqual([{ field: 'attachments.bucketKey', message: 'Choose a bucket to keep the files in' }]);
        expect(db.findFileBucketByKey).not.toHaveBeenCalled();
    });

    it('refuses a bucket that is not there, is disabled, or whose provider is gone, inactive or not assigned', async () => {
        db.findFileBucketByKey.mockResolvedValue(null);
        expect(bucketIssues(await withFiles({ enabled: true, bucketKey: 'docs' }))[0]!.message).toBe('The bucket "docs" does not exist in this project');

        db.findFileBucketByKey.mockResolvedValue({ key: 'docs', providerKey: 'disk', status: 'disabled' });
        expect(bucketIssues(await withFiles({ enabled: true, bucketKey: 'docs' }))[0]!.message).toBe('The bucket "docs" is disabled');

        db.findFileBucketByKey.mockResolvedValue({ key: 'docs', providerKey: 'disk', status: 'active' });
        db.findProviderByKey.mockResolvedValue({ key: 'disk', type: 'file', status: 'disabled' });
        expect(bucketIssues(await withFiles({ enabled: true, bucketKey: 'docs' }))[0]!.message).toBe('The storage provider "disk" of the bucket "docs" is not active');

        db.findProviderByKey.mockImplementation(async (_t: string, _k: string, projectId?: string) => (projectId ? null : { key: 'disk', type: 'file', status: 'active' }));
        expect(bucketIssues(await withFiles({ enabled: true, bucketKey: 'docs' }))[0]!.message).toBe('The storage provider "disk" of the bucket "docs" is not assigned to this project');

        db.findProviderByKey.mockResolvedValue(null);
        expect(bucketIssues(await withFiles({ enabled: true, bucketKey: 'docs' }))[0]!.message).toBe('The storage provider "disk" of the bucket "docs" no longer exists');
    });

    it('checks nothing about storage while files are off — a stale bucket key is not an error then', async () => {
        db.findFileBucketByKey.mockResolvedValue(null);
        expect((await withFiles({ enabled: false, bucketKey: 'gone' })).errors).toEqual([]);
        expect((await withFiles({ bucketKey: 'gone' })).errors).toEqual([]);
        expect(db.findFileBucketByKey).not.toHaveBeenCalled();
    });
});
