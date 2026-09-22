import { describe, expect, it } from 'vitest';

import type { IAgentConfig } from '@/lib/database/provider/types.domain';
import {
    CONSOLE_AGENT_DEFAULTS,
    jsonSchemaToZod,
    resolveAgentRuntimeOptions,
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
        expect(resolved.memory).toBeUndefined();
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
                memory: { enabled: true, provider: 'redis', scope: 'user' },
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
        expect(resolved.memory).toEqual({ provider: 'redis', scope: 'user' });
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
