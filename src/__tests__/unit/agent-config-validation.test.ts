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
};

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(async () => db) }));

const sandboxAvailability = vi.hoisted(() => ({ value: { available: true } as Record<string, unknown> }));
vi.mock('@/lib/services/agents/agentSandboxTools', () => ({
    resolveSandboxAvailability: vi.fn(async () => sandboxAvailability.value),
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
});

const validate = (config: IAgentConfig) => validateAgentConfig({ tenantDbName: 't', projectId: 'p', config, agentKey: 'me' });
const fields = (issues: Array<{ field: string }>) => issues.map((issue) => issue.field);

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

    it('rejects a structured-output schema the provider cannot use', () => {
        const result = validateAgentConfigShape({
            modelKey: 'gpt-main',
            structuredOutput: { enabled: true, schema: { type: 'array' } },
        });
        expect(fields(result.errors)).toContain('structuredOutput.schema');
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

describe('validateAgentConfigShape — execution settings', () => {
    const shape = (execution: IAgentConfig['execution']) => validateAgentConfigShape({ modelKey: 'gpt-main', execution });

    it('accepts limits inside the env ceilings', () => {
        const result = shape({ syncTimeoutSeconds: 30, backgroundMaxDurationMinutes: 10, defaultMode: 'background', callbackUrl: 'https://hooks.example.com/x', callbackSecret: 'a'.repeat(16) });
        expect(result.errors).toEqual([]);
    });

    it('rejects a limit above the env ceiling (an agent can only lower it) or below the floor', () => {
        const result = shape({ syncTimeoutSeconds: 100_000, backgroundMaxDurationMinutes: 100_000 });
        expect(fields(result.errors)).toEqual(expect.arrayContaining(['execution.syncTimeoutSeconds', 'execution.backgroundMaxDurationMinutes']));
        expect(fields(shape({ syncTimeoutSeconds: 1 }).errors)).toContain('execution.syncTimeoutSeconds');
    });

    it('rejects an unknown defaultMode, and background default with background disabled', () => {
        expect(fields(shape({ defaultMode: 'later' as never }).errors)).toContain('execution.defaultMode');
        expect(fields(shape({ defaultMode: 'background', backgroundEnabled: false }).errors)).toContain('execution.defaultMode');
    });

    it('rejects a non-http(s) callback URL, warns on plain http', () => {
        expect(fields(shape({ callbackUrl: 'ftp://hooks.example.com' }).errors)).toContain('execution.callbackUrl');
        const http = shape({ callbackUrl: 'http://hooks.example.com/x' });
        expect(http.errors).toEqual([]);
        expect(fields(http.warnings)).toContain('execution.callbackUrl');
    });

    it('rejects a short secret and a secret without a URL; the read-back mask is not re-validated', () => {
        expect(fields(shape({ callbackUrl: 'https://h.example.com', callbackSecret: 'short' }).errors)).toContain('execution.callbackSecret');
        expect(fields(shape({ callbackSecret: 'a'.repeat(20) }).errors)).toContain('execution.callbackSecret');
        expect(shape({ callbackUrl: 'https://h.example.com', callbackSecret: '••••••' }).errors).toEqual([]);
    });
});
