import { describe, expect, it, vi } from 'vitest';
import type { IAgentConversation } from '@/lib/database';

// Hoisted: `toolBindingsFromAssistantBody`'s file_search branch resolves the
// module through `getDatabase()`, which — unmocked — would try a real tenant
// connection this test has none of, and hang. `switchToTenant` and every
// other DB call the rest of this suite touches are stubbed no-ops; only
// `findRagModuleByKey` carries a real (fake) answer.
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: vi.fn().mockResolvedValue({
      switchToTenant: vi.fn(),
      findRagModuleByKey: vi.fn().mockImplementation((key: string) =>
        Promise.resolve(key === 'docs-v1' ? { key: 'docs-v1' } : null)),
    }),
  };
});

import {
  agentKeyFromAssistantId,
  agentToAssistant,
  assistantId,
  AssistantRequestError,
  conversationIdFromThreadId,
  extractMessageText,
  mergedMessages,
  messageId,
  threadId,
  toDate,
  toMessageObject,
  toolBindingsFromAssistantBody,
} from '@/server/api/plugins/client-assistants';

describe('id scheme', () => {
  it('round-trips assistant, thread and message ids', () => {
    expect(agentKeyFromAssistantId(assistantId('support-bot'))).toBe('support-bot');
    expect(conversationIdFromThreadId(threadId('conv-1'))).toBe('conv-1');
    expect(messageId('conv-1', 0)).toBe('msg_conv-1_0');
  });

  it('passes an id straight through when it lacks the expected prefix', () => {
    // Defensive, not a feature: a caller handing back a bare key still resolves.
    expect(agentKeyFromAssistantId('support-bot')).toBe('support-bot');
    expect(conversationIdFromThreadId('conv-1')).toBe('conv-1');
  });
});

describe('toDate', () => {
  it('passes a real Date through unchanged', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(toDate(d)).toBe(d);
  });

  it('coerces the ISO string SQLite round-trips a persisted timestamp as', () => {
    // Regression: `agent.mixin.ts`'s `mapConversation` reads `messages` back
    // with a plain JSON.parse (no reviver), so a persisted message's
    // `timestamp` — typed `Date` — is actually a string once it has round-
    // tripped through storage. A raw `.getTime()` on it throws, which is
    // exactly what listing a thread's messages did after its first run until
    // this coercion was added.
    const coerced = toDate('2026-01-01T00:00:00.000Z');
    expect(coerced).toBeInstanceOf(Date);
    expect(coerced.getTime()).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
  });
});

const conversation = (overrides: Partial<IAgentConversation> = {}): IAgentConversation => ({
  _id: 'conv-1',
  tenantId: 't1',
  projectId: 'p1',
  agentKey: 'support-bot',
  messages: [],
  createdBy: 'u1',
  ...overrides,
}) as IAgentConversation;

describe('mergedMessages — id stability across the pending → persisted promotion', () => {
  it('places pending messages after persisted ones', () => {
    const merged = mergedMessages(conversation({
      messages: [{ role: 'user', content: 'hi', timestamp: new Date('2026-01-01T00:00:00Z') }],
      metadata: {
        assistantsApi: {
          pendingMessages: [{ id: 'p1', role: 'user', content: 'again', created_at: 1735776000 }],
        },
      },
    }));
    expect(merged.map((m) => [m.role, m.content, m.pending])).toEqual([
      ['user', 'hi', false],
      ['user', 'again', true],
    ]);
  });

  it('keeps a message at the SAME index once its run promotes it to persisted', () => {
    // Before the run: one persisted turn, one pending user message at index 1.
    const before = mergedMessages(conversation({
      messages: [
        { role: 'user', content: 'turn 1', timestamp: new Date('2026-01-01T00:00:00Z') },
        { role: 'assistant', content: 'reply 1', timestamp: new Date('2026-01-01T00:00:01Z') },
      ],
      metadata: {
        assistantsApi: { pendingMessages: [{ id: 'p1', role: 'user', content: 'turn 2', created_at: 1735776002 }] },
      },
    }));
    expect(before[2]).toMatchObject({ role: 'user', content: 'turn 2', pending: true });

    // After the run: `executeAgentChat` appended the (user, assistant) pair
    // itself and the pending queue was cleared — the exact transition
    // `runThread` performs.
    const after = mergedMessages(conversation({
      messages: [
        { role: 'user', content: 'turn 1', timestamp: new Date('2026-01-01T00:00:00Z') },
        { role: 'assistant', content: 'reply 1', timestamp: new Date('2026-01-01T00:00:01Z') },
        { role: 'user', content: 'turn 2', timestamp: '2026-01-01T00:00:02.000Z' as unknown as Date },
        { role: 'assistant', content: 'reply 2', timestamp: '2026-01-01T00:00:03.000Z' as unknown as Date },
      ],
      metadata: { assistantsApi: { pendingMessages: [] } },
    }));
    expect(after[2]).toMatchObject({ role: 'user', content: 'turn 2', pending: false });
    expect(after[3]).toMatchObject({ role: 'assistant', content: 'reply 2', pending: false });
  });
});

