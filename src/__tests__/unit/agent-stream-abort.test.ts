/**
 * Agent turns that stream and can be aborted (realtime voice: barge-in).
 *
 * Pins, end to end over the agent service with the SDK and the connected-agent
 * transport faked at their boundaries:
 *
 *   1. `signal` reaches the SDK as `cancellationToken` — alone, or merged with
 *      an `AgentRunCancellationCell` into one token;
 *   2. an aborted turn RESOLVES with the text streamed so far and
 *      `stopReason: 'cancelled'`, also when the in-flight model call rejected
 *      because of the abort; a non-abort failure still rejects;
 *   3. connected agents get `onTextChunk` + `signal`; a non-streamed answer is
 *      emitted once, AFTER `output.pre`; a cancelled partial is guarded only
 *      when it is about to be persisted;
 *   4. the routed entry points strip functions/signals out of the queue
 *      payload and hand them to the cluster relay instead; the worker side
 *      (`agentRelayCallbacks`) wires only what the caller listens for;
 *   5. `resolveAgentVoiceVersion`.
 *
 * SYNC mock factories throughout, per this repo's vitest notes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgent, IAgentConfig, IAgentConversation, IExternalAgentConnection } from '@/lib/database';
import type { GuardrailEvaluationResult } from '@/lib/services/guardrail';

type InvokeImpl = (
  state: { messages: Array<{ role: string; content: unknown }> },
  config: Record<string, unknown>,
) => Promise<unknown>;

const hoisted = vi.hoisted(() => ({
  runHook: vi.fn(),
  resolveGuardrail: vi.fn(),
  getModelByKey: vi.fn(),
  buildModelRuntime: vi.fn(),
  invokeExternalAgent: vi.fn(),
  evaluateGuardrail: vi.fn(),
  routeInstanceCall: vi.fn(),
  invokeConfigs: [] as Array<Record<string, unknown>>,
  invokeImpl: null as InvokeImpl | null,
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/core/cluster', () => ({
  routeInstanceCall: hoisted.routeInstanceCall,
}));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: hoisted.getModelByKey,
}));

vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: hoisted.buildModelRuntime,
}));

vi.mock('@/lib/services/agents/externalAgent', () => ({
  invokeExternalAgent: hoisted.invokeExternalAgent,
}));

vi.mock('@/lib/services/guardrail/guardrailService', () => ({
  evaluateGuardrail: hoisted.evaluateGuardrail,
  createGuardrail: vi.fn(),
  updateGuardrail: vi.fn(),
  deleteGuardrail: vi.fn(),
  getGuardrail: vi.fn(),
  getGuardrailByKey: vi.fn(),
  listGuardrails: vi.fn(),
  serializeGuardrail: vi.fn(),
  buildDefaultPresetPolicy: vi.fn(),
  buildDefaultPolicy: vi.fn(),
  PII_CATEGORIES: [],
  MODERATION_CATEGORIES: [],
  PROMPT_SHIELD_ISSUES: [],
  WORD_FILTER_BUILTIN_LISTS: [],
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

/** The SDK at the boundary; `invokeImpl` decides what a run does. */
vi.mock('@cognipeer/agent-sdk', () => {
  const hookNames = [
    'userPromptSubmit', 'preModelCall', 'postModelCall', 'preToolUse', 'postToolUse',
    'preFinalAnswer', 'postFinalAnswer', 'onRunStart', 'onRunEnd', 'onError', 'onStateChange',
    'preCompact', 'postCompact',
  ];
  const hooks: Record<string, unknown> = {};
  for (const name of hookNames) hooks[name] = { implemented: true };

  const createSmartAgent = () => ({
    invoke: async (
      state: { messages: Array<{ role: string; content: unknown }> },
      config?: Record<string, unknown>,
    ) => {
      hoisted.invokeConfigs.push(config ?? {});
      if (hoisted.invokeImpl) return hoisted.invokeImpl(state, config ?? {});
      const answer = { role: 'assistant', content: 'Full answer.' };
      const messages = [...state.messages, answer];
      return { content: answer.content, messages, state: { ...state, messages }, metadata: {} };
    },
  });

  return {
    version: '0.10.4',
    pluginCapabilities: () => ({
      hookContractVersion: 1,
      hooks,
      slots: {},
      features: { streamGate: { implemented: false }, traceSinkContribution: { implemented: false } },
    }),
    CONSOLE_HOOK_MAP: {
      'prompt.pre': 'userPromptSubmit',
      'input.pre': 'preModelCall',
      'output.pre': 'postModelCall',
      'output.stream.delta': null,
      'tool.pre': 'preToolUse',
      'tool.post': 'postToolUse',
    },
    GuardrailPhase: { Request: 'request', Response: 'response' },
    createSmartAgent,
    fromLangchainModel: (model: unknown) => model,
    createTool: (spec: unknown) => spec,
    customSink: (config: unknown) => config,
  };
});

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import {
  agentRelayCallbacks,
  executeAgentChat,
  executeAgentChatLocal,
  executePlaygroundChat,
  executePlaygroundChatLocal,
  resolveAgentVoiceVersion,
} from '@/lib/services/agents/agentService';
import type { WorkerRelay } from '@/lib/core/cluster';

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'voice-agent';
const CONVERSATION_ID = 'conv-1';

