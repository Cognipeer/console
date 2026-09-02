/**
 * Fix 3 / #1(b) — `executeAgentChatLocal` PERSISTS THE REDACTED USER TURN.
 *
 * End to end over the local agent path with the SDK faked at the boundary:
 * the fake `createSmartAgent` runs the compiled plugins' `preModelCall`
 * handlers exactly as the host does (the returned `messages` become the wire
 * transcript; `state.messages` is left alone) and records what "the provider"
 * received. Everything console-side is real: the binding resolver, the plugin
 * compiler, the rewrite ledger, and the conversation write.
 *
 * What is pinned:
 *   1. the provider receives the placeholder, never the card number;
 *   2. the stored conversation and its title carry the placeholder;
 *   3. the next turn replays the placeholder as history — so the raw text is
 *      not re-sent by a hook that (correctly) only scans new messages.
 *
 * SYNC mock factories throughout, per this repo's vitest notes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgent, IAgentConversation } from '@/lib/database';
import type { HookCall, HookVerdict } from '@/lib/services/guardrail/hooks/contract';

const CARD = '4111 1111 1111 1111';
const MASK = '[REDACTED]';
const KEY = 'pii-redact';

const hoisted = vi.hoisted(() => ({
  runHook: vi.fn(),
  resolveGuardrail: vi.fn(),
  getModelByKey: vi.fn(),
  buildModelRuntime: vi.fn(),
  /** Every wire transcript the fake provider was handed, per invoke. */
  providerCalls: [] as Array<Array<{ role: string; content: unknown }>>,
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: hoisted.getModelByKey,
}));

vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: hoisted.buildModelRuntime,
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
    hooks: {
      contractVersion: 2,
      policies: [
        { id: 'pii:1', family: 'pii', enabled: true, hooks: ['input.pre'], schedule: { timing: 'sync', onFail: 'block' } },
      ],
      bindings: { 'input.pre': { enabled: true } },
    },
  }),
}));

/**
 * The SDK at the boundary. `pluginCapabilities` / `CONSOLE_HOOK_MAP` are what
 * the compiler probes; `createSmartAgent` is the host stand-in described above.
 */
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

  type Handler = (input: unknown, ctx: unknown) => Promise<{ decision?: string; reason?: string; messages?: unknown[] } | undefined>;
  type Plugin = { name: string; hooks?: Record<string, Handler | Handler[]> };

  const createSmartAgent = (opts: { plugins?: Plugin[]; systemPrompt?: string; model: unknown }) => ({
    invoke: async (state: { messages: Array<{ role: string; content: unknown }> }) => {
      const stores = new Map<string, Record<string, unknown>>();
      let wire = [
        ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
        ...state.messages,
      ];
      for (const plugin of opts.plugins ?? []) {
        const registered = plugin.hooks?.preModelCall;
        const handlers = Array.isArray(registered) ? registered : registered ? [registered] : [];
        for (const handler of handlers) {
          const store = stores.get(plugin.name) ?? {};
          stores.set(plugin.name, store);
          const out = await handler(
            { messages: wire, tools: [], params: {}, model: opts.model, iteration: 1 },
            { runId: 'run-1', hookName: 'preModelCall', store, depth: 0, state },
          );
          if (out?.decision === 'deny') {
            const reason = `${plugin.name}: ${out.reason ?? 'blocked'}`;
            const blockedMessages = [...state.messages, { role: 'assistant', name: 'guardrail', content: reason }];
            return {
              content: reason,
              messages: blockedMessages,
              state: { ...state, messages: blockedMessages, ctx: { __guardrailBlocked: { phase: 'request', incident: { reason, deniedBy: plugin.name, hook: 'preModelCall' } } } },
              metadata: {},
            };
          }
          // The host's rule: a `messages` mutation replaces the WIRE only.
          if (out?.messages) wire = out.messages as typeof wire;
        }
      }
      hoisted.providerCalls.push(wire);
      const answer = { role: 'assistant', content: 'Noted, thanks.' };
      const messages = [...state.messages, answer];
      return { content: answer.content, messages, state: { ...state, messages }, metadata: {} };
    },
  });

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
    fromLangchainModel: (model: unknown) => model,
    createTool: (spec: unknown) => spec,
    customSink: (config: unknown) => config,
  };
});

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { executeAgentChatLocal } from '@/lib/services/agents/agentService';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'support-agent';
const CONVERSATION_ID = 'conv-1';

