/**
 * `buildLocalAgentRun` starts its independent builders together (agentChatRun.ts). What must not change:
 *  - the order of the tools the model is shown, whichever builder finishes first;
 *  - which error a failed build throws (the first of the original order, not the first to fail in time);
 *  - the cleanup of what the builders that finished opened, when another builder fails.
 *
 * The builders are faked at their module boundary so each can be made slow or failing; the SDK is faked the same way
 * as in agent-knowledge-access-run.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgent, IAgentConfig } from '@/lib/database';

type Tool = { name: string };

const hoisted = vi.hoisted(() => ({
  buildModel: vi.fn(),
  resolvePrompt: vi.fn(),
  buildPlugins: vi.fn(),
  buildKnowledge: vi.fn(),
  buildBound: vi.fn(),
  buildSandbox: vi.fn(),
  buildSubagents: vi.fn(),
  buildSkills: vi.fn(),
  ownerTags: vi.fn(),
  buildCost: vi.fn(),
  captured: [] as unknown[],
}));

vi.mock('@/lib/services/agents/agentRecords', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildAgentChatModel: hoisted.buildModel,
}));
vi.mock('@/lib/services/agents/agentPrompt', () => ({ resolveAgentPrompt: hoisted.resolvePrompt }));
vi.mock('@/lib/services/agents/agentGuardrails', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildAgentGuardrailPlugins: hoisted.buildPlugins,
}));
vi.mock('@/lib/services/agents/agentKnowledgeTools', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildAgentKnowledgeTools: hoisted.buildKnowledge,
}));
vi.mock('@/lib/services/agents/agentBoundTools', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildBoundTools: hoisted.buildBound,
}));
vi.mock('@/lib/services/agents/agentSandboxTools', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildAgentSandboxTools: hoisted.buildSandbox,
}));
vi.mock('@/lib/services/agents/agentSubagents', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildAgentSubagents: hoisted.buildSubagents,
  ownedAgentFlowTags: hoisted.ownerTags,
}));
vi.mock('@/lib/services/agents/agentSkillService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildAgentSkills: hoisted.buildSkills,
}));
vi.mock('@/lib/services/agents/agentCost', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildAgentCostEstimator: hoisted.buildCost,
}));
vi.mock('@/lib/services/agents/agentServiceAvailability', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  applyServiceAvailability: async (_tenantId: string, config: unknown) => config,
}));

vi.mock('@cognipeer/agent-sdk', () => {
  const hookNames = [
    'userPromptSubmit', 'preModelCall', 'postModelCall', 'preToolUse', 'postToolUse',
    'preFinalAnswer', 'postFinalAnswer', 'onRunStart', 'onRunEnd', 'onError', 'onStateChange',
    'preCompact', 'postCompact',
  ];
  const hooks: Record<string, unknown> = {};
  for (const name of hookNames) hooks[name] = { implemented: true };
  return {
    version: '0.10.1',
    pluginCapabilities: () => ({
      hookContractVersion: 1,
      hooks,
      slots: {},
      features: { streamGate: { implemented: false }, traceSinkContribution: { implemented: false } },
    }),
    CONSOLE_HOOK_MAP: {},
    GuardrailPhase: { Request: 'request', Response: 'response' },
    createSmartAgent: (options: unknown) => {
      hoisted.captured.push(options);
      return { invoke: async () => ({}) };
    },
    createTool: (spec: unknown) => spec,
    customSink: (config: unknown) => config,
  };
});

import { createMockDb } from '../helpers/db.mock';
import { buildLocalAgentRun } from '@/lib/services/agents/agentChatRun';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const after = <T>(ms: number, value: T) => async () => { await sleep(ms); return value; };
const failing = (ms: number, message: string) => async () => { await sleep(ms); throw new Error(message); };
const tool = (name: string): Tool => ({ name });

function build(configExtra: Record<string, unknown> = {}, agentExtra: Record<string, unknown> = {}) {
  const config = { modelKey: 'main', systemPrompt: 'Base prompt.', ...configExtra } as IAgentConfig;
  return buildLocalAgentRun({
    db: createMockDb() as never,
    tenantDbName: 'tenant_acme',
    tenantId: 'tenant-acme',
    projectId: 'proj-1',
    agentKey: 'agent-1',
    agent: { name: 'Agent', key: 'agent-1', config, ...agentExtra } as IAgent,
    config,
    actorId: 'user-1',
    source: 'agent',
    route: 'agent.chat',
    conversation: null,
  });
}

/** What the SDK was handed: the names of the tools, in the order the model sees them. */
const toolNames = () => ((hoisted.captured[0] as { tools?: Tool[] }).tools ?? []).map((entry) => entry.name);

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.captured.length = 0;
  hoisted.buildModel.mockImplementation(async () => ({ model: { key: 'main', modelId: 'main' }, chatModel: {} }));
  hoisted.resolvePrompt.mockImplementation(async ({ systemPrompt }: { systemPrompt?: string }) => systemPrompt);
  hoisted.buildPlugins.mockResolvedValue([]);
  hoisted.buildKnowledge.mockResolvedValue({ tools: [], toolDefinitions: [] });
  hoisted.buildBound.mockResolvedValue({ cleanupTasks: [], tools: [], definitions: [] });
  hoisted.buildSandbox.mockResolvedValue({
    tools: [], definitions: [], promptNote: '', cleanup: async () => undefined, collectOutputs: async () => ({ attachments: [], warnings: [] }),
  });
  hoisted.buildSubagents.mockResolvedValue({ subagents: [], cleanupTasks: [], models: [] });
  hoisted.buildSkills.mockResolvedValue([]);
  hoisted.ownerTags.mockResolvedValue(undefined);
  hoisted.buildCost.mockResolvedValue(undefined);
});