const CONNECTION: IExternalAgentConnection = {
  protocol: 'openai-chat',
  url: 'https://partner.example/v1',
  model: 'gpt-4o-mini',
};

const OUTPUT_GUARDED: Partial<IAgentConfig> = { guardrails: [{ key: 'gr-out', hooks: ['output.pre'] }] };

function nativeAgent(): IAgent {
  return {
    _id: 'agent-1',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key: AGENT_KEY,
    name: 'Voice Agent',
    config: { modelKey: 'gpt-4o', systemPrompt: 'You are terse.' },
    createdBy: 'user-1',
  } as IAgent;
}

function connectedAgent(bindings: Partial<IAgentConfig> = {}): IAgent {
  return {
    _id: 'agent-2',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key: AGENT_KEY,
    name: 'Partner Agent',
    config: { kind: 'external', connection: CONNECTION, ...bindings },
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

function playground(extra: Record<string, unknown> = {}) {
  return {
    tenantDbName: TENANT_DB,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    userMessage: 'what are your hours?',
    ...extra,
  };
}

function chat(extra: Record<string, unknown> = {}) {
  return {
    tenantDbName: TENANT_DB,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId: CONVERSATION_ID,
    userMessage: 'what are your hours?',
    userId: 'user-1',
    ...extra,
  };
}

function allow(guardrailKey: string): GuardrailEvaluationResult {
  return { passed: true, blocked: false, guardrailKey, guardrailName: guardrailKey, action: 'block', findings: [] };
}

function redacted(guardrailKey: string, redactedText: string): GuardrailEvaluationResult {
  return { ...allow(guardrailKey), action: 'redact', redactedText };
}

/**
 * A run that streams `chunks` through the SDK's `onStream`, then waits on the
 * cancellation token and REJECTS when it aborts — a provider that honours the
 * abort signal mid-call.
 */
function streamThenRejectOnAbort(chunks: string[]): InvokeImpl {
  return async (_state, config) => {
    const onStream = config.onStream as ((c: { text: string }) => void) | undefined;
    const token = config.cancellationToken as AbortSignal;
    for (const text of chunks) onStream?.({ text });
    await new Promise<never>((_resolve, reject) => {
      const fail = () => reject(new DOMException('This operation was aborted', 'AbortError'));
      if (token.aborted) fail();
      else token.addEventListener('abort', fail, { once: true });
    });
  };
}

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.invokeConfigs.length = 0;
  hoisted.invokeImpl = null;
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
  hoisted.evaluateGuardrail.mockImplementation(async (params: { guardrailKey: string }) => allow(params.guardrailKey));
  hoisted.routeInstanceCall.mockImplementation(async (_ctx: unknown, _payload: unknown, local: () => Promise<unknown>) => local());
});

/* ── 1–2. Internal agents ────────────────────────────────────────────────── */