function nativeAgent(): IAgent {
  return {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key: AGENT_KEY,
    name: 'Support Agent',
    config: {
      modelKey: 'gpt-4o',
      systemPrompt: 'You are terse.',
      guardrails: [{ key: KEY, hooks: ['input.pre'] }],
    },
    createdBy: 'user-1',
  } as IAgent;
}

function conversation(messages: IAgentConversation['messages'] = []): IAgentConversation {
  return {
    _id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    title: 'New conversation',
    messages,
    createdBy: 'user-1',
  };
}

/** The engine: redacts the card number wherever it appears, segment by segment. */
async function redactingRunHook(call: HookCall): Promise<HookVerdict> {
  const subject = call.subject;
  const base = {
    contractVersion: 2,
    hook: call.hook,
    mode: 'enforce',
    enforced: true,
    disabled: false,
    findings: [],
    mutations: [],
    riskScore: 0,
    codes: [],
    guardrailKeys: [KEY],
    guardrailKey: KEY,
    guardrailName: 'PII redact',
    policyVersion: `${KEY}@2026-01-01T00:00:00.000Z`,
    traceId: 'trace-1',
    latencyMs: 1,
  };
  if (subject.kind !== 'text' || !subject.text.includes(CARD)) {
    return { ...base, decision: 'allow', wouldBeDecision: 'allow' } as HookVerdict;
  }
  const segments = subject.segments.map((segment) => ({ ...segment, text: segment.text.split(CARD).join(MASK) }));
  return {
    ...base,
    decision: 'redact',
    wouldBeDecision: 'redact',
    subject: { kind: 'text', text: segments.map((segment) => segment.text).join('\n'), segments },
  } as HookVerdict;
}

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.providerCalls.length = 0;
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findAgentByKey.mockResolvedValue(nativeAgent());
  db.findAgentConversationById.mockResolvedValue(conversation());
  hoisted.getModelByKey.mockResolvedValue({
    key: 'gpt-4o',
    name: 'GPT-4o',
    category: 'llm',
    providerKey: 'openai',
    providerDriver: 'openai',
    modelId: 'gpt-4o',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    settings: {},
  });
  hoisted.buildModelRuntime.mockResolvedValue({ runtime: { createChatModel: () => ({}) } });
  hoisted.resolveGuardrail.mockResolvedValue({ key: KEY, name: 'PII redact', mode: 'enforce', enabled: true });
  hoisted.runHook.mockImplementation(redactingRunHook);
});

function request(userMessage: string) {
  return {
    tenantDbName: TENANT_DB,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId: CONVERSATION_ID,
    userMessage,
    userId: 'user-1',
  };
}

function persisted(): { messages: IAgentConversation['messages']; title?: string } {
  const [, patch] = db.updateAgentConversation.mock.calls.at(-1) as [
    string,
    { messages: IAgentConversation['messages']; title?: string },
  ];
  return patch;
}

describe('a PII-redact guardrail on input.pre, local agent path', () => {
  it('the provider receives the placeholder, never the card number', async () => {
    await executeAgentChatLocal(request(`my card is ${CARD}`));

    expect(hoisted.providerCalls).toHaveLength(1);
    const wire = hoisted.providerCalls[0];
    expect(wire.at(-1)).toEqual({ role: 'user', content: `my card is ${MASK}` });
    expect(JSON.stringify(wire)).not.toContain(CARD);
  });

  it('the stored conversation and its title carry the placeholder', async () => {
    await executeAgentChatLocal(request(`my card is ${CARD}`));

    const patch = persisted();
    expect(patch.messages[0]).toMatchObject({ role: 'user', content: `my card is ${MASK}` });
    expect(patch.title).toBe(`my card is ${MASK}`);
    expect(JSON.stringify(patch)).not.toContain(CARD);
  });

  it('the next turn replays the placeholder as history', async () => {
    await executeAgentChatLocal(request(`my card is ${CARD}`));
    const stored = persisted().messages;

    // Turn two reads back what turn one wrote.
    db.findAgentConversationById.mockResolvedValue(conversation(stored));
    const response = await executeAgentChatLocal(request('thanks, anything else needed?'));

    const wire = hoisted.providerCalls[1];
    expect(wire.some((message) => message.role === 'user' && message.content === `my card is ${MASK}`)).toBe(true);
    expect(JSON.stringify(wire)).not.toContain(CARD);
    expect(JSON.stringify(response)).not.toContain(CARD);
  });

  it('a clean message is persisted verbatim — the ledger changes nothing it did not see', async () => {
    await executeAgentChatLocal(request('what are your hours?'));
    expect(persisted().messages[0]).toMatchObject({ role: 'user', content: 'what are your hours?' });
    expect(persisted().title).toBe('what are your hours?');
  });
});
