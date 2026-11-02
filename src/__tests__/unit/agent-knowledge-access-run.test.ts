/**
 * Who the knowledge tools of a real run read for (agentService.ts, through
 * `buildLocalAgentRun`): the chat and playground entries, a trigger run, an API
 * token, and the sub-agents of a run. The builders themselves are covered by
 * agent-knowledge-access.test.ts.
 *
 * SDK faked at the boundary (same pattern as agent-reasoning-run).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgent, IAgentConversation } from '@/lib/database';

type Tool = { name: string; func: (args: Record<string, unknown>) => Promise<unknown> };
type CapturedAgent = { tools?: Tool[]; subagents?: Array<{ name: string; tools?: Tool[] }> };

const hoisted = vi.hoisted(() => ({
  runHook: vi.fn(),
  resolveGuardrail: vi.fn(),
  getModelByKey: vi.fn(),
  buildGatewayChatModel: vi.fn(),
  queryRag: vi.fn(),
  getRagDocument: vi.fn(),
  resolveModule: vi.fn(),
  resolveRagAccess: vi.fn(),
  captured: [] as unknown[],
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: hoisted.getModelByKey,
}));

vi.mock('@/lib/services/agents/gatewayChatModel', () => ({
  buildGatewayChatModel: hoisted.buildGatewayChatModel,
  isDynamicModel: () => false,
}));

vi.mock('@/lib/services/guardrail/hooks/engine', () => ({
  runHook: hoisted.runHook,
  resolveGuardrail: hoisted.resolveGuardrail,
  ensureDefaultToolGuardrail: vi.fn(async () => ({ key: 'tool-safety-default' })),
  DEFAULT_TOOL_GUARDRAIL_KEY: 'tool-safety-default',
  mergeVerdicts: vi.fn(),
  assertContractVersion: vi.fn(),
}));

vi.mock('@/lib/services/guardrail/hooks/legacy', () => ({
  ensureHooks: () => ({
    hooksVersion: 1,
    hooks: { contractVersion: 2, policies: [], bindings: {} },
  }),
}));

vi.mock('@/lib/services/rag/ragService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  queryRag: hoisted.queryRag,
  getRagDocument: hoisted.getRagDocument,
}));
vi.mock('@/lib/services/agents/bindingResolution', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveAgentKnowledgeModule: hoisted.resolveModule,
}));
vi.mock('@/lib/services/rag/access', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveRagAccess: hoisted.resolveRagAccess,
}));

/** The SDK at the boundary: keeps what `createSmartAgent` was built with, and answers once. */
vi.mock('@cognipeer/agent-sdk', () => {
  const hookNames = [
    'userPromptSubmit', 'preModelCall', 'postModelCall', 'preToolUse', 'postToolUse',
    'preFinalAnswer', 'postFinalAnswer', 'onRunStart', 'onRunEnd', 'onError', 'onStateChange',
    'preCompact', 'postCompact',
  ];
  const hooks: Record<string, unknown> = {};
  for (const name of hookNames) hooks[name] = { implemented: true };
  const CONSOLE_HOOK_MAP = {
    'prompt.pre': 'userPromptSubmit',
    'input.pre': 'preModelCall',
    'output.pre': 'postModelCall',
    'output.stream.delta': null,
    'tool.pre': 'preToolUse',
    'tool.post': 'postToolUse',
  };

  const createSmartAgent = (options: unknown) => {
    hoisted.captured.push(options);
    return {
      invoke: async (state: { messages: Array<{ role: string; content: unknown }> }) => {
        const answer = { role: 'assistant', content: 'done' };
        const messages = [...state.messages, answer];
        return { content: answer.content, messages, state: { ...state, messages }, metadata: {} };
      },
    };
  };

  return {
    version: '0.10.1',
    pluginCapabilities: () => ({
      hookContractVersion: 1,
      hooks,
      slots: {},
      features: { streamGate: { implemented: false }, traceSinkContribution: { implemented: false } },
    }),
    CONSOLE_HOOK_MAP,
    GuardrailPhase: { Request: 'request', Response: 'response' },
    createSmartAgent,
    createTool: (spec: unknown) => spec,
    customSink: (config: unknown) => config,
  };
});

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { executeAgentChatLocal, executePlaygroundChatLocal } from '@/lib/services/agents/agentService';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'librarian';
const CONVERSATION_ID = 'conv-1';

