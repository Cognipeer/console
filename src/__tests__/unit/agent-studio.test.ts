import { describe, expect, it } from 'vitest';

import type { IAgentConfig } from '@/lib/database/provider/types.domain';
import {
    CONSOLE_AGENT_DEFAULTS,
    jsonSchemaToZod,
    resolveAgentRuntimeOptions,
    resolveAgentSkillPolicy,
    resolveStructuredOutputSchema,
} from '@/lib/services/agents/agentRuntimeConfig';
import {
    buildAgentManifest,
    collectManifestDependencies,
    parseAgentManifest,
    serializeAgentManifest,
    validateAgentManifest,
} from '@/lib/services/agents/agentManifest';
import { generateAgentProject } from '@/lib/services/agents/agentCodegen';
import {
    buildPromptVariables,
    collectTemplateVariables,
    renderPromptTemplate,
    shouldRenderInlinePrompt,
} from '@/lib/services/agents/promptVariables';
import {
    computeScheduleNextRun,
    readSchedules,
    validateAgentSchedule,
} from '@/lib/services/agents/agentScheduleService';
import { buildAgentMemoryOption, toConsoleScope } from '@/lib/services/agents/agentMemoryAdapter';
import {
    formatCompactTokens,
    formatCost,
    summariseSession,
} from '@/components/agents/session/sessionUsage';
import type { ChatMessage } from '@/components/agents/session/sessionTypes';
import { normalizePlaygroundUsage } from '@/lib/services/agents/playgroundUsage';
import { toSdkSkill } from '@/lib/services/agents/agentSkillService';

const AGENT = { key: 'sre-triage', name: 'SRE Triage', description: 'Triages Jira incidents', status: 'active' as const };

describe('resolveAgentRuntimeOptions', () => {
    it('reproduces the module defaults for an agent with no runtime block', () => {
        const resolved = resolveAgentRuntimeOptions({});

        expect(resolved.runtimeProfile).toBe(CONSOLE_AGENT_DEFAULTS.runtimeProfile);
        expect(resolved.planning).toEqual({ mode: 'off', replanPolicy: 'on_failure' });
        expect(resolved.limits).toEqual({
            maxToolCalls: CONSOLE_AGENT_DEFAULTS.maxToolCalls,
            maxContextTokens: CONSOLE_AGENT_DEFAULTS.maxContextTokens,
        });
        expect(resolved.context).toEqual({
            policy: 'hybrid',
            lastTurnsToKeep: CONSOLE_AGENT_DEFAULTS.lastTurnsToKeep,
            toolResponsePolicy: 'summarize_archive',
        });
        expect(resolved.toolResponses?.toolResponseRetentionByTool).toEqual({ knowledge_search: 'keep_full' });
        // Absent knobs stay absent so the SDK keeps its own profile behaviour.
        expect(resolved.contextPilot).toBeUndefined();
        expect(resolved.reasoning).toBeUndefined();
        expect(resolved.subagentPolicy).toBeUndefined();
    });

    it('lets an operator override individual knobs without losing the rest', () => {
        const resolved = resolveAgentRuntimeOptions({
            runtime: {
                profile: 'deep',
                planning: { mode: 'planner_executor', replanPolicy: 'every_n_steps', everyNSteps: 3 },
                limits: { maxToolCalls: 40, maxCostUsd: 2.5 },
                contextPilot: { enabled: true, excludeTools: ['knowledge_search'] },
                reasoning: { enabled: true, level: 'high', effort: 'medium' },
                askUser: true,
            },
        });

        expect(resolved.runtimeProfile).toBe('deep');
        expect(resolved.planning).toEqual({ mode: 'planner_executor', replanPolicy: 'every_n_steps', everyNSteps: 3 });
        expect(resolved.limits?.maxToolCalls).toBe(40);
        expect(resolved.limits?.maxCostUsd).toBe(2.5);
        // untouched knob keeps the module default
        expect(resolved.limits?.maxContextTokens).toBe(CONSOLE_AGENT_DEFAULTS.maxContextTokens);
        expect(resolved.contextPilot).toEqual({ enabled: true, excludeTools: ['knowledge_search'] });
        expect(resolved.reasoning).toEqual({ enabled: true, level: 'high', native: { effort: 'medium' } });
        expect(resolved.humanInTheLoop).toEqual({ askUser: true });
    });

    it('drops everyNSteps unless the replan policy asks for it', () => {
        const resolved = resolveAgentRuntimeOptions({
            runtime: { planning: { mode: 'todo', replanPolicy: 'on_failure', everyNSteps: 5 } },
        });
        expect(resolved.planning).toEqual({ mode: 'todo', replanPolicy: 'on_failure' });
    });

    it('emits a sub-agent policy once the agent has sub-agents', () => {
        const resolved = resolveAgentRuntimeOptions({
            subagents: [{ kind: 'inline', name: 'researcher', header: 'Digs through logs' }],
        });
        expect(resolved.subagentPolicy).toEqual({
            mode: 'registry_only',
            maxDepth: 2,
            maxChildCalls: 8,
            maxParallel: 3,
            childContextPolicy: 'scoped',
            allowAdhocTools: false,
        });
    });
});

