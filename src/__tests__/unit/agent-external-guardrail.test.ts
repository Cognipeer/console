/**
 * GAP — the CONNECTED (external) agent.
 *
 * Both agent entry points returned from the `kind === 'external'` branch before
 * a single guardrail ran: no `input.pre`, no `output.pre`, no tool guard, and
 * no warning. An operator who bound a guardrail to a connected agent got zero
 * enforcement and the UI still showed the guardrail attached — the silent
 * non-enforcement this whole plane exists to end.
 *
 * What these cases pin, and what is easy to get subtly wrong while fixing it:
 *
 *   1. an input BLOCK must stop the turn BEFORE the remote endpoint is reached
 *      — a block that still sends the prompt upstream has already leaked it;
 *   2. an output REDACTION must reach the PERSISTED conversation, not only the
 *      returned payload. `updateAgentConversation` writes the history the next
 *      turn reads back and folds into the request to the same endpoint, so a
 *      redaction applied after the write is a redaction that lasts one turn;
 *   3. a LEGACY config (the two deprecated slots, no `guardrails` array) must
 *      still enforce both text hooks here, exactly as it does on the local path;
 *   4. an unservable binding (`tool.*`, `output.stream.delta`) must WARN. A
 *      connected agent runs its tools on the far side of one HTTP call, so
 *      those hooks have no subject to evaluate — that is a property of the
 *      wire, but it must not be a silent one.
 *
 * WHY `evaluateGuardrail` IS MOCKED. The nine policy families, the engine and
 * the binding resolver each have their own suites. What is untested is the
 * WIRING on this branch — whether a hook runs at all, in which order relative
 * to the HTTP call and the conversation write, and whose text is carried
 * forward. A spy answers that exactly. Everything else stays real: the binding
 * resolution (`resolveBindings`, including the legacy projection), the hook
 * ids, and the guardrail barrel.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgent, IAgentConfig, IAgentConversation, IExternalAgentConnection } from '@/lib/database';
import type { GuardrailEvaluationResult } from '@/lib/services/guardrail';

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// SYNC factories, matching `agent-tool-guardrail.test.ts`: an `async` factory
// with `await importOriginal()` has been observed to silently fail to intercept
// in this repo, leaving the module under test bound to the real export while
// the assertions watch a spy nothing calls. The logger is the one exception
// below, and it is asserted on directly so a failed interception fails loudly.

const hoisted = vi.hoisted(() => ({
  invokeExternalAgent: vi.fn(),
  evaluateGuardrail: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/services/agents/externalAgent', () => ({
  invokeExternalAgent: hoisted.invokeExternalAgent,
}));

// The SERVICE, not the barrel. `@/lib/services/guardrail` re-exports the whole
// hook plane — mocking it would replace `resolveBindings`' neighbours and the
// hook ids too, and the legacy-projection case below is only meaningful when
// the real binding resolver decides which keys fire.
vi.mock('@/lib/services/guardrail/guardrailService', () => ({
  evaluateGuardrail: hoisted.evaluateGuardrail,
  // The barrel re-exports these by name from this module; a name missing from
  // the mock breaks that re-export rather than this test's own seam.
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

vi.mock('@/lib/core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/logger')>();
  return {
    ...actual,
    createLogger: (scope: string) => {
      const real = actual.createLogger(scope);
      if (scope !== 'agents') return real;
      // A PROXY, not `{ ...real, warn }`: winston carries `info`/`warn`/`error`
      // on the prototype, so a spread copy silently loses every level except
      // the one being overridden — and the first `logger.info` on the path
      // under test then dies with "is not a function".
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'warn') return hoisted.warn;
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { executeAgentChatLocal, executePlaygroundChatLocal } from '@/lib/services/agents/agentService';

// ── Fixtures ────────────────────────────────────────────────────────────────

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'partner-agent';
const CONVERSATION_ID = 'conv-1';

const RAW_QUESTION = 'my card is 4111 1111 1111 1111';
const RAW_ANSWER = 'The account holder is Jane Doe.';

const CONNECTION: IExternalAgentConnection = {
  protocol: 'openai-chat',
  url: 'https://partner.example/v1',
  model: 'gpt-4o-mini',
};

/** Bound to both TEXT hooks — the shape the multi-binding UI writes. */
const ARMED: Partial<IAgentConfig> = {
  guardrails: [
    { key: 'gr-in', hooks: ['input.pre'] },
    { key: 'gr-out', hooks: ['output.pre'] },
  ],
};