const ACL_MODULE = { key: 'kb-acl', projectId: PROJECT_ID, status: 'active', access: { enabled: true } };
const PLAIN_MODULE = { key: 'kb-plain', projectId: PROJECT_ID, status: 'active' };
const MODULES: Record<string, Record<string, unknown>> = { 'kb-acl': ACL_MODULE, 'kb-plain': PLAIN_MODULE };

function agentWith(config: Record<string, unknown>): IAgent {
  return {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key: AGENT_KEY,
    name: 'Librarian',
    config: { modelKey: 'main', systemPrompt: 'Look things up.', ...config },
    createdBy: 'user-1',
  } as IAgent;
}

function conversation(): IAgentConversation {
  return {
    _id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    title: 'New conversation',
    messages: [],
    createdBy: 'user-1',
  };
}

function scopeFor(readable: string[]) {
  const allowed = new Set(readable);
  return {
    enabled: true, manage: false, bypass: false, enforced: true,
    canReadDocument: vi.fn((doc: { _id?: unknown }) => allowed.has(String(doc._id))),
  };
}

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.captured.length = 0;
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findAgentConversationById.mockResolvedValue(conversation());
  hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => ({
    key, name: key, category: 'llm', providerKey: 'openai', providerDriver: 'openai', modelId: key,
    tenantId: TENANT_ID, projectId: PROJECT_ID, settings: {},
  }));
  hoisted.buildGatewayChatModel.mockResolvedValue({});
  hoisted.queryRag.mockReset().mockResolvedValue({ matches: [] });
  hoisted.getRagDocument.mockReset();
  hoisted.resolveModule.mockReset().mockImplementation(async (_db: string, key: string) => MODULES[key] ?? null);
  hoisted.resolveRagAccess.mockReset().mockImplementation(async () => scopeFor([]));
});

const base = {
  tenantDbName: TENANT_DB,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  agentKey: AGENT_KEY,
  conversationId: CONVERSATION_ID,
  userMessage: 'find the policy',
  userId: 'user-1',
};

const PERSON = { userId: 'user-1', source: 'portal' as const };
const TRIGGER = { userId: 'system:trigger:t1', source: 'trigger' as const, trigger: { id: 't1', type: 'schedule' } };

const person = (userId: string) => ({ kind: 'person', userId });

/** The agent the run handed to the SDK. */
const built = () => hoisted.captured[0] as CapturedAgent;
const toolOf = (tools: Tool[] | undefined, name: string) => tools!.find((tool) => tool.name === name)!;
const search = (tools: Tool[] | undefined) => toolOf(tools, 'knowledge_search').func({ query: 'policy' });
const lastQueryOptions = () => hoisted.queryRag.mock.calls.at(-1)?.[4] as Record<string, unknown>;