describe('jsonSchemaToZod', () => {
    it('builds an object schema with optional and required fields', () => {
        const schema = jsonSchemaToZod({
            type: 'object',
            properties: {
                severity: { type: 'string', enum: ['low', 'high'] },
                score: { type: 'integer', minimum: 0, maximum: 10 },
                note: { type: 'string' },
            },
            required: ['severity', 'score'],
        });

        expect(schema.safeParse({ severity: 'high', score: 7 }).success).toBe(true);
        expect(schema.safeParse({ severity: 'high' }).success).toBe(false);
        expect(schema.safeParse({ severity: 'nope', score: 7 }).success).toBe(false);
        expect(schema.safeParse({ severity: 'low', score: 42 }).success).toBe(false);
    });

    it('promotes every property to required in strict mode', () => {
        const schema = jsonSchemaToZod(
            { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
            true,
        );
        expect(schema.safeParse({ a: 'x' }).success).toBe(false);
        expect(schema.safeParse({ a: 'x', b: 'y' }).success).toBe(true);
        // strict also rejects unknown keys
        expect(schema.safeParse({ a: 'x', b: 'y', c: 'z' }).success).toBe(false);
    });

    it('treats a disabled or schema-less structured output as not configured', () => {
        expect(resolveStructuredOutputSchema(undefined)).toBeUndefined();
        expect(resolveStructuredOutputSchema({ enabled: false, schema: { type: 'object' } })).toBeUndefined();
        expect(resolveStructuredOutputSchema({ enabled: true })).toBeUndefined();
        // A schema that degrades to z.any() carries no contract either.
        expect(resolveStructuredOutputSchema({ enabled: true, schema: { type: 'weird' } })).toBeUndefined();
    });
});

describe('agent manifest', () => {
    const CONFIG: IAgentConfig = {
        modelKey: 'gpt-5-terra',
        systemPrompt: 'You triage incidents.',
        knowledgeEngineKey: 'confluence-kb',
        guardrails: [{ key: 'pii-redaction' }],
        toolBindings: [
            { source: 'tool', sourceKey: 'jira-api', toolNames: ['search_issues', 'add_comment'] },
            { source: 'mcp', sourceKey: 'grafana-mcp', toolNames: [] },
            { source: 'system', sourceKey: 'browser_use', toolNames: [] },
        ],
        subagents: [
            { kind: 'inline', name: 'log-reader', header: 'Reads app logs', modelKey: 'haiku-fast' },
            { kind: 'ref', name: 'db-expert', header: 'Queries the warehouse', agentKey: 'warehouse-agent' },
        ],
    };

    it('collects every referenced key exactly once', () => {
        const deps = collectManifestDependencies(CONFIG);
        const ids = deps.map((d) => `${d.type}:${d.key}`);

        expect(ids).toContain('model:gpt-5-terra');
        expect(ids).toContain('knowledge:confluence-kb');
        expect(ids).toContain('guardrail:pii-redaction');
        expect(ids).toContain('tool:jira-api');
        expect(ids).toContain('mcp:grafana-mcp');
        expect(ids).toContain('model:haiku-fast');
        expect(ids).toContain('agent:warehouse-agent');
        // Built-in tools need nothing from the importing tenant.
        expect(ids.some((id) => id.includes('browser_use'))).toBe(false);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('never carries the encrypted connection key into the manifest', () => {
        const manifest = buildAgentManifest(
            { ...AGENT, key: 'external' },
            { kind: 'external', connection: { protocol: 'a2a', url: 'https://x.test', apiKeyEnc: 'SECRET' } },
        );
        expect(JSON.stringify(manifest)).not.toContain('SECRET');
        expect(manifest.spec.connection?.apiKeyEnc).toBeUndefined();
    });

    it('round-trips through YAML and JSON', () => {
        const manifest = buildAgentManifest(AGENT, CONFIG, 4);

        for (const format of ['json', 'yaml'] as const) {
            const text = serializeAgentManifest(manifest, format);
            const parsed = parseAgentManifest(text);
            expect(parsed.metadata.key).toBe('sre-triage');
            expect(parsed.metadata.version).toBe(4);
            expect(parsed.spec.modelKey).toBe('gpt-5-terra');
            expect(parsed.spec.subagents).toHaveLength(2);
        }
    });

    it('rejects a manifest that is missing what an agent needs to run', () => {
        expect(validateAgentManifest({ apiVersion: 'nope', kind: 'Agent' }).length).toBeGreaterThan(0);

        const issues = validateAgentManifest({
            apiVersion: 'cognipeer.console/v1',
            kind: 'Agent',
            metadata: { key: 'a', name: 'A' },
            spec: {
                subagents: [
                    { kind: 'ref', name: 'dup', header: 'x' },
                    { kind: 'inline', name: 'dup', header: 'y' },
                ],
            },
        });

        expect(issues).toContain('spec.modelKey is required for native agents');
        expect(issues).toContain('sub-agent "dup" is a reference but has no agentKey');
        expect(issues).toContain('duplicate sub-agent name "dup"');
    });

    it('reports a parse failure as a manifest error, not a crash', () => {
        expect(() => parseAgentManifest('{ not json')).toThrow(/not valid/i);
        expect(() => parseAgentManifest('   ')).toThrow(/empty/i);
    });
});

describe('agent code export', () => {
    const CONFIG: IAgentConfig = {
        modelKey: 'gpt-5-terra',
        systemPrompt: 'You triage incidents.',
        temperature: 0.2,
        knowledgeEngineKey: 'confluence-kb',
        toolBindings: [
            { source: 'tool', sourceKey: 'jira-api', toolNames: ['search_issues'] },
            { source: 'mcp', sourceKey: 'grafana-mcp', toolNames: [] },
        ],
        structuredOutput: {
            enabled: true,
            strict: true,
            schema: {
                type: 'object',
                properties: { summary: { type: 'string' }, severity: { type: 'string', enum: ['low', 'high'] } },
            },
        },
        subagents: [{ kind: 'inline', name: 'log-reader', header: 'Reads app logs' }],
    };

    function fileMap(target: 'cli' | 'server' | 'worker' | 'lambda') {
        const result = generateAgentProject(AGENT, CONFIG, { target });
        return {
            result,
            files: Object.fromEntries(result.files.map((f) => [f.path, f.contents])),
        };
    }

    it('emits a runnable project per target', () => {
        for (const target of ['cli', 'server', 'worker', 'lambda'] as const) {
            const { files } = fileMap(target);
            expect(files['package.json']).toBeDefined();
            expect(files['tsconfig.json']).toBeDefined();
            expect(files['src/agent.ts']).toBeDefined();
            expect(JSON.parse(files['package.json']).dependencies['@cognipeer/agent-sdk']).toBeDefined();
        }

        expect(fileMap('server').files['src/server.ts']).toContain('/.well-known/agent.json');
        expect(fileMap('cli').files['src/index.ts']).toContain('process.argv');
        expect(fileMap('lambda').files['src/lambda.ts']).toContain('export async function handler');
    });

    it('routes inference through the console gateway, never the provider', () => {
        const { files } = fileMap('server');
        expect(files['src/model.ts']).toContain('/api/client/v1');
        expect(files['src/model.ts']).toContain('CONSOLE_API_KEY');
        expect(files['.env.example']).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET/);
    });

    it('reaches tools and MCP servers through console-sdk', () => {
        const { files } = fileMap('server');
        const tools = files['src/tools.ts'];

        expect(files['package.json']).toContain('@cognipeer/console-sdk');
        expect(tools).toContain('console_.tools.get("jira-api")');
        expect(tools).toContain('console_.mcp.server("grafana-mcp")');
        // The allow-list from the binding survives into the generated filter.
        expect(tools).toContain('["search_issues"]');
    });

    it('carries the structured output contract into generated zod', () => {
        const { files } = fileMap('cli');
        expect(files['src/agent.ts']).toContain('outputSchema');
        expect(files['src/agent.ts']).toContain('z.enum(["low","high"])');
        expect(files['src/agent.ts']).toContain('.strict()');
    });

    it('declares tools even when only sub-agents need them', () => {
        const result = generateAgentProject(
            AGENT,
            { modelKey: 'm', subagents: [{ kind: 'inline', name: 'child', header: 'h' }] },
            { target: 'cli' },
        );
        const agentFile = result.files.find((f) => f.path === 'src/agent.ts')!.contents;
        expect(agentFile).toContain('const tools = [');
        expect(agentFile).toContain('buildSubagents(tools)');
    });

    it('warns about what does not survive the export', () => {
        const result = generateAgentProject(
            AGENT,
            {
                ...CONFIG,
                guardrails: [{ key: 'pii' }],
                promptKey: 'shared-prompt',
                toolBindings: [{ source: 'system', sourceKey: 'browser_use', toolNames: [] }],
                subagents: [{ kind: 'ref', name: 'x', header: 'h', agentKey: 'other' }],
            },
            { target: 'server' },
        );

        const joined = result.warnings.join(' | ');
        expect(joined).toMatch(/browser_use|Built-in/i);
        expect(joined).toMatch(/guardrail/i);
        expect(joined).toMatch(/shared-prompt/);
        expect(joined).toMatch(/flattened/i);
    });
});

describe('prompt variables', () => {
    it('lists only the names a template actually looks up', () => {
        const names = collectTemplateVariables(
            'Hello {{customer}}, {{#items}}{{name}}{{/items}} {{! a comment }} {{&raw}}',
        );
        expect(names).toContain('customer');
        expect(names).toContain('items');
        expect(names).toContain('raw');
        // A comment is not a variable; reporting it would train people to
        // ignore the unresolved-variable warning.
        expect(names).not.toContain('! a comment');
    });

    it('fills placeholders from the agent config', () => {
        const resolved = buildPromptVariables({
            config: { promptVariables: { product: 'Console', tone: 'formal' } },
            agentKey: 'sre',
            agentName: 'SRE',
        });
        const rendered = renderPromptTemplate('You support {{product}} in a {{tone}} tone.', resolved);

        expect(rendered.text).toBe('You support Console in a formal tone.');
        expect(rendered.unresolved).toEqual([]);
    });

    it('lets a caller override a default, and reports that it did', () => {
        const resolved = buildPromptVariables({
            config: { promptVariables: { product: 'Console' } },
            agentKey: 'sre',
            agentName: 'SRE',
            runtimeContext: { metadata: { product: 'Gateway' } },
        });
        const rendered = renderPromptTemplate('Support {{product}}.', resolved);

        expect(rendered.text).toBe('Support Gateway.');
        expect(rendered.fromCaller).toEqual(['product']);
    });

    it('refuses to let a caller forge the built-ins', () => {
        const resolved = buildPromptVariables({
            config: {},
            agentKey: 'sre',
            agentName: 'SRE Triage',
            version: 4,
            runtimeContext: { metadata: { agent: { name: 'Admin Bot' }, user: { id: 'root' } } },
        });
        const rendered = renderPromptTemplate('I am {{agent.name}} v{{agent.version}}.', resolved);

        expect(rendered.text).toBe('I am SRE Triage v4.');
        expect((resolved.values.user as { id: string | null }).id).toBeNull();
        expect(resolved.fromCaller).not.toContain('agent');
    });

    it('reports a placeholder nobody filled instead of rendering it silently', () => {
        const resolved = buildPromptVariables({ config: {}, agentKey: 'a', agentName: 'A' });
        const rendered = renderPromptTemplate('Escalate to {{oncall}} now.', resolved);

        // Still empty — changing that would break prompts relying on an
        // optional variable — but no longer invisible.
        expect(rendered.text).toBe('Escalate to  now.');
        expect(rendered.unresolved).toEqual(['oncall']);
    });

    it('renders an inline prompt only once the agent declares variables', () => {
        expect(shouldRenderInlinePrompt({})).toBe(false);
        expect(shouldRenderInlinePrompt({ systemPrompt: 'Braces {{like this}} stay literal' })).toBe(false);
        expect(shouldRenderInlinePrompt({ promptVariables: { x: '1' } })).toBe(true);
    });
});

describe('agent schedules', () => {
    const BASE = { id: 's1', name: 'Nightly digest', message: 'Summarise today.', enabled: true };

    it('rejects a schedule that cannot run', () => {
        expect(validateAgentSchedule({ ...BASE, name: '', mode: 'cron', cron: '0 2 * * *' })).toMatch(/name/i);
        expect(validateAgentSchedule({ ...BASE, message: '', mode: 'cron', cron: '0 2 * * *' })).toMatch(/message/i);
        expect(validateAgentSchedule({ ...BASE, mode: 'cron', cron: 'not a cron' })).toMatch(/cron/i);
        expect(validateAgentSchedule({ ...BASE, mode: 'cron', cron: '0 2 * * *' })).toBeNull();
    });

    it('computes the next fire from the cron, after the last run', () => {
        const from = new Date('2026-09-22T01:00:00.000Z');
        const next = computeScheduleNextRun({ ...BASE, mode: 'cron', cron: '0 2 * * *' }, from);
        expect(next?.toISOString()).toBe('2026-09-22T02:00:00.000Z');

        // A run that just happened must not re-fire on the same tick.
        const after = computeScheduleNextRun(
            { ...BASE, mode: 'cron', cron: '0 2 * * *', lastRunAt: new Date('2026-09-22T02:00:00.000Z') },
            new Date('2026-09-22T02:00:01.000Z'),
        );
        expect(after?.toISOString()).toBe('2026-09-23T02:00:00.000Z');
    });

    it('never fires while disabled', () => {
        expect(computeScheduleNextRun({ ...BASE, enabled: false, mode: 'cron', cron: '0 2 * * *' })).toBeNull();
    });

    it('reads schedules off agent metadata without disturbing its neighbours', () => {
        expect(readSchedules({ metadata: undefined })).toEqual([]);
        expect(readSchedules({ metadata: { a2a: { enabled: true } } })).toEqual([]);
        expect(readSchedules({ metadata: { schedules: [BASE] } })).toHaveLength(1);
    });
});

describe('agent skills', () => {
    it('maps a stored record onto the SDK Skill shape — no file loader involved', () => {
        const sdk = toSdkSkill({
            tenantId: 't1',
            key: 'atlassian-triage',
            title: 'Atlassian triage',
            header: 'Investigates a Jira ticket against Confluence + logs.',
            body: '## Steps\n1. Pull the ticket...',
            minModelTier: 'large',
            status: 'active',
            createdBy: 'u1',
        });

        expect(sdk).toMatchObject({
            key: 'atlassian-triage',
            title: 'Atlassian triage',
            header: 'Investigates a Jira ticket against Confluence + logs.',
            prompt: '## Steps\n1. Pull the ticket...',
            minModelTier: 'large',
        });
        // No bundled-tool support — see the module doc comment.
        expect(sdk.listToolIndex()).toEqual([]);
        expect(sdk.bindTools()).toEqual([]);
    });

    it('omits minModelTier rather than sending it as undefined when unset', () => {
        const sdk = toSdkSkill({
            tenantId: 't1',
            key: 'k',
            title: 'T',
            header: 'H',
            body: 'B',
            status: 'active',
            createdBy: 'u1',
        });
        expect('minModelTier' in sdk).toBe(false);
    });

    it('resolves a skill policy only once the agent actually has skills', () => {
        expect(resolveAgentSkillPolicy({ modelKey: 'm' })).toBeUndefined();
        expect(resolveAgentSkillPolicy({ modelKey: 'm', skills: [] })).toBeUndefined();
    });

    it('fills in console defaults for an unconfigured skill policy', () => {
        const policy = resolveAgentSkillPolicy({ modelKey: 'm', skills: ['triage'] });
        expect(policy).toEqual({
            maxOpenSkills: 3,
            maxBoundToolsPerSkill: 10,
            maxBoundToolsTotal: 20,
        });
    });

    it('lets an operator override individual skill-policy knobs', () => {
        const policy = resolveAgentSkillPolicy({
            modelKey: 'm',
            skills: ['triage'],
            skillPolicy: { maxOpenSkills: 1, disclosure: 'search' },
        });
        expect(policy?.maxOpenSkills).toBe(1);
        expect(policy?.disclosure).toBe('search');
        // untouched knob keeps the console default
        expect(policy?.maxBoundToolsTotal).toBe(20);
    });
});

describe('agent memory', () => {
    it('maps every SDK scope to a console memory scope', () => {
        expect(toConsoleScope('session')).toBe('session');
        expect(toConsoleScope('user')).toBe('user');
        // "workspace" → this agent, so two agents never share ad-hoc facts.
        expect(toConsoleScope('workspace')).toBe('agent');
        // "tenant" → the store itself is already tenant-scoped.
        expect(toConsoleScope('tenant')).toBe('global');
    });

    it('is undefined when memory is off or has no store picked', () => {
        const ctx = { tenantDbName: 't', tenantId: 't1', projectId: 'p1', agentKey: 'a' };
        expect(buildAgentMemoryOption(undefined, ctx)).toBeUndefined();
        expect(buildAgentMemoryOption({ enabled: false, memoryStoreKey: 'mem-1' }, ctx)).toBeUndefined();
        expect(buildAgentMemoryOption({ enabled: true }, ctx)).toBeUndefined();
    });

    it('builds a real MemoryStore instance once enabled with a store key', () => {
        const ctx = { tenantDbName: 't', tenantId: 't1', projectId: 'p1', agentKey: 'a', conversationId: 'conv-1', userId: 'u1' };
        const option = buildAgentMemoryOption(
            { enabled: true, memoryStoreKey: 'mem-1', scope: 'user', writePolicy: 'manual', readPolicy: 'semantic' },
            ctx,
        );
        expect(option?.scope).toBe('user');
        expect(option?.writePolicy).toBe('manual');
        expect(option?.readPolicy).toBe('semantic');
        expect(typeof option?.store?.get).toBe('function');
        expect(typeof option?.store?.upsert).toBe('function');
        expect(typeof option?.store?.markObsolete).toBe('function');
        expect(typeof option?.store?.semanticSearch).toBe('function');
    });
});

describe('session usage', () => {
    const turn = (usage?: ChatMessage['usage'], latencyMs?: number): ChatMessage => ({
        role: 'assistant',
        content: 'ok',
        ...(usage ? { usage } : {}),
        ...(latencyMs !== undefined ? { latencyMs } : {}),
    });

    it('sums only assistant turns — a user message costs nothing and takes no time', () => {
        const totals = summariseSession([
            { role: 'user', content: 'hi', latencyMs: 9999 } as ChatMessage,
            turn({ inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.001 }, 1200),
            { role: 'user', content: 'again' } as ChatMessage,
            turn({ inputTokens: 300, outputTokens: 40, totalTokens: 340, costUsd: 0.002 }, 800),
        ]);
        expect(totals.turns).toBe(2);
        expect(totals.inputTokens).toBe(400);
        expect(totals.outputTokens).toBe(60);
        expect(totals.totalTokens).toBe(460);
        expect(totals.activeMs).toBe(2000);
        expect(totals.costUsd).toBeCloseTo(0.003, 6);
        expect(totals.costComplete).toBe(true);
    });

    it('marks the total partial when a turn reported usage but carried no price', () => {
        const totals = summariseSession([
            turn({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.5 }),
            // An unpriced model, or a turn recorded before pricing existed.
            turn({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
        ]);
        expect(totals.costUsd).toBeCloseTo(0.5, 6);
        expect(totals.costComplete).toBe(false);
    });

    it('does not call a session with no usage at all partially priced', () => {
        // A brand-new session has nothing to be missing — flagging it would
        // put a "+" next to $0.00 on every session before its first turn.
        const totals = summariseSession([turn(undefined, 400)]);
        expect(totals.costComplete).toBe(true);
        expect(totals.costUsd).toBe(0);
    });

    it('keeps sub-cent costs visible instead of rounding them to $0.00', () => {
        expect(formatCost(0)).toBe('$0.00');
        expect(formatCost(0.0003)).toBe('$0.0003');
        expect(formatCost(1.234)).toBe('$1.23');
    });

    it('abbreviates token counts the way the header shows them', () => {
        expect(formatCompactTokens(942)).toBe('942');
        expect(formatCompactTokens(5432)).toBe('5.4k');
        expect(formatCompactTokens(2_500_000)).toBe('2.5M');
    });
});

describe('playground usage', () => {
    it('reads the SDK run ledger, which is keyed by model rather than flat', () => {
        // AgentInvokeResult.metadata.usage is state.usage — this exact shape.
        // Reading only flat `inputTokens` here recorded every session turn
        // with no token counts at all.
        const normalized = normalizePlaygroundUsage({
            perRequest: [{ id: 'r1', modelName: 'gpt-5-terra', usage: {}, timestamp: 'now', turn: 1 }],
            totals: { 'gpt-5-terra': { input: 1200, output: 340, total: 1540, cachedInput: 900 } },
        });
        expect(normalized?.usage).toEqual({
            inputTokens: 1200,
            outputTokens: 340,
            cachedInputTokens: 900,
            totalTokens: 1540,
        });
    });

    it('sums every model a turn touched, not just the main one', () => {
        // A summarizer or a sub-agent bills too; reporting only the main model
        // would under-report the turn.
        const normalized = normalizePlaygroundUsage({
            totals: {
                'gpt-5-terra': { input: 1000, output: 200, total: 1200, cachedInput: 0 },
                'haiku-summarizer': { input: 400, output: 50, total: 450, cachedInput: 100 },
            },
        });
        expect(normalized?.usage).toEqual({
            inputTokens: 1400,
            outputTokens: 250,
            cachedInputTokens: 100,
            totalTokens: 1650,
        });
    });

    it('still reads a flat provider-shaped usage object', () => {
        expect(normalizePlaygroundUsage({ input_tokens: 10, output_tokens: 4 })?.usage).toEqual({
            inputTokens: 10,
            outputTokens: 4,
            cachedInputTokens: undefined,
            totalTokens: 14,
        });
        expect(normalizePlaygroundUsage({ promptTokens: 7, completionTokens: 3, cacheReadInputTokens: 2 })?.usage)
            .toEqual({ inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, totalTokens: 10 });
    });

    it('reports nothing rather than zeros when a run recorded no usage', () => {
        expect(normalizePlaygroundUsage(undefined)).toBeUndefined();
        expect(normalizePlaygroundUsage({})).toBeUndefined();
        expect(normalizePlaygroundUsage({ totals: {} })).toBeUndefined();
        // An empty ledger must not beat the flat branch into claiming 0 tokens.
        expect(normalizePlaygroundUsage({ totals: { m: { input: 0, output: 0, total: 0, cachedInput: 0 } } }))
            .toBeUndefined();
    });
});