describe('the tool order does not depend on which builder finishes first', () => {
  const withEveryBuilder = () => {
    hoisted.buildKnowledge.mockImplementation(after(60, {
      tools: [tool('knowledge_search')], toolDefinitions: [{ name: 'knowledge_search' }],
    }));
    hoisted.buildBound.mockImplementation(after(30, {
      cleanupTasks: [], tools: [tool('bound_a'), tool('bound_b')], definitions: [{ name: 'bound_a' }, { name: 'bound_b' }],
    }));
    hoisted.buildSandbox.mockImplementation(after(1, {
      tools: [tool('sandbox_exec')], definitions: [{ name: 'sandbox_exec' }], promptNote: '', cleanup: async () => undefined,
      collectOutputs: async () => ({ attachments: [], warnings: [] }),
    }));
  };

  it('knowledge tools, then bound tools, then sandbox tools, whatever the timing', async () => {
    withEveryBuilder();
    await build({ knowledgeEngineKey: 'kb' });
    expect(toolNames()).toEqual(['knowledge_search', 'bound_a', 'bound_b', 'sandbox_exec']);
  });

  it('keeps the same order when the builders finish the other way round', async () => {
    withEveryBuilder();
    hoisted.buildKnowledge.mockImplementation(after(1, {
      tools: [tool('knowledge_search')], toolDefinitions: [{ name: 'knowledge_search' }],
    }));
    hoisted.buildSandbox.mockImplementation(after(60, {
      tools: [tool('sandbox_exec')], definitions: [{ name: 'sandbox_exec' }], promptNote: '', cleanup: async () => undefined,
      collectOutputs: async () => ({ attachments: [], warnings: [] }),
    }));
    await build({ knowledgeEngineKey: 'kb' });
    expect(toolNames()).toEqual(['knowledge_search', 'bound_a', 'bound_b', 'sandbox_exec']);
  });

  it('puts the knowledge instruction in front of the prompt, and hands the sub-agents the finished model', async () => {
    withEveryBuilder();
    const run = await build({ knowledgeEngineKey: 'kb' });
    expect(run.systemPrompt).toMatch(/^Knowledge-base-first policy:/);
    expect(run.systemPrompt).toMatch(/Base prompt\.$/);
    expect(hoisted.buildSubagents).toHaveBeenCalledTimes(1);
    expect(hoisted.buildCost.mock.calls[0][1]).toMatchObject({ key: 'main' });
  });

  it('starts the builders together: the next builder starts while the slowest one is still running', async () => {
    const log: string[] = [];
    hoisted.buildKnowledge.mockImplementation(async () => {
      log.push('knowledge:start');
      await sleep(40);
      log.push('knowledge:end');
      return { tools: [], toolDefinitions: [] };
    });
    hoisted.buildBound.mockImplementation(async () => {
      log.push('bound:start');
      return { cleanupTasks: [], tools: [], definitions: [] };
    });
    hoisted.buildSkills.mockImplementation(async () => {
      log.push('skills:start');
      return [];
    });
    await build({ knowledgeEngineKey: 'kb' });
    expect(log.indexOf('bound:start')).toBeLessThan(log.indexOf('knowledge:end'));
    expect(log.indexOf('skills:start')).toBeLessThan(log.indexOf('knowledge:end'));
  });

  it('keeps the warnings in the order the serial build emitted them: sandbox, then sub-agents', async () => {
    hoisted.buildSandbox.mockImplementation(async (input: { onWarning: (message: string) => void }) => {
      await sleep(40);
      input.onWarning('sandbox warning');
      return { tools: [], definitions: [], promptNote: '', cleanup: async () => undefined, collectOutputs: async () => ({ attachments: [], warnings: [] }) };
    });
    hoisted.buildSubagents.mockImplementation(async (input: { onWarning: (message: string) => void }) => {
      input.onWarning('sub-agent warning');
      return { subagents: [], cleanupTasks: [], models: [] };
    });
    const run = await build();
    expect([...run.warnings]).toEqual(['sandbox warning', 'sub-agent warning']);
  });
});