describe('the tools of a run read for the caller of the run', () => {
  it.each([
    ['live chat', executeAgentChatLocal],
    ['playground', executePlaygroundChatLocal],
  ] as const)('%s: the person the run is for', async (_name, execute) => {
    db.findAgentByKey.mockResolvedValue(agentWith({ knowledgeEngineKey: 'kb-acl' }));
    const scope = scopeFor(['d1']);
    hoisted.resolveRagAccess.mockResolvedValue(scope);

    await execute({ ...base, runtimeContext: PERSON } as never);
    expect(hoisted.resolveRagAccess).not.toHaveBeenCalled();
    await search(built().tools);

    expect(hoisted.resolveRagAccess).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveRagAccess.mock.calls[0][0]).toMatchObject({
      tenantDbName: TENANT_DB, tenantId: TENANT_ID, module: ACL_MODULE, caller: person('user-1'),
    });
    expect(lastQueryOptions()).toMatchObject({ caller: person('user-1') });
    expect(lastQueryOptions().access).toBe(scope);
  });

  it('a trigger run reads as nobody, not as the person who owns the trigger', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ knowledgeEngineKey: 'kb-acl' }));

    await executeAgentChatLocal({
      ...base, userId: TRIGGER.userId, runtimeContext: TRIGGER, accountableUserId: 'owner-1', unattended: true,
    } as never);
    await search(built().tools);

    expect(hoisted.resolveRagAccess.mock.calls[0][0].caller).toEqual({ kind: 'anonymous', reason: 'trigger' });
    expect(lastQueryOptions().caller).toEqual({ kind: 'anonymous', reason: 'trigger' });
  });

  it('an API token call without a person reads as the token', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ knowledgeEngineKey: 'kb-acl' }));

    await executeAgentChatLocal({
      ...base, userId: 'owner-1', runtimeContext: { userId: 'owner-1', tokenId: 'tok-1', source: 'api' },
    } as never);
    await search(built().tools);

    expect(lastQueryOptions().caller).toEqual({ kind: 'token', tokenId: 'tok-1', ownerUserId: 'owner-1' });
  });

  it('a run with no runtime context reads as an unknown caller, whoever its userId names', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ knowledgeEngineKey: 'kb-acl' }));

    await executeAgentChatLocal({ ...base } as never);
    await search(built().tools);

    expect(lastQueryOptions().caller).toEqual({ kind: 'anonymous', reason: 'unknown' });
  });

  it('answers a document the caller may not read like a missing one', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ knowledgeEngineKey: 'kb-acl' }));
    hoisted.resolveRagAccess.mockResolvedValue(scopeFor(['d1']));
    await executeAgentChatLocal({ ...base, runtimeContext: PERSON } as never);
    const read = toolOf(built().tools, 'knowledge_read_document');

    hoisted.getRagDocument.mockResolvedValue(null);
    const missing = await read.func({ documentId: 'd2' });
    hoisted.getRagDocument.mockResolvedValue({ _id: 'd2', ragModuleKey: 'kb-acl', projectId: PROJECT_ID, fileName: 'd2.md' });
    const hidden = await read.func({ documentId: 'd2' });

    expect(missing).toBe('Document not found in this knowledge base.');
    expect(hidden).toBe(missing);
  });

  it('resolves nothing for a knowledge base without access control', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ knowledgeEngineKey: 'kb-plain' }));

    await executeAgentChatLocal({ ...base, runtimeContext: PERSON } as never);
    await search(built().tools);

    expect(hoisted.queryRag).toHaveBeenCalledTimes(1);
    expect(lastQueryOptions()).not.toHaveProperty('access');
    expect(hoisted.resolveRagAccess).not.toHaveBeenCalled();
  });
});

describe('the sub-agents of a run read for the same caller', () => {
  const helper = { kind: 'inline', name: 'helper', systemPrompt: 'help', enabled: true, knowledgeEngineKey: 'kb-acl' };
  const childTools = () => built().subagents!.find((child) => child.name === 'helper')!.tools;

  it('a person\'s run', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ subagents: [helper] }));

    await executeAgentChatLocal({ ...base, runtimeContext: PERSON } as never);
    await search(childTools());

    expect(hoisted.resolveRagAccess.mock.calls[0][0].caller).toEqual(person('user-1'));
    expect(lastQueryOptions()).toMatchObject({ caller: person('user-1') });
    expect(lastQueryOptions().access).toBeDefined();
  });

  it('a trigger run', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ subagents: [helper] }));

    await executePlaygroundChatLocal({
      ...base, userId: TRIGGER.userId, runtimeContext: TRIGGER, accountableUserId: 'owner-1',
    } as never);
    await search(childTools());

    expect(lastQueryOptions().caller).toEqual({ kind: 'anonymous', reason: 'trigger' });
  });

  it('the parent and the child each resolve their own scope, for the same caller', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ knowledgeEngineKey: 'kb-acl', subagents: [helper] }));

    await executeAgentChatLocal({ ...base, runtimeContext: PERSON } as never);
    await search(built().tools);
    await search(childTools());

    const callers = hoisted.resolveRagAccess.mock.calls.map((call) => call[0].caller);
    expect(callers).toEqual([person('user-1'), person('user-1')]);
  });
});