describe('internal agent — playground turn with a signal', () => {
  it('hands the signal to the SDK as cancellationToken, next to streaming', async () => {
    const controller = new AbortController();
    await executePlaygroundChatLocal(playground({ signal: controller.signal, onTextChunk: vi.fn() }));
    expect(hoisted.invokeConfigs[0].cancellationToken).toBe(controller.signal);
    expect(hoisted.invokeConfigs[0].stream).toBe(true);
  });

  it('an agent bound to output.pre does not stream tokens: the caller gets the guarded answer', async () => {
    db.findAgentByKey.mockResolvedValue({
      ...nativeAgent(),
      config: { ...nativeAgent().config, ...OUTPUT_GUARDED },
    } as IAgent);
    const controller = new AbortController();
    const chunks: string[] = [];
    const result = await executePlaygroundChatLocal(playground({
      signal: controller.signal,
      onTextChunk: (t: string) => chunks.push(t),
    }));
    expect(hoisted.invokeConfigs[0].stream).toBeUndefined();
    expect(hoisted.invokeConfigs[0].onStream).toBeUndefined();
    expect(hoisted.invokeConfigs[0].cancellationToken).toBe(controller.signal);
    expect(chunks).toEqual([]); // the caller delivers result.content itself
    expect(result.content).toBe('Full answer.');
  });

  it('an abort that makes the model call reject resolves with the streamed text, cancelled', async () => {
    const controller = new AbortController();
    hoisted.invokeImpl = streamThenRejectOnAbort(['Open ', 'nine to ']);
    const chunks: string[] = [];

    const result = await executePlaygroundChatLocal(playground({
      signal: controller.signal,
      onTextChunk: (text: string) => {
        chunks.push(text);
        if (chunks.length === 2) controller.abort();
      },
    }));

    expect(chunks).toEqual(['Open ', 'nine to ']);
    expect(result).toMatchObject({ content: 'Open nine to ', stopReason: 'cancelled', stopDetail: 'aborted' });
    expect(typeof result.latencyMs).toBe('number');
  });

  it('a cancel the SDK itself reports (it resolved) keeps the normal outcome path', async () => {
    const controller = new AbortController();
    hoisted.invokeImpl = async (state) => {
      controller.abort();
      const messages = [...state.messages, { role: 'assistant', content: 'Partial' }];
      return {
        content: 'Partial',
        messages,
        state: { messages, ctx: { __cancelled: { stage: 'model', reason: 'aborted' } } },
        metadata: {},
      };
    };
    const result = await executePlaygroundChatLocal(playground({ signal: controller.signal }));
    expect(result).toMatchObject({ content: 'Partial', stopReason: 'cancelled', stopDetail: 'aborted' });
  });

  it('a failure that is not the caller\'s abort still rejects', async () => {
    hoisted.invokeImpl = async () => {
      throw new Error('provider 500');
    };
    await expect(executePlaygroundChatLocal(playground({ signal: new AbortController().signal })))
      .rejects.toThrow('provider 500');
  });

  it('a Session turn aborted mid-call is persisted as cancelled', async () => {
    const controller = new AbortController();
    hoisted.invokeImpl = streamThenRejectOnAbort(['Hi']);
    db.findAgentConversationById.mockResolvedValue({ ...conversation(), agentKey: AGENT_KEY });

    await executePlaygroundChatLocal(playground({
      conversationId: CONVERSATION_ID,
      signal: controller.signal,
      onTextChunk: () => controller.abort(),
    }));

    expect(db.updateAgentConversation).toHaveBeenCalledTimes(1);
    const [, patch] = db.updateAgentConversation.mock.calls[0] as [string, { messages: IAgentConversation['messages'] }];
    expect(patch.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Hi', stopReason: 'cancelled' });
  });
});

describe('internal agent — chat turn with a signal', () => {
  it('signal alone: the SDK gets the signal itself', async () => {
    const controller = new AbortController();
    await executeAgentChatLocal(chat({ signal: controller.signal }));
    expect(hoisted.invokeConfigs[0].cancellationToken).toBe(controller.signal);
  });

  it('signal + cancellation cell: one merged token that the caller\'s abort trips', async () => {
    const controller = new AbortController();
    let tokenAtStart: AbortSignal | undefined;
    hoisted.invokeImpl = async (state, config) => {
      tokenAtStart = config.cancellationToken as AbortSignal;
      expect(tokenAtStart).not.toBe(controller.signal);
      expect(tokenAtStart.aborted).toBe(false);
      controller.abort();
      expect(tokenAtStart.aborted).toBe(true);
      const messages = [...state.messages, { role: 'assistant', content: 'x' }];
      return { content: 'x', messages, state: { messages }, metadata: {} };
    };
    await executeAgentChatLocal(chat({ signal: controller.signal, cancellationCell: { cancelled: false } }));
    expect(tokenAtStart).toBeInstanceOf(AbortSignal);
  });

  it('an abort that makes the call reject resolves cancelled and persists nothing', async () => {
    const controller = new AbortController();
    hoisted.invokeImpl = streamThenRejectOnAbort(['We open ']);

    const response = await executeAgentChatLocal(chat({
      signal: controller.signal,
      onTextChunk: () => controller.abort(),
    }));

    expect(response.status).toBe('incomplete');
    expect(response.stop_reason).toBe('cancelled');
    expect(response.incomplete_details).toEqual({ reason: 'cancelled' });
    const message = response.output.find((item) => item.type === 'message');
    expect(message && 'content' in message ? message.content[0].text : undefined).toBe('We open ');
    expect(db.updateAgentConversation).not.toHaveBeenCalled();
  });
});

/* ── 3. Connected agents ─────────────────────────────────────────────────── */

describe('connected agent — streaming and abort', () => {
  beforeEach(() => {
    db.findAgentByKey.mockResolvedValue(connectedAgent(OUTPUT_GUARDED));
  });

  it('passes onTextChunk and signal to the transport (no output guardrail)', async () => {
    db.findAgentByKey.mockResolvedValue(connectedAgent());
    hoisted.invokeExternalAgent.mockResolvedValue({ content: 'ok', raw: {}, streamed: true });
    const controller = new AbortController();
    const onTextChunk = vi.fn();
    await executePlaygroundChatLocal(playground({ onTextChunk, signal: controller.signal }));
    const options = hoisted.invokeExternalAgent.mock.calls[0][4] as { onTextChunk?: unknown; signal?: unknown };
    expect(options.onTextChunk).toBe(onTextChunk);
    expect(options.signal).toBe(controller.signal);
  });

  it('an agent bound to output.pre is never asked to stream: only the guarded answer reaches the caller', async () => {
    // The transport would stream the raw answer if it were handed onTextChunk.
    hoisted.invokeExternalAgent.mockImplementation(async (_c, _m, _x, _h, options: { onTextChunk?: (t: string) => void }) => {
      options.onTextChunk?.('Your card 4111 1111 1111 1111 is on file.');
      return { content: 'Your card 4111 1111 1111 1111 is on file.', raw: {}, streamed: Boolean(options.onTextChunk) };
    });
    hoisted.evaluateGuardrail.mockImplementation(async (params: { guardrailKey: string }) =>
      params.guardrailKey === 'gr-out' ? redacted('gr-out', 'Your card [REDACTED] is on file.') : allow(params.guardrailKey));
    const controller = new AbortController();
    const chunks: string[] = [];

    const result = await executePlaygroundChatLocal(playground({ onTextChunk: (t: string) => chunks.push(t), signal: controller.signal }));

    const options = hoisted.invokeExternalAgent.mock.calls[0][4] as { onTextChunk?: unknown; signal?: unknown };
    expect(options.onTextChunk).toBeUndefined();
    expect(options.signal).toBe(controller.signal);
    expect(chunks).toEqual(['Your card [REDACTED] is on file.']);
    expect(result.content).toBe('Your card [REDACTED] is on file.');
  });

  it('a streamed answer is not emitted a second time', async () => {
    db.findAgentByKey.mockResolvedValue(connectedAgent());
    hoisted.invokeExternalAgent.mockImplementation(async (_c, _m, _x, _h, options: { onTextChunk: (t: string) => void }) => {
      options.onTextChunk('Str');
      options.onTextChunk('eamed');
      return { content: 'Streamed', raw: {}, streamed: true };
    });
    const chunks: string[] = [];
    const result = await executePlaygroundChatLocal(playground({ onTextChunk: (t: string) => chunks.push(t) }));
    expect(chunks).toEqual(['Str', 'eamed']);
    expect(result.content).toBe('Streamed');
  });

  it('a one-piece answer is emitted once, AFTER output.pre (the guarded text)', async () => {
    hoisted.invokeExternalAgent.mockResolvedValue({ content: 'Call Jane at 555-0100', raw: {}, streamed: false });
    hoisted.evaluateGuardrail.mockImplementation(async (params: { guardrailKey: string }) =>
      params.guardrailKey === 'gr-out' ? redacted('gr-out', 'Call [NAME] at [PHONE]') : allow(params.guardrailKey));
    const chunks: string[] = [];
    const result = await executePlaygroundChatLocal(playground({ onTextChunk: (t: string) => chunks.push(t) }));
    expect(chunks).toEqual(['Call [NAME] at [PHONE]']);
    expect(result.content).toBe('Call [NAME] at [PHONE]');
  });

  it('stateless + cancelled: resolves with the partial, no output.pre (it is what the caller already has)', async () => {
    db.findAgentByKey.mockResolvedValue(connectedAgent());
    hoisted.invokeExternalAgent.mockResolvedValue({ content: 'Half', raw: {}, streamed: true, cancelled: true });
    const result = await executePlaygroundChatLocal(playground({ signal: new AbortController().signal, onTextChunk: vi.fn() }));
    expect(result).toMatchObject({ content: 'Half', stopReason: 'cancelled', stopDetail: 'aborted' });
    expect(hoisted.evaluateGuardrail).not.toHaveBeenCalled();
  });

  it('stateless + cancelled with output.pre: nothing unchecked is returned (the caller received nothing)', async () => {
    hoisted.invokeExternalAgent.mockResolvedValue({ content: 'Jane is', raw: {}, streamed: false, cancelled: true });
    const chunks: string[] = [];
    const result = await executePlaygroundChatLocal(playground({
      signal: new AbortController().signal,
      onTextChunk: (t: string) => chunks.push(t),
    }));
    expect(result).toMatchObject({ content: '', stopReason: 'cancelled' });
    expect(chunks).toEqual([]);
  });

  it('chat (persisted) + cancelled: the partial is guarded, persisted and reported as cancelled', async () => {
    hoisted.invokeExternalAgent.mockResolvedValue({ content: 'Jane is', raw: {}, streamed: true, cancelled: true });
    hoisted.evaluateGuardrail.mockImplementation(async (params: { guardrailKey: string }) =>
      params.guardrailKey === 'gr-out' ? redacted('gr-out', '[NAME] is') : allow(params.guardrailKey));

    const response = await executeAgentChatLocal(chat({ signal: new AbortController().signal }));

    expect(response.stop_reason).toBe('cancelled');
    expect(response.status).toBe('incomplete');
    const [, patch] = db.updateAgentConversation.mock.calls[0] as [string, { messages: IAgentConversation['messages'] }];
    expect(patch.messages.at(-1)).toMatchObject({ role: 'assistant', content: '[NAME] is', stopReason: 'cancelled' });
  });

  it('chat without a signal: the connected agent now streams through onTextChunk too', async () => {
    hoisted.invokeExternalAgent.mockResolvedValue({ content: 'One piece', raw: {}, streamed: false });
    const chunks: string[] = [];
    const response = await executeAgentChatLocal(chat({ onTextChunk: (t: string) => chunks.push(t) }));
    expect(chunks).toEqual(['One piece']);
    expect(response.status).toBe('completed');
    expect(response.stop_reason).toBeUndefined();
  });
});

/* ── 4. Routing + relay wiring ───────────────────────────────────────────── */

describe('routed entry points', () => {
  it('executePlaygroundChat keeps functions and the signal out of the queue payload and relays them', async () => {
    hoisted.routeInstanceCall.mockResolvedValue({ content: 'remote' });
    const controller = new AbortController();
    const onTextChunk = vi.fn();
    const onToolEvent = vi.fn();
    const onCompaction = vi.fn();

    await executePlaygroundChat(playground({ onTextChunk, onToolEvent, onCompaction, signal: controller.signal }));

    const [ctx, payload, , options] = hoisted.routeInstanceCall.mock.calls[0] as [
      { jobName: string },
      Record<string, unknown>,
      unknown,
      { relay: { handlers: Record<string, (d: unknown) => void>; signal?: AbortSignal } },
    ];
    expect(ctx.jobName).toBe('playground');
    for (const key of ['onTextChunk', 'onToolEvent', 'onCompaction', 'signal']) expect(payload).not.toHaveProperty(key);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload); // plain data only
    expect(options.relay.signal).toBe(controller.signal);

    options.relay.handlers.text('chunk');
    options.relay.handlers.tool({ phase: 'start', name: 'search' });
    options.relay.handlers.compaction({ at: 'now' });
    expect(onTextChunk).toHaveBeenCalledWith('chunk');
    expect(onToolEvent).toHaveBeenCalledWith({ phase: 'start', name: 'search' });
    expect(onCompaction).toHaveBeenCalledWith({ at: 'now' });
  });

  it('executePlaygroundChat without callbacks offers the relay nothing to listen for', async () => {
    hoisted.routeInstanceCall.mockResolvedValue({ content: 'remote' });
    await executePlaygroundChat(playground());
    const options = hoisted.routeInstanceCall.mock.calls[0][3] as { relay: { handlers: Record<string, unknown>; signal?: unknown } };
    expect(Object.values(options.relay.handlers).filter(Boolean)).toEqual([]);
    expect(options.relay.signal).toBeUndefined();
  });

  it('executeAgentChat strips onTextChunk/signal and keeps the ceiling options', async () => {
    hoisted.routeInstanceCall.mockResolvedValue({ id: 'resp' });
    const deadlineAt = Date.now() + 30_000;
    await executeAgentChat(chat({
      onTextChunk: vi.fn(),
      signal: new AbortController().signal,
      cancellationCell: { deadlineAt, cancelled: false },
    }));
    const [ctx, payload, , options] = hoisted.routeInstanceCall.mock.calls[0] as [
      { jobName: string },
      Record<string, unknown>,
      unknown,
      { relay: { handlers: Record<string, unknown> }; timeoutMs: number; attempts: number },
    ];
    expect(ctx.jobName).toBe('chat');
    expect(payload).not.toHaveProperty('onTextChunk');
    expect(payload).not.toHaveProperty('signal');
    expect(options.attempts).toBe(1);
    expect(options.timeoutMs).toBeGreaterThan(1_000);
    expect(typeof options.relay.handlers.text).toBe('function');
  });

  it('a relayed text frame that is not a string is ignored', async () => {
    hoisted.routeInstanceCall.mockResolvedValue({ id: 'resp' });
    const onTextChunk = vi.fn();
    await executeAgentChat(chat({ onTextChunk }));
    const options = hoisted.routeInstanceCall.mock.calls[0][3] as { relay: { handlers: Record<string, (d: unknown) => void> } };
    options.relay.handlers.text({ not: 'text' });
    expect(onTextChunk).not.toHaveBeenCalled();
  });
});