describe('a builder that fails', () => {
  it('closes what the builders that finished opened, and throws the failure', async () => {
    const closeBrowser = vi.fn(async () => undefined);
    const closeSandbox = vi.fn(async () => undefined);
    hoisted.buildBound.mockImplementation(after(5, { cleanupTasks: [closeBrowser], tools: [tool('bound_a')], definitions: [] }));
    hoisted.buildSandbox.mockImplementation(after(5, {
      tools: [], definitions: [], promptNote: '', cleanup: closeSandbox, collectOutputs: async () => ({ attachments: [], warnings: [] }),
    }));
    hoisted.buildSubagents.mockImplementation(async () => {
      await sleep(20);
      throw new Error('sub-agent roster failed');
    });

    await expect(build()).rejects.toThrow('sub-agent roster failed');

    expect(closeBrowser).toHaveBeenCalledTimes(1);
    expect(closeSandbox).toHaveBeenCalledTimes(1);
    expect(hoisted.captured).toHaveLength(0);
  });

  it('closes what a slow builder opened after a fast builder had already failed', async () => {
    const closeBrowser = vi.fn(async () => undefined);
    hoisted.buildBound.mockImplementation(after(40, { cleanupTasks: [closeBrowser], tools: [], definitions: [] }));
    hoisted.buildSkills.mockImplementation(failing(1, 'skills unavailable'));

    await expect(build()).rejects.toThrow('skills unavailable');

    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('closes the tools of the sub-agents that were built when a later builder fails', async () => {
    const closeChild = vi.fn(async () => undefined);
    hoisted.buildSubagents.mockImplementation(after(5, { subagents: [], cleanupTasks: [closeChild], models: [] }));
    hoisted.ownerTags.mockImplementation(failing(15, 'owner lookup failed'));

    await expect(build({}, { owner: { type: 'flow', key: 'flow-1' } })).rejects.toThrow('owner lookup failed');

    expect(closeChild).toHaveBeenCalledTimes(1);
  });

  it('leaves the cleanup to the caller when the build succeeds', async () => {
    const closeBrowser = vi.fn(async () => undefined);
    const closeSandbox = vi.fn(async () => undefined);
    const closeChild = vi.fn(async () => undefined);
    hoisted.buildBound.mockResolvedValue({ cleanupTasks: [closeBrowser], tools: [], definitions: [] });
    hoisted.buildSandbox.mockResolvedValue({
      tools: [], definitions: [], promptNote: '', cleanup: closeSandbox, collectOutputs: async () => ({ attachments: [], warnings: [] }),
    });
    hoisted.buildSubagents.mockResolvedValue({ subagents: [], cleanupTasks: [closeChild], models: [] });

    const run = await build();

    expect(run.cleanupTasks).toEqual([closeBrowser, closeSandbox, closeChild]);
    expect([closeBrowser, closeSandbox, closeChild].every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });
});

describe('which error wins', () => {
  it('is the first of the original order, even when a later builder fails sooner', async () => {
    // Serially the knowledge tools were built before the skills: their failure is the one a caller saw.
    hoisted.buildKnowledge.mockImplementation(failing(40, 'knowledge engine unreachable'));
    hoisted.buildSkills.mockImplementation(failing(1, 'skills unavailable'));

    await expect(build({ knowledgeEngineKey: 'kb' })).rejects.toThrow('knowledge engine unreachable');
  });

  it('is the model failure when the model and a tool builder both fail', async () => {
    hoisted.buildModel.mockImplementation(failing(40, 'model not available'));
    hoisted.buildBound.mockImplementation(failing(1, 'tool bridge failed'));

    await expect(build()).rejects.toThrow('model not available');
  });

  it('is the bound-tool failure when it and the sub-agents both fail', async () => {
    hoisted.buildBound.mockImplementation(failing(30, 'tool bridge failed'));
    hoisted.buildSubagents.mockImplementation(failing(1, 'sub-agent roster failed'));

    await expect(build()).rejects.toThrow('tool bridge failed');
  });
});
