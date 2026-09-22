/**
 * Every agent setting, from the stored config to what the runtime and the UI
 * actually do with it.
 *
 * The agent config has grown a lot of surfaces — runtime profile, planning,
 * limits, context, reasoning, structured output, sub-agents, skills, memory,
 * tools, schedules — and each is resolved by a different function on its way
 * to the SDK. A setting that silently stops being applied looks exactly like
 * one that is applied: the agent still answers. These tests take one fully
 * configured agent and assert that each knob survives the whole trip.
 */

import { describe, expect, it } from 'vitest';

import type { IAgentConfig } from '@/lib/database/provider/types.domain';
import {
    CONSOLE_AGENT_DEFAULTS,
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
import { buildAgentMemoryOption } from '@/lib/services/agents/agentMemoryAdapter';
import { extractPlaygroundSteps } from '@/lib/services/agents/agentService';
import { collectConfiguredTools } from '@/components/agents/session/sessionTools';
import { summariseSession } from '@/components/agents/session/sessionUsage';
import { normalizePlaygroundUsage } from '@/lib/services/agents/playgroundUsage';
import {
    buildPromptVariables,
    renderPromptTemplate,
} from '@/lib/services/agents/promptVariables';

const AGENT = {
    key: 'field-ops',
    name: 'Field Ops',
    description: 'Answers operational questions from the runbooks.',
    status: 'active' as const,
};

/** One agent with every surface turned on, so nothing is exercised in isolation. */
const FULL_CONFIG: IAgentConfig = {
    modelKey: 'gpt-5-terra',
    temperature: 0.3,
    topP: 0.9,
    maxTokens: 8000,
    systemPrompt: 'You help {{team}} during an incident. It is {{now}}.',
    knowledgeEngineKey: 'runbooks',
    guardrails: [{ key: 'pii-redaction' }],
    toolBindings: [
        { source: 'tool', sourceKey: 'pagerduty', toolNames: ['list_incidents', 'ack_incident'] },
        { source: 'mcp', sourceKey: 'grafana', toolNames: ['query_range'] },
        { source: 'system', sourceKey: 'web_search', toolNames: ['web_search'] },
    ],
    runtime: {
        profile: 'deep',
        planning: { mode: 'planner_executor', replanPolicy: 'every_n_steps', everyNSteps: 4 },
        limits: { maxToolCalls: 25, maxCostUsd: 1.5 },
        contextPilot: { enabled: true, excludeTools: ['knowledge_search'] },
        reasoning: { enabled: true, level: 'high', effort: 'high' },
        askUser: true,
    },
    structuredOutput: {
        enabled: true,
        schema: {
            type: 'object',
            properties: {
                severity: { type: 'string', enum: ['sev1', 'sev2', 'sev3'] },
                summary: { type: 'string' },
            },
            required: ['severity', 'summary'],
        },
    },
    subagents: [
        { kind: 'inline', name: 'log-reader', header: 'Reads app logs', modelKey: 'haiku-fast' },
        { kind: 'ref', name: 'db-expert', header: 'Queries the warehouse', agentKey: 'warehouse-agent' },
    ],
    skills: ['incident-comms', 'postmortem'],
    memory: {
        enabled: true,
        memoryStoreKey: 'ops-memory',
        scope: 'user',
        writePolicy: 'always',
        readPolicy: 'hybrid',
    },
};

describe('agent settings — runtime resolution', () => {
    const resolved = resolveAgentRuntimeOptions(FULL_CONFIG);

    it('carries every runtime knob the operator set', () => {
        expect(resolved.runtimeProfile).toBe('deep');
        expect(resolved.planning).toEqual({
            mode: 'planner_executor',
            replanPolicy: 'every_n_steps',
            everyNSteps: 4,
        });
        expect(resolved.limits?.maxToolCalls).toBe(25);
        expect(resolved.limits?.maxCostUsd).toBe(1.5);
        expect(resolved.contextPilot).toEqual({ enabled: true, excludeTools: ['knowledge_search'] });
        expect(resolved.reasoning).toEqual({ enabled: true, level: 'high', native: { effort: 'high' } });
        expect(resolved.humanInTheLoop).toEqual({ askUser: true });
    });

    it('keeps the module default for a limit the operator did not touch', () => {
        // The trap this guards: resolving one field of `limits` and dropping
        // the rest, so raising maxToolCalls silently removes the context cap.
        expect(resolved.limits?.maxContextTokens).toBe(CONSOLE_AGENT_DEFAULTS.maxContextTokens);
    });

    it('emits a sub-agent policy because the agent has sub-agents', () => {
        expect(resolved.subagentPolicy?.mode).toBe('registry_only');
        expect(resolveAgentRuntimeOptions({ ...FULL_CONFIG, subagents: [] }).subagentPolicy)
            .toBeUndefined();
    });

    it('resolves a skill policy because the agent has skills', () => {
        expect(resolveAgentSkillPolicy(FULL_CONFIG)).toBeDefined();
        expect(resolveAgentSkillPolicy({ ...FULL_CONFIG, skills: [] })).toBeUndefined();
    });

    it('turns the declared output schema into one that actually validates', () => {
        const schema = resolveStructuredOutputSchema(FULL_CONFIG.structuredOutput);
        expect(schema).toBeDefined();
        expect(schema!.safeParse({ severity: 'sev1', summary: 'db down' }).success).toBe(true);
        expect(schema!.safeParse({ severity: 'sev9', summary: 'db down' }).success).toBe(false);
        expect(schema!.safeParse({ summary: 'no severity' }).success).toBe(false);
    });

    it('builds a memory store bound to the configured scope and policies', () => {
        const memory = buildAgentMemoryOption(FULL_CONFIG.memory, {
            tenantDbName: 't', tenantId: 't1', projectId: 'p1',
            agentKey: AGENT.key, conversationId: 'conv-1', userId: 'u1',
        });
        expect(memory?.scope).toBe('user');
        expect(memory?.writePolicy).toBe('always');
        expect(memory?.readPolicy).toBe('hybrid');
        expect(typeof memory?.store?.semanticSearch).toBe('function');
    });
});

describe('agent settings — what the agent can call', () => {
    it('lists every bound tool, plus knowledge and memory', () => {
        const names = collectConfiguredTools(FULL_CONFIG).map((tool) => tool.name);
        expect(names).toEqual([
            'list_incidents',
            'ack_incident',
            'query_range',
            'web_search',
            'knowledge_search',
            'knowledge_read_document',
            'knowledge_read_document_lines',
            'memory_search',
            'memory_write',
            'memory_forget',
        ]);
    });

    it('drops the knowledge tools when no engine is attached', () => {
        const names = collectConfiguredTools({ ...FULL_CONFIG, knowledgeEngineKey: undefined })
            .map((tool) => tool.name);
        expect(names).not.toContain('knowledge_search');
        expect(names).toContain('web_search');
    });

    it('drops the memory tools when memory is off', () => {
        const names = collectConfiguredTools({ ...FULL_CONFIG, memory: { enabled: false } })
            .map((tool) => tool.name);
        expect(names.filter((name) => name.startsWith('memory_'))).toEqual([]);
    });
});

describe('agent settings — prompt rendering', () => {
    const resolveFor = (metadata: Record<string, unknown>) => buildPromptVariables({
        config: FULL_CONFIG,
        agentKey: AGENT.key,
        agentName: AGENT.name,
        runtimeContext: { metadata },
    });

    it('fills declared variables from caller metadata, with built-ins last', () => {
        const resolved = resolveFor({ team: 'payments', agent: 'spoofed' });
        expect(resolved.values.team).toBe('payments');
        // Built-ins are written last so caller metadata cannot impersonate
        // the agent's own identity.
        expect(resolved.values.agent).not.toBe('spoofed');
        expect(resolved.values.now).toBeDefined();
    });

    it('renders the system prompt with those variables', () => {
        const rendered = renderPromptTemplate(FULL_CONFIG.systemPrompt!, resolveFor({ team: 'payments' }));
        expect(rendered.text).toContain('payments');
        expect(rendered.text).not.toContain('{{team}}');
        // Every placeholder the template declares got a value.
        expect(rendered.unresolved).toEqual([]);
    });

    it('names a placeholder nobody filled instead of rendering it blank', () => {
        const rendered = renderPromptTemplate(FULL_CONFIG.systemPrompt!, resolveFor({}));
        expect(rendered.unresolved).toContain('team');
    });
});

describe('agent settings — export and re-import', () => {
    const manifest = buildAgentManifest(AGENT, FULL_CONFIG);

    it('names every dependency the config references', () => {
        const ids = collectManifestDependencies(FULL_CONFIG).map((d) => `${d.type}:${d.key}`);
        expect(ids).toContain('model:gpt-5-terra');
        expect(ids).toContain('knowledge:runbooks');
        expect(ids).toContain('tool:pagerduty');
        expect(ids).toContain('mcp:grafana');
        expect(ids).toContain('agent:warehouse-agent');
    });

    it('survives a YAML round trip with its settings intact', () => {
        const restored = parseAgentManifest(serializeAgentManifest(manifest, 'yaml'));
        // validateAgentManifest returns the ISSUES, so empty means valid.
        expect(validateAgentManifest(restored)).toEqual([]);
        expect(restored.spec.runtime?.profile).toBe('deep');
        expect(restored.spec.structuredOutput?.enabled).toBe(true);
        expect(restored.spec.memory?.scope).toBe('user');
        expect(restored.spec.skills).toEqual(['incident-comms', 'postmortem']);
        expect(restored.spec.subagents).toHaveLength(2);
    });

    it('generates a project that carries the settings into code', () => {
        const project = generateAgentProject(AGENT, FULL_CONFIG, { target: 'server' });
        const source = project.files.map((file) => file.contents).join('\n');
        expect(source).toContain('deep');
        expect(source).toContain('planner_executor');
        // Tools and MCP go through console-sdk rather than being reimplemented.
        expect(source).toContain('@cognipeer/console-sdk');
        expect(project.files.some((file) => file.path === 'package.json')).toBe(true);
    });
});

describe('agent settings — what a run reports back', () => {
    it('reads the SDK usage ledger a real turn produces', () => {
        const usage = normalizePlaygroundUsage({
            perRequest: [{ id: 'r1', modelName: 'gpt-5-terra', usage: {}, timestamp: 'now', turn: 1 }],
            totals: { 'gpt-5-terra': { input: 2400, output: 310, total: 2710, cachedInput: 1800 } },
        });
        expect(usage?.usage).toEqual({
            inputTokens: 2400, outputTokens: 310, cachedInputTokens: 1800, totalTokens: 2710,
        });
    });

    it('flattens tool history with the retention substitution made visible', () => {
        const steps = extractPlaygroundSteps({
            content: 'done',
            metadata: {},
            messages: [],
            state: {
                toolHistory: [
                    {
                        executionId: 'e1',
                        toolName: 'knowledge_search',
                        args: { query: 'runbook' },
                        output: 'a summary of the result',
                        rawOutput: 'the whole result',
                        summarized: true,
                        originalTokenCount: 9000,
                        status: 'success',
                        timestamp: '2026-09-22T10:00:00Z',
                    },
                ],
            },
        } as never);

        expect(steps).toHaveLength(1);
        expect(steps[0].output).toBe('a summary of the result');
        // Without this the playground shows a summary and calls it the result.
        expect(steps[0].rawOutput).toBe('the whole result');
        expect(steps[0].summarized).toBe(true);
        expect(steps[0].originalTokenCount).toBe(9000);
        expect(steps[0].error).toBeUndefined();
    });

    it('reports a guardrail-rejected call as failed, not as an answer', () => {
        const steps = extractPlaygroundSteps({
            content: '', metadata: {}, messages: [],
            state: { toolHistory: [{ executionId: 'e1', toolName: 'ack_incident', status: 'rejected' }] },
        } as never);
        expect(steps[0].status).toBe('error');
        expect(steps[0].error).toBe('Blocked before the tool ran.');
    });

    it('catches a tool that swallowed its own error instead of throwing', () => {
        // `web_search` returns `{ ok: false, error }` rather than throwing, so
        // the SDK records status 'success'. Trusting status alone would paint
        // a failed search green.
        const steps = extractPlaygroundSteps({
            content: '', metadata: {}, messages: [],
            state: {
                toolHistory: [{
                    executionId: 'e1',
                    toolName: 'web_search',
                    status: 'success',
                    output: { ok: false, error: 'No active web search instance for this project' },
                }],
            },
        } as never);
        expect(steps[0].status).toBe('error');
        expect(steps[0].error).toContain('No active web search instance');
    });

    it('does not call a successful result failed for carrying an empty error field', () => {
        const steps = extractPlaygroundSteps({
            content: '', metadata: {}, messages: [],
            state: {
                toolHistory: [{
                    executionId: 'e1',
                    toolName: 'list_incidents',
                    status: 'success',
                    output: { incidents: [], error: null },
                }],
            },
        } as never);
        expect(steps[0].error).toBeUndefined();
        expect(steps[0].status).toBe('success');
    });

    it('totals a session from the turns it stored', () => {
        const totals = summariseSession([
            { role: 'user', content: 'what is broken' },
            {
                role: 'assistant',
                content: 'the database',
                latencyMs: 4200,
                usage: { inputTokens: 2400, outputTokens: 310, totalTokens: 2710, costUsd: 0.0182 },
            },
        ]);
        expect(totals.turns).toBe(1);
        expect(totals.totalTokens).toBe(2710);
        expect(totals.activeMs).toBe(4200);
        expect(totals.costUsd).toBeCloseTo(0.0182, 6);
        expect(totals.costComplete).toBe(true);
    });
});