describe('agentRelayCallbacks (worker side)', () => {
  function fakeRelay(events: string[], signal?: AbortSignal) {
    const emitted: Array<[string, unknown]> = [];
    const relay: WorkerRelay = {
      events: new Set(events),
      signal,
      emit: (name, data) => emitted.push([name, data]),
      close: async () => undefined,
    };
    return { relay, emitted };
  }

  it('no relay → nothing wired', () => {
    expect(agentRelayCallbacks(null)).toEqual({});
  });

  it('wires only the events the caller listens for, plus its signal', () => {
    const signal = new AbortController().signal;
    const { relay, emitted } = fakeRelay(['text'], signal);
    const callbacks = agentRelayCallbacks(relay);
    expect(Object.keys(callbacks).sort()).toEqual(['onTextChunk', 'signal']);
    expect(callbacks.signal).toBe(signal);
    callbacks.onTextChunk!('hi');
    expect(emitted).toEqual([['text', 'hi']]);
  });

  it('tool and compaction events publish under their relay names', () => {
    const { relay, emitted } = fakeRelay(['tool', 'compaction']);
    const callbacks = agentRelayCallbacks(relay);
    expect(callbacks.onTextChunk).toBeUndefined(); // must not switch the remote run to streaming
    callbacks.onToolEvent!({ phase: 'success', name: 'search', durationMs: 5 });
    callbacks.onCompaction!({ at: 't' });
    expect(emitted).toEqual([
      ['tool', { phase: 'success', name: 'search', durationMs: 5 }],
      ['compaction', { at: 't' }],
    ]);
  });
});