/** A row written before the hook plane: two single slots, no array. */
const LEGACY: Partial<IAgentConfig> = {
  inputGuardrailKey: 'gr-in',
  outputGuardrailKey: 'gr-out',
};

function connectedAgent(bindings: Partial<IAgentConfig> = {}): IAgent {
  return {
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

function chatRequest(userMessage = RAW_QUESTION) {
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

function playgroundRequest(userMessage = RAW_QUESTION) {
  return {
    tenantDbName: TENANT_DB,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    userMessage,
  };
}

/* ── Evaluation results, shaped as `evaluateGuardrail` returns them ───────── */

function allow(guardrailKey: string): GuardrailEvaluationResult {
  return { passed: true, blocked: false, guardrailKey, guardrailName: guardrailKey, action: 'block', findings: [] };
}

/** Passing, but carrying a rewritten copy — the redact path. */
function redacted(guardrailKey: string, redactedText: string): GuardrailEvaluationResult {
  return { ...allow(guardrailKey), action: 'redact', redactedText };
}

function blocked(guardrailKey: string, category: string): GuardrailEvaluationResult {
  return {
    passed: false,
    // `blocked` is the enforcement answer — the facade derives it from
    // `verdict.decision`, so a monitor-mode guardrail would report `false`
    // here while `passed` stayed false. These stubs model an ENFORCING one.
    blocked: true,
    guardrailKey,
    guardrailName: guardrailKey,
    action: 'block',
    findings: [
      { type: 'pii', category, severity: 'high', message: `${category} detected`, action: 'block', block: true },
    ],
  };
}

/* ── Readers over the spies ───────────────────────────────────────────────── */

type EvaluateArgs = { guardrailKey: string; phase?: 'input' | 'output'; source?: string; text: string };

/** Every evaluation, as (key, phase, source) triples, in call order. */
function evaluations(): Array<[string, string | undefined, string | undefined]> {
  return hoisted.evaluateGuardrail.mock.calls.map(([params]) => {
    const args = params as EvaluateArgs;
    return [args.guardrailKey, args.phase, args.source];
  });
}

/** The messages array handed to the remote endpoint. */
function sentUpstream(): Array<{ role: string; content: string }> {
  const [, messages] = hoisted.invokeExternalAgent.mock.calls[0] as [
    IExternalAgentConnection,
    Array<{ role: string; content: string }>,
  ];
  return messages;
}

/** The conversation payload actually written to the database. */
function persisted(): { messages: IAgentConversation['messages']; title?: string } {
  const [, patch] = db.updateAgentConversation.mock.calls[0] as [
    string,
    { messages: IAgentConversation['messages']; title?: string },
  ];
  return patch;
}

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findAgentByKey.mockResolvedValue(connectedAgent(ARMED));
  db.findAgentConversationById.mockResolvedValue(conversation());
  hoisted.invokeExternalAgent.mockResolvedValue({ content: RAW_ANSWER, raw: {} });
  hoisted.evaluateGuardrail.mockImplementation(async (params: EvaluateArgs) => allow(params.guardrailKey));
});

// ── 1. input.pre runs BEFORE the endpoint is reached ────────────────────────

describe('connected agent chat — input.pre', () => {
  it('fails the turn before the remote endpoint sees the prompt', async () => {
    hoisted.evaluateGuardrail.mockImplementation(async (params: EvaluateArgs) =>
      params.guardrailKey === 'gr-in' ? blocked('gr-in', 'credit_card') : allow(params.guardrailKey),
    );

    // Same error shape the local path raises — operator runbooks grep for it.
    await expect(executeAgentChatLocal(chatRequest())).rejects.toThrow(
      'Input blocked by guardrail: credit_card',
    );

    // The whole point of an input hook on THIS surface: a block that still
    // posts the prompt to a third party has already leaked it.
    expect(hoisted.invokeExternalAgent).not.toHaveBeenCalled();
    expect(db.updateAgentConversation).not.toHaveBeenCalled();
  });

  it('sends the REDACTED question upstream and persists that same copy', async () => {
    const safeQuestion = 'my card is [REDACTED]';
    hoisted.evaluateGuardrail.mockImplementation(async (params: EvaluateArgs) =>
      params.guardrailKey === 'gr-in' ? redacted('gr-in', safeQuestion) : allow(params.guardrailKey),
    );

    await executeAgentChatLocal(chatRequest());

    expect(sentUpstream().at(-1)).toEqual({ role: 'user', content: safeQuestion });
    const patch = persisted();
    expect(patch.messages[0].content).toBe(safeQuestion);
    // The title is cut from the same string; the raw card number must not
    // survive in the conversation list either.
    expect(patch.title).toBe(safeQuestion);
    expect(JSON.stringify(patch)).not.toContain('4111');
  });
});

// ── 2. output.pre runs BEFORE the conversation is written ───────────────────

describe('connected agent chat — output.pre', () => {
  it('carries the redaction into the PERSISTED history, not just the response', async () => {
    const safeAnswer = 'The account holder is [REDACTED].';
    hoisted.evaluateGuardrail.mockImplementation(async (params: EvaluateArgs) =>
      params.guardrailKey === 'gr-out' ? redacted('gr-out', safeAnswer) : allow(params.guardrailKey),
    );

    const response = await executeAgentChatLocal(chatRequest());

    // Persisted: the next turn folds this history back into the request to the
    // same endpoint, so a raw answer here re-leaks on every following turn.
    const patch = persisted();
    expect(patch.messages.at(-1)).toMatchObject({ role: 'assistant', content: safeAnswer });
    expect(JSON.stringify(patch)).not.toContain('Jane Doe');

    // Returned: the caller's copy and the playground's `_conversation_messages`
    // are the same string, so no surface hands back the un-redacted answer.
    const [message] = response.output;
    expect(message.type === 'message' && message.content[0].text).toBe(safeAnswer);
    expect(response._conversation_messages?.at(-1)?.content).toBe(safeAnswer);
  });

  it('writes nothing when the answer is blocked', async () => {
    hoisted.evaluateGuardrail.mockImplementation(async (params: EvaluateArgs) =>
      params.guardrailKey === 'gr-out' ? blocked('gr-out', 'person_name') : allow(params.guardrailKey),
    );

    await expect(executeAgentChatLocal(chatRequest())).rejects.toThrow(
      'Output blocked by guardrail: person_name',
    );

    // Ordering proof: the hook is evaluated before `updateAgentConversation`,
    // so a blocked answer never lands in the history at all.
    expect(db.updateAgentConversation).not.toHaveBeenCalled();
  });
});

// ── 3. Legacy slots still enforce here ──────────────────────────────────────

describe('connected agent chat — binding generations', () => {
  it('enforces both text hooks from the two deprecated slots alone', async () => {
    db.findAgentByKey.mockResolvedValue(connectedAgent(LEGACY));

    await executeAgentChatLocal(chatRequest());

    // `resolveBindings` projects the legacy slots onto input.pre / output.pre;
    // a connected agent must not be the one surface where that stops working.
    expect(evaluations()).toEqual([
      ['gr-in', 'input', 'agent'],
      ['gr-out', 'output', 'agent'],
    ]);
    expect(hoisted.invokeExternalAgent).toHaveBeenCalledOnce();
  });

  it('evaluates nothing when the agent has no bindings at all', async () => {
    db.findAgentByKey.mockResolvedValue(connectedAgent());

    await executeAgentChatLocal(chatRequest());

    // An unbound connected agent must not pay for — or log — an evaluation.
    expect(evaluations()).toEqual([]);
    expect(persisted().messages.at(-1)?.content).toBe(RAW_ANSWER);
  });
});

// ── 4. Unservable bindings warn instead of doing nothing quietly ────────────

describe('connected agent chat — unservable bindings', () => {
  it('warns that a tool-hook binding cannot run on a connected agent', async () => {
    db.findAgentByKey.mockResolvedValue(
      connectedAgent({ guardrails: [{ key: 'gr-tools', hooks: ['tool.pre'] }] }),
    );

    await executeAgentChatLocal(chatRequest());

    // Nothing to evaluate — the remote agent owns its tools — so the warning
    // is the ONLY signal the operator gets. Its absence is the bug.
    expect(evaluations()).toEqual([]);
    expect(hoisted.warn).toHaveBeenCalledWith(
      expect.stringContaining('will not run on this connected agent'),
      { agentKey: AGENT_KEY, guardrailKeys: ['gr-tools'] },
    );
  });

  it('reports a stream-only binding through the existing stream warning', async () => {
    db.findAgentByKey.mockResolvedValue(
      connectedAgent({ guardrails: [{ key: 'gr-stream', hooks: ['output.stream.delta'] }] }),
    );

    await executeAgentChatLocal(chatRequest());

    // Delegated to `warnUnservableStreamBinding` rather than restated: a
    // connected agent does not stream either, and "bind it to output.pre as
    // well" is the same advice.
    expect(hoisted.warn).toHaveBeenCalledWith(
      expect.stringContaining('output.stream.delta'),
      { agentKey: AGENT_KEY, guardrailKeys: ['gr-stream'] },
    );
  });

  it('warns that a prompt.pre-only binding has no emitter in the console', async () => {
    db.findAgentByKey.mockResolvedValue(
      connectedAgent({ guardrails: [{ key: 'gr-prompt', hooks: ['prompt.pre'] }] }),
    );

    await executeAgentChatLocal(chatRequest());

    // `prompt.pre` is emitted by a REMOTE enforcement point, never by the
    // console (hooks/contract, HOOK_IDS). Binding it here therefore evaluates
    // nothing at all, on this surface and on every other one — so, like the
    // stream case, the warning is the only signal the operator gets.
    expect(evaluations()).toEqual([]);
    expect(hoisted.warn).toHaveBeenCalledWith(
      expect.stringContaining('prompt.pre'),
      { agentKey: AGENT_KEY, guardrailKeys: ['gr-prompt'] },
    );
  });

  it('stays silent when the same guardrail is also bound to input.pre', async () => {
    db.findAgentByKey.mockResolvedValue(
      connectedAgent({
        guardrails: [{ key: 'gr-in', hooks: ['prompt.pre', 'input.pre'] }],
      }),
    );

    await executeAgentChatLocal(chatRequest());

    // The operator's intent IS served: the user's text is checked, just on
    // every model call rather than once. Warning here would train people to
    // ignore the warning that matters.
    expect(hoisted.warn).not.toHaveBeenCalled();
    // Once, on input.pre. Nothing is bound to output.pre, so the answer side
    // evaluates nothing — the prompt binding did not quietly become a second
    // evaluation of the same text.
    expect(evaluations()).toEqual([['gr-in', 'input', 'agent']]);
  });

  it('warns once per run, not once per bound tool hook', async () => {
    db.findAgentByKey.mockResolvedValue(
      connectedAgent({ guardrails: [{ key: 'gr-tools', hooks: ['tool.pre', 'tool.post'] }] }),
    );

    await executeAgentChatLocal(chatRequest());

    // One binding is one operator mistake, however many hooks it names.
    expect(hoisted.warn).toHaveBeenCalledOnce();
  });
});

// ── 5. The playground runs the same policy ──────────────────────────────────

describe('connected agent playground', () => {
  it('blocks before the endpoint is reached', async () => {
    hoisted.evaluateGuardrail.mockImplementation(async (params: EvaluateArgs) =>
      params.guardrailKey === 'gr-in' ? blocked('gr-in', 'credit_card') : allow(params.guardrailKey),
    );

    await expect(executePlaygroundChatLocal(playgroundRequest())).rejects.toThrow(
      'Input blocked by guardrail: credit_card',
    );
    expect(hoisted.invokeExternalAgent).not.toHaveBeenCalled();
  });

  it('returns the redacted answer, and logs under the playground source', async () => {
    const safeAnswer = 'The account holder is [REDACTED].';
    hoisted.evaluateGuardrail.mockImplementation(async (params: EvaluateArgs) =>
      params.guardrailKey === 'gr-out' ? redacted('gr-out', safeAnswer) : allow(params.guardrailKey),
    );

    // The playground persists nothing, so the returned string is the only copy.
    expect(await executePlaygroundChatLocal(playgroundRequest())).toEqual({ content: safeAnswer });
    expect(evaluations()).toEqual([
      ['gr-in', 'input', 'agent-playground'],
      ['gr-out', 'output', 'agent-playground'],
    ]);
  });

  it('enforces a legacy config exactly as the live path does', async () => {
    db.findAgentByKey.mockResolvedValue(connectedAgent(LEGACY));

    await executePlaygroundChatLocal(playgroundRequest());

    expect(evaluations()).toEqual([
      ['gr-in', 'input', 'agent-playground'],
      ['gr-out', 'output', 'agent-playground'],
    ]);
  });

  it('sends the guarded question upstream, with the in-memory history intact', async () => {
    const safeQuestion = 'my card is [REDACTED]';
    hoisted.evaluateGuardrail.mockImplementation(async (params: EvaluateArgs) =>
      params.guardrailKey === 'gr-in' ? redacted('gr-in', safeQuestion) : allow(params.guardrailKey),
    );

    await executePlaygroundChatLocal({
      ...playgroundRequest(),
      history: [{ role: 'user', content: 'earlier' }],
    });

    expect(sentUpstream()).toEqual([
      { role: 'user', content: 'earlier' },
      { role: 'user', content: safeQuestion },
    ]);
  });
});