describe('toMessageObject', () => {
  it('stamps assistant_id only on assistant turns', () => {
    const userMsg = toMessageObject('conv-1', 'asst_x', 0, {
      role: 'user', content: 'hi', timestamp: new Date(),
    });
    const asstMsg = toMessageObject('conv-1', 'asst_x', 1, {
      role: 'assistant', content: 'hello', timestamp: new Date(),
    });
    expect(userMsg.assistant_id).toBeNull();
    expect(asstMsg.assistant_id).toBe('asst_x');
    expect(userMsg.content[0]).toEqual({ type: 'text', text: { value: 'hi', annotations: [] } });
  });
});

describe('extractMessageText', () => {
  it('accepts a plain string', () => {
    expect(extractMessageText('  hi  ')).toBe('hi');
  });

  it('accepts an OpenAI-shaped text content part', () => {
    expect(extractMessageText([{ type: 'text', text: { value: 'hi' } }])).toBe('hi');
    expect(extractMessageText([{ type: 'text', text: 'hi' }])).toBe('hi');
  });

  it('rejects empty and unrecognized input', () => {
    expect(extractMessageText('   ')).toBeNull();
    expect(extractMessageText(42)).toBeNull();
    expect(extractMessageText([{ type: 'image_url' }])).toBeNull();
  });
});

describe('agentToAssistant', () => {
  it('maps an IAgent onto the Assistant wire shape', () => {
    const out = agentToAssistant({
      _id: 'a1',
      tenantId: 't1',
      projectId: 'p1',
      key: 'support-bot',
      name: 'Support Bot',
      config: { modelKey: 'gpt-4o-mini', systemPrompt: 'Be terse.', toolBindings: [] },
      status: 'active',
      createdBy: 'u1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    } as never);
    expect(out).toMatchObject({
      id: 'asst_support-bot',
      object: 'assistant',
      model: 'gpt-4o-mini',
      instructions: 'Be terse.',
      tools: [],
    });
  });

  it('projects a knowledge module onto tool_resources.file_search', () => {
    const out = agentToAssistant({
      key: 'kb-bot',
      name: 'KB Bot',
      config: { modelKey: 'gpt-4o-mini', knowledgeEngineKey: 'docs-v1' },
      createdBy: 'u1',
    } as never);
    expect(out.tool_resources).toEqual({ file_search: { vector_store_ids: ['docs-v1'] } });
  });
});

describe('toolBindingsFromAssistantBody', () => {
  // These four map exactly onto the live 400s exercised against the real
  // server (function / code_interpreter / file_search-with-no-module /
  // file_search-with-unknown-module); re-asserted here as unit tests so a
  // future refactor of the validation function fails fast without a live run.
  it('rejects a client-executed "function" tool', async () => {
    await expect(
      toolBindingsFromAssistantBody('tdb', 'p1', { tools: [{ type: 'function', function: { name: 'foo' } }] }),
    ).rejects.toThrow(AssistantRequestError);
  });

  it('rejects "code_interpreter" — no backing runtime yet', async () => {
    await expect(
      toolBindingsFromAssistantBody('tdb', 'p1', { tools: [{ type: 'code_interpreter' }] }),
    ).rejects.toThrow(AssistantRequestError);
  });

  it('rejects "file_search" with no vector_store_ids', async () => {
    await expect(
      toolBindingsFromAssistantBody('tdb', 'p1', { tools: [{ type: 'file_search' }] }),
    ).rejects.toThrow(/vector_store_ids/);
  });

  it('accepts "file_search" naming a real Knowledge Engine module', async () => {
    const result = await toolBindingsFromAssistantBody('tdb', 'p1', {
      tools: [{ type: 'file_search' }],
      tool_resources: { file_search: { vector_store_ids: ['docs-v1'] } },
    });
    expect(result.knowledgeEngineKey).toBe('docs-v1');
  });

  it('accepts the console_tool extension for the built-in tool/MCP/system catalog', async () => {
    const result = await toolBindingsFromAssistantBody('tdb', 'p1', {
      tools: [{ type: 'console_tool', tool: { source: 'system', sourceKey: 'browser_use', toolNames: ['browser_use'] } }],
    });
    expect(result.toolBindings).toEqual([
      { source: 'system', sourceKey: 'browser_use', toolNames: ['browser_use'] },
    ]);
  });

  it('rejects an unrecognized tool type rather than dropping it silently', async () => {
    await expect(
      toolBindingsFromAssistantBody('tdb', 'p1', { tools: [{ type: 'retrieval' }] }),
    ).rejects.toThrow(AssistantRequestError);
  });
});