/* ── 5. resolveAgentVoiceVersion ─────────────────────────────────────────── */

describe('resolveAgentVoiceVersion', () => {
  const params = { tenantDbName: TENANT_DB, projectId: PROJECT_ID, agentKey: AGENT_KEY };

  it('draft → undefined without touching the database', async () => {
    await expect(resolveAgentVoiceVersion({ ...params, prefer: 'draft' })).resolves.toBeUndefined();
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it('published → the published version when its snapshot exists', async () => {
    db.findAgentByKey.mockResolvedValue({ ...nativeAgent(), publishedVersion: 3 });
    db.findAgentVersion.mockResolvedValue({ version: 3 } as unknown as Awaited<ReturnType<typeof db.findAgentVersion>>);
    await expect(resolveAgentVoiceVersion({ ...params, prefer: 'published' })).resolves.toBe(3);
    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
    expect(db.findAgentByKey).toHaveBeenCalledWith(AGENT_KEY, PROJECT_ID);
    expect(db.findAgentVersion).toHaveBeenCalledWith('agent-1', 3);
  });

  it('published but never published → draft (undefined)', async () => {
    db.findAgentByKey.mockResolvedValue(nativeAgent());
    await expect(resolveAgentVoiceVersion({ ...params, prefer: 'published' })).resolves.toBeUndefined();
  });

  it('published but the snapshot is missing → draft (undefined)', async () => {
    db.findAgentByKey.mockResolvedValue({ ...nativeAgent(), publishedVersion: 2 });
    db.findAgentVersion.mockResolvedValue(null);
    await expect(resolveAgentVoiceVersion({ ...params, prefer: 'published' })).resolves.toBeUndefined();
  });

  it('unknown agent → undefined (the run that follows reports "not found")', async () => {
    db.findAgentByKey.mockResolvedValue(null);
    await expect(resolveAgentVoiceVersion({ ...params, prefer: 'published' })).resolves.toBeUndefined();
  });
});

/* ── 6. The chat model is built with the model's streaming option ────────── */

describe('agent chat model — provider streaming option', () => {
  const modelRecord = (key: string, settings: Record<string, unknown> = {}) => ({
    key,
    name: key,
    category: 'llm',
    providerKey: 'openai',
    providerDriver: 'openai',
    modelId: key,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    settings,
  });

  /** The `createChatModel` the provider runtime exposes, as a spy. */
  function installChatModelSpy() {
    const createChatModel = vi.fn<(config: Record<string, unknown>) => object>(() => ({}));
    hoisted.buildModelRuntime.mockResolvedValue({ runtime: { createChatModel } });
    return createChatModel;
  }

  it('a model flagged disableStreamingWithTools (an upstream that cannot stream tool calls) is built non-streaming', async () => {
    // Agents stream through `.stream()`. The gateway answers a streamed,
    // tool-carrying request for such a model with one `invoke()`; an agent has
    // to do the same or it sends the very request the flag exists to avoid.
    hoisted.getModelByKey.mockResolvedValue(modelRecord('gpt-4o', { disableStreamingWithTools: true }));
    const createChatModel = installChatModelSpy();

    await executePlaygroundChatLocal(playground({ onTextChunk: vi.fn() }));

    expect(createChatModel).toHaveBeenCalledTimes(1);
    expect(createChatModel.mock.calls[0][0]).toMatchObject({ modelId: 'gpt-4o', options: { disableStreaming: true } });
  });

  it('an ordinary model keeps streaming', async () => {
    const createChatModel = installChatModelSpy();
    await executePlaygroundChatLocal(playground({ onTextChunk: vi.fn() }));
    expect(createChatModel.mock.calls[0][0]).toMatchObject({ options: { disableStreaming: false } });
  });

  it('only the exact flag counts', async () => {
    hoisted.getModelByKey.mockResolvedValue(modelRecord('gpt-4o', { disableStreamingWithTools: 'true' }));
    const createChatModel = installChatModelSpy();
    await executePlaygroundChatLocal(playground());
    expect(createChatModel.mock.calls[0][0]).toMatchObject({ options: { disableStreaming: false } });
  });

  it('the chat entry point builds the model the same way', async () => {
    hoisted.getModelByKey.mockResolvedValue(modelRecord('gpt-4o', { disableStreamingWithTools: true }));
    const createChatModel = installChatModelSpy();
    await executeAgentChatLocal(chat({ onTextChunk: vi.fn() }));
    expect(createChatModel.mock.calls[0][0]).toMatchObject({ options: { disableStreaming: true } });
  });

  it('a sub-agent with a model of its own gets the same treatment, independently of the parent', async () => {
    db.findAgentByKey.mockResolvedValue({
      ...nativeAgent(),
      config: {
        ...nativeAgent().config,
        subagents: [{ kind: 'inline', name: 'researcher', header: 'Researcher', modelKey: 'fast-model' }],
      },
    } as IAgent);
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) =>
      modelRecord(key, key === 'fast-model' ? { disableStreamingWithTools: true } : {}),
    );
    const createChatModel = installChatModelSpy();

    await executePlaygroundChatLocal(playground());

    const optionsByModel = Object.fromEntries(
      createChatModel.mock.calls.map(([config]) => [config.modelId, config.options]),
    );
    expect(optionsByModel).toEqual({
      'gpt-4o': { disableStreaming: false },
      'fast-model': { disableStreaming: true },
    });
  });
});
