/**
 * Unit tests — Traffic Snapshots service.
 *
 * Deterministic hash sampling, gateway payload mapping (incl. tool_calls and
 * truncated-payload skips), tracing best-effort mapping, and the mandatory
 * anonymization gate on dataset creation. DB access mocked with SYNC
 * vi.mock factories (async factories silently fail to intercept).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/evaluation/service', () => ({ createDataset: vi.fn() }));

import { getDatabase } from '@/lib/database';
import type { IAgentTracingEvent, IAgentTracingSession, IModelUsageLog } from '@/lib/database';
import { createDataset } from '@/lib/services/evaluation/service';
import {
  createSnapshotDataset,
  inferToolSchema,
  isSampled,
  mapGatewayRow,
  mapTracingSession,
  MAX_ITEMS_PER_SESSION,
  previewSnapshot,
} from '@/lib/services/snapshots/snapshotService';
import type { AnonymizeOptions } from '@/lib/services/pii/anonymize';
import { createMockDb, type MockDb } from '../helpers/db.mock';

const CTX = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'project-1', userId: 'user-1' };

const ANON: AnonymizeOptions = { categories: ['email'], strategy: 'pseudonym', salt: 'test-salt' };

// ── Deterministic sampling ─────────────────────────────────────────────────

describe('isSampled', () => {
  const ids = Array.from({ length: 500 }, (_, i) => `req-${i}`);

  it('same pct always selects the same subset', () => {
    const first = ids.filter((id) => isSampled(id, 30));
    const second = ids.filter((id) => isSampled(id, 30));
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(ids.length);
  });

  it('is monotonic: pct 10 subset ⊂ pct 50 subset', () => {
    const at10 = new Set(ids.filter((id) => isSampled(id, 10)));
    const at50 = new Set(ids.filter((id) => isSampled(id, 50)));
    expect(at10.size).toBeGreaterThan(0);
    expect(at50.size).toBeGreaterThan(at10.size);
    for (const id of at10) expect(at50.has(id)).toBe(true);
  });

  it('pct 100 selects everything, pct 0 nothing', () => {
    expect(ids.every((id) => isSampled(id, 100))).toBe(true);
    expect(ids.some((id) => isSampled(id, 0))).toBe(false);
  });
});

// ── Gateway mapping ────────────────────────────────────────────────────────

function gatewayRow(overrides: Partial<IModelUsageLog> = {}): IModelUsageLog {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    modelKey: 'gpt-4o',
    requestId: 'req-1',
    route: 'chat.completions',
    status: 'success',
    providerRequest: {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a travel agent.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Book a flight for john.doe@example.com' },
            { type: 'image_url', image_url: { url: 'https://x/y.png' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_9', content: '{"ok":true}' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'book_flight',
            description: 'Book a flight',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    },
    providerResponse: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Booked! Confirmation sent to john.doe@example.com',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'book_flight', arguments: '{"city":"Paris","email":"john.doe@example.com"}' },
              },
            ],
          },
        },
      ],
    },
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    ...overrides,
  };
}

describe('mapGatewayRow', () => {
  it('maps messages/tools/response to a dataset item with anonymized strings', () => {
    const outcome = mapGatewayRow(gatewayRow(), ANON);
    expect(outcome.kind).toBe('item');
    if (outcome.kind !== 'item') return;

    const { item } = outcome;
    expect(item.id).toBe('gw-req-1');
    expect(item.input).toHaveLength(3);
    expect(item.input[0]).toEqual({ role: 'system', content: 'You are a travel agent.' });
    // Array content flattened to text, email pseudonymized.
    expect(item.input[1].role).toBe('user');
    expect(item.input[1].content).toMatch(/^Book a flight for <EMAIL_[0-9a-f]{6}>$/);
    // Full fidelity: the tool response stays IN the conversation…
    expect(item.input[2]).toEqual({ role: 'tool', content: '{"ok":true}', toolCallId: 'call_9' });

    // Tool definitions mapped from the OpenAI envelope.
    expect(item.tools).toHaveLength(1);
    expect(item.tools?.[0].name).toBe('book_flight');
    expect(item.tools?.[0].parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } } });

    // …and ALSO rides along as toolResults for the trajectory mock.
    expect(item.toolResults).toEqual({ call_9: '{"ok":true}' });

    // Recorded assistant text → expected.reference (anonymized).
    const expected = item.expected as Record<string, unknown>;
    expect(expected.reference).toMatch(/^Booked! Confirmation sent to <EMAIL_[0-9a-f]{6}>$/);

    // Recorded tool_calls → expected.toolCalls with argsMatch 'subset'.
    const toolCalls = expected.toolCalls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('book_flight');
    expect(toolCalls[0].argsMatch).toBe('subset');
    const args = toolCalls[0].args as Record<string, unknown>;
    expect(args.city).toBe('Paris');
    expect(args.email).toMatch(/^<EMAIL_[0-9a-f]{6}>$/);

    expect(outcome.findings).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(item)).not.toContain('john.doe@example.com');
  });

  it('anonymization is deterministic: the same email maps to one token everywhere', () => {
    const outcome = mapGatewayRow(gatewayRow(), ANON);
    if (outcome.kind !== 'item') throw new Error('expected item');
    const tokens = JSON.stringify(outcome.item).match(/<EMAIL_[0-9a-f]{6}>/g) ?? [];
    expect(tokens.length).toBeGreaterThanOrEqual(3);
    expect(new Set(tokens).size).toBe(1);
  });

  it('skips rows with a truncation marker payload', () => {
    const outcome = mapGatewayRow(
      gatewayRow({ providerRequest: { _truncated: true, _originalBytes: 999999, preview: '{"messages":[{"ro' } }),
      ANON,
    );
    expect(outcome).toEqual({ kind: 'skip', reason: 'truncatedPayload' });
  });

  it('skips rows whose string payload is cut mid-JSON', () => {
    const outcome = mapGatewayRow(
      gatewayRow({ providerRequest: { value: '{"messages":[{"role":"user","cont' } }),
      ANON,
    );
    expect(outcome).toEqual({ kind: 'skip', reason: 'truncatedPayload' });
  });

  it('skips rows without a messages array', () => {
    const outcome = mapGatewayRow(gatewayRow({ providerRequest: { model: 'gpt-4o' } }), ANON);
    expect(outcome).toEqual({ kind: 'skip', reason: 'missingMessages' });
  });

  it('parses a string payload wrapped by the usage logger', () => {
    const outcome = mapGatewayRow(
      gatewayRow({
        providerRequest: { value: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) },
      }),
      ANON,
    );
    expect(outcome.kind).toBe('item');
  });

  // Regression: the streaming path logs the accumulated LangChain
  // AIMessageChunk, not the OpenAI envelope. Reading only `choices` produced
  // reference-less items for every streamed request — and streaming is the
  // default for chat clients, so that silently poisoned most snapshots.
  it('reads the reference from a streamed LangChain AIMessageChunk payload', () => {
    const outcome = mapGatewayRow(
      gatewayRow({
        providerRequest: {
          model: 'gpt-4o',
          stream: true,
          messages: [{ role: 'user', content: 'Where is my order?' }],
        },
        providerResponse: {
          lc: 1,
          type: 'constructor',
          id: ['langchain_core', 'messages', 'AIMessageChunk'],
          kwargs: {
            content: 'Your order ships today. We emailed john.doe@example.com.',
            tool_calls: [],
          },
        },
      }),
      ANON,
    );

    expect(outcome.kind).toBe('item');
    if (outcome.kind !== 'item') return;
    const expected = outcome.item.expected as Record<string, unknown>;
    // The email detector absorbs the sentence-final dot into the match, so the
    // token replaces "john.doe@example.com." including that trailing period.
    expect(expected.reference).toMatch(/^Your order ships today\. We emailed <EMAIL_[0-9a-f]{6}>$/);
    expect(JSON.stringify(outcome.item)).not.toContain('john.doe@example.com');
  });

  it('maps LangChain-shaped tool calls from a streamed payload', () => {
    const outcome = mapGatewayRow(
      gatewayRow({
        providerRequest: {
          model: 'gpt-4o',
          stream: true,
          messages: [{ role: 'user', content: 'Where is order 100248?' }],
        },
        providerResponse: {
          lc: 1,
          type: 'constructor',
          id: ['langchain_core', 'messages', 'AIMessageChunk'],
          kwargs: {
            content: '',
            // LangChain shape: {name, args, id} — not {function:{name, arguments}}.
            tool_calls: [{ name: 'lookup_order', args: { orderId: '100248' }, id: 'call_7' }],
          },
        },
      }),
      ANON,
    );

    expect(outcome.kind).toBe('item');
    if (outcome.kind !== 'item') return;
    const expected = outcome.item.expected as Record<string, unknown>;
    const toolCalls = expected.toolCalls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('lookup_order');
    expect(toolCalls[0].args).toEqual({ orderId: '100248' });
  });
});

// ── Tracing mapping ────────────────────────────────────────────────────────

function tracingSession(overrides: Partial<IAgentTracingSession> = {}): IAgentTracingSession {
  return { sessionId: 'sess-1', tenantId: 'tenant-1', projectId: 'project-1', agentName: 'travel-bot', status: 'completed', ...overrides };
}

function tracingEvent(overrides: Partial<IAgentTracingEvent> = {}): IAgentTracingEvent {
  return { sessionId: 'sess-1', tenantId: 'tenant-1', ...overrides };
}

describe('mapTracingSession', () => {
  it('reconstructs a conversation from message-kind sections', () => {
    const events = [
      tracingEvent({
        sequence: 1,
        sections: [
          { kind: 'message', label: 'User Message', role: 'user', content: 'My mail is john.doe@example.com' },
        ],
      }),
      tracingEvent({
        sequence: 2,
        sections: [
          { kind: 'message', label: 'Assistant Message', role: 'assistant', content: 'Noted!' },
          { kind: 'metadata', label: 'Span Attributes', content: '{"a":1}' },
        ],
      }),
    ];
    const outcome = mapTracingSession(tracingSession(), events, ANON);
    expect(outcome.kind).toBe('items');
    if (outcome.kind !== 'items') return;
    expect(outcome.shape).toBe('message-sections');
    // No tool actions → single reference item, exactly the previous shape.
    expect(outcome.items).toHaveLength(1);
    const item = outcome.items[0];
    expect(item.id).toBe('tr-sess-1');
    expect(item.input).toHaveLength(1);
    expect(item.input[0].role).toBe('user');
    expect(item.input[0].content).toMatch(/^My mail is <EMAIL_[0-9a-f]{6}>$/);
    expect((item.expected as Record<string, unknown>).reference).toBe('Noted!');
    expect(item.tags).toContain('agent:travel-bot');
    expect(item.tools).toBeUndefined();
  });

  it('skips sessions with no reconstructable message content', () => {
    const events = [
      tracingEvent({ sequence: 1, sections: [{ kind: 'metadata', label: 'Span', content: 'tool span' }] }),
      tracingEvent({ sequence: 2, sections: [{ kind: 'tool_result', label: 'Tool Result', content: '{"ok":1}' }] }),
    ];
    expect(mapTracingSession(tracingSession(), events, ANON)).toEqual({ kind: 'skip', shape: 'none' });
  });
});

// ── Tracing multi-cut (tool-decision items) ────────────────────────────────

function msgEvent(sequence: number, role: string, content: string): IAgentTracingEvent {
  return tracingEvent({ sequence, sections: [{ kind: 'message', role, content }] });
}

function toolCallEvent(sequence: number, tool: string, args?: unknown): IAgentTracingEvent {
  return tracingEvent({
    sequence,
    sections: [{ kind: 'tool_call', tool, ...(args !== undefined ? { args } : {}) }],
  });
}

function toolResultEvent(sequence: number, result: unknown, tool?: string): IAgentTracingEvent {
  return tracingEvent({ sequence, sections: [{ kind: 'tool_result', ...(tool ? { tool } : {}), result }] });
}

/** Model-call event carrying the recorded tool menu offered on that call. */
function toolDefsEvent(sequence: number, tools: Array<Record<string, unknown>>): IAgentTracingEvent {
  return tracingEvent({ sequence, type: 'ai_call', sections: [{ kind: 'tool_definitions', tools }] });
}

function mapItems(events: IAgentTracingEvent[]) {
  const outcome = mapTracingSession(tracingSession(), events, ANON);
  if (outcome.kind !== 'items') throw new Error('expected items');
  return outcome.items;
}

describe('mapTracingSession multi-cut', () => {
  it('emits one item per tool action plus the final answer, with prefix inputs', () => {
    const items = mapItems([
      msgEvent(1, 'user', 'Find me a flight to Paris'),
      toolCallEvent(2, 'search_flights', { city: 'Paris', max: 3 }),
      toolResultEvent(3, { flights: ['AF123'] }, 'search_flights'),
      toolCallEvent(4, 'book_flight', { flight: 'AF123', seat: 12 }),
      toolResultEvent(5, { ok: true }, 'book_flight'),
      msgEvent(6, 'assistant', 'Booked AF123!'),
    ]);

    // Chronological: two tool actions then the final answer (plain id).
    expect(items.map((item) => item.id)).toEqual(['tr-sess-1#1', 'tr-sess-1#2', 'tr-sess-1']);

    // Action 1: input stops BEFORE the first call — the decision is the test.
    expect(items[0].input).toEqual([{ role: 'user', content: 'Find me a flight to Paris' }]);
    expect((items[0].expected as Record<string, unknown>).toolCalls).toEqual([
      { name: 'search_flights', argsMatch: 'subset', args: { city: 'Paris', max: 3 } },
    ]);

    // Action 2: input carries the first call + its result (trcall ids paired).
    expect(items[1].input).toHaveLength(3);
    expect(items[1].input[1].toolCalls).toEqual([
      { id: 'trcall_1', name: 'search_flights', args: { city: 'Paris', max: 3 } },
    ]);
    expect(items[1].input[2]).toMatchObject({ role: 'tool', toolCallId: 'trcall_1' });
    expect((items[1].expected as Record<string, unknown>).toolCalls).toEqual([
      { name: 'book_flight', argsMatch: 'subset', args: { flight: 'AF123', seat: 12 } },
    ]);

    // Final answer: everything before the last assistant message, as before.
    expect(items[2].input).toHaveLength(5);
    expect((items[2].expected as Record<string, unknown>).reference).toBe('Booked AF123!');

    // The full inferred tool menu rides on EVERY item.
    for (const item of items) {
      expect(item.tools).toEqual([
        {
          name: 'search_flights',
          description: 'Inferred from recorded traffic',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' }, max: { type: 'number' } },
          },
        },
        {
          name: 'book_flight',
          description: 'Inferred from recorded traffic',
          parameters: {
            type: 'object',
            properties: { flight: { type: 'string' }, seat: { type: 'number' } },
          },
        },
      ]);
      expect(item.tags).toEqual(['snapshot', 'tracing', 'agent:travel-bot']);
    }
  });

  it('groups CONSECUTIVE calls into one action (parallel tool calls)', () => {
    const items = mapItems([
      msgEvent(1, 'user', 'Compare the weather'),
      toolCallEvent(2, 'get_weather', { city: 'Paris' }),
      toolCallEvent(3, 'get_weather', { city: 'Rome' }),
      toolResultEvent(4, { temp: 20 }),
      toolResultEvent(5, { temp: 25 }),
      msgEvent(6, 'assistant', 'Rome is warmer'),
    ]);

    expect(items.map((item) => item.id)).toEqual(['tr-sess-1#1', 'tr-sess-1']);
    expect((items[0].expected as Record<string, unknown>).toolCalls).toEqual([
      { name: 'get_weather', argsMatch: 'subset', args: { city: 'Paris' } },
      { name: 'get_weather', argsMatch: 'subset', args: { city: 'Rome' } },
    ]);
    // Results pair back to the two synthesized call ids in order.
    const final = items[1];
    expect(final.input.map((turn) => turn.toolCallId)).toEqual([undefined, undefined, undefined, 'trcall_1', 'trcall_2']);
    expect(final.tools).toHaveLength(1);
  });

  it('caps at MAX_ITEMS_PER_SESSION: final answer + the LAST 3 tool actions', () => {
    const events: IAgentTracingEvent[] = [msgEvent(1, 'user', 'go')];
    let seq = 2;
    for (let n = 1; n <= 5; n++) {
      events.push(toolCallEvent(seq++, `tool_${n}`, { n }));
      events.push(toolResultEvent(seq++, { ok: n }));
    }
    events.push(msgEvent(seq, 'assistant', 'done'));

    const items = mapItems(events);
    expect(items).toHaveLength(MAX_ITEMS_PER_SESSION);
    expect(items.map((item) => item.id)).toEqual(['tr-sess-1#1', 'tr-sess-1#2', 'tr-sess-1#3', 'tr-sess-1']);
    const actionNames = items
      .slice(0, 3)
      .map((item) => ((item.expected as Record<string, unknown>).toolCalls as Array<{ name: string }>)[0].name);
    expect(actionNames).toEqual(['tool_3', 'tool_4', 'tool_5']);
    expect((items[3].expected as Record<string, unknown>).reference).toBe('done');
    // The menu stays complete even for actions the cap dropped.
    expect(items[0].tools?.map((tool) => tool.name)).toEqual(['tool_1', 'tool_2', 'tool_3', 'tool_4', 'tool_5']);
  });

  it('unparseable args → name-only expectation, empty schema, __raw input args', () => {
    const items = mapItems([
      msgEvent(1, 'user', 'hi'),
      toolCallEvent(2, 'mystery', '{broken json'),
      toolResultEvent(3, 'ok'),
      msgEvent(4, 'assistant', 'done'),
    ]);

    expect(items).toHaveLength(2);
    expect((items[0].expected as Record<string, unknown>).toolCalls).toEqual([
      { name: 'mystery', argsMatch: 'subset' },
    ]);
    expect(items[0].tools).toEqual([
      {
        name: 'mystery',
        description: 'Inferred from recorded traffic',
        parameters: { type: 'object', properties: {} },
      },
    ]);
    // The conversation keeps the raw (anonymized) args for replay fidelity.
    expect(items[1].input[1].toolCalls?.[0].args).toEqual({ __raw: '{broken json' });
  });

  it('drops a type on conflicting observations but keeps the key', () => {
    const items = mapItems([
      msgEvent(1, 'user', 'a'),
      toolCallEvent(2, 'lookup', { id: 'abc' }),
      toolResultEvent(3, 'r1'),
      toolCallEvent(4, 'lookup', { id: 7, deep: true }),
      toolResultEvent(5, 'r2'),
      msgEvent(6, 'assistant', 'done'),
    ]);
    expect(items[0].tools?.[0].parameters).toEqual({
      type: 'object',
      properties: { id: {}, deep: { type: 'boolean' } },
    });
  });

  it('skips a tool action whose input would be empty (call is the first turn)', () => {
    const items = mapItems([
      toolCallEvent(1, 'boot', {}),
      toolResultEvent(2, 'ok'),
      msgEvent(3, 'assistant', 'ready'),
    ]);
    expect(items.map((item) => item.id)).toEqual(['tr-sess-1']);
    expect(items[0].input).toHaveLength(2);
    expect(items[0].tools?.map((tool) => tool.name)).toEqual(['boot']);
  });
});

// ── Recorded tool menus (tool_definitions sections) ────────────────────────

describe('mapTracingSession recorded tool menus', () => {
  const searchDef = {
    name: 'search_flights',
    description: 'Search flights by city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  };
  const bookDef = {
    name: 'book_flight',
    description: 'Book a flight',
    parameters: { type: 'object', properties: { seat: { type: 'number' } } },
  };

  it('menu changes between turns → items get the menu active at their action point', () => {
    const items = mapItems([
      toolDefsEvent(1, [searchDef]),
      msgEvent(2, 'user', 'Find me a flight to Paris'),
      toolCallEvent(3, 'search_flights', { city: 'Paris' }),
      toolResultEvent(4, { flights: ['AF123'] }),
      toolDefsEvent(5, [searchDef, bookDef]), // menu CHANGED for the next call
      toolCallEvent(6, 'book_flight', { seat: 1 }),
      toolResultEvent(7, { ok: true }),
      msgEvent(8, 'assistant', 'Booked!'),
    ]);

    expect(items.map((item) => item.id)).toEqual(['tr-sess-1#1', 'tr-sess-1#2', 'tr-sess-1']);
    // First action: only the menu recorded BEFORE it — two items, two lists.
    expect(items[0].tools).toEqual([searchDef]);
    expect(items[1].tools).toEqual([searchDef, bookDef]);
    // Final answer sees the last active menu.
    expect(items[2].tools).toEqual([searchDef, bookDef]);
  });

  it('recorded definitions win over inferred; called-but-unlisted tools merge in', () => {
    const items = mapItems([
      toolDefsEvent(1, [searchDef]),
      msgEvent(2, 'user', 'Find flights'),
      toolCallEvent(3, 'search_flights', { city: 'Paris' }),
      toolResultEvent(4, { flights: [] }),
      toolCallEvent(5, 'secret_tool', { x: 1 }), // called, but absent from the recorded menu
      toolResultEvent(6, 'ok'),
      msgEvent(7, 'assistant', 'done'),
    ]);

    expect(items.map((item) => item.id)).toEqual(['tr-sess-1#1', 'tr-sess-1#2', 'tr-sess-1']);
    // Recorded schema/description beat the inferred ones everywhere.
    for (const item of items) {
      const search = item.tools?.find((tool) => tool.name === 'search_flights');
      expect(search).toEqual(searchDef);
    }
    // First action involves only search_flights — no defensive merge yet.
    expect(items[0].tools).toEqual([searchDef]);
    // The secret_tool action and the final answer merge the inferred entry
    // for the tool the model demonstrably called.
    for (const item of [items[1], items[2]]) {
      expect(item.tools?.map((tool) => tool.name)).toEqual(['search_flights', 'secret_tool']);
      expect(item.tools?.[1]).toEqual({
        name: 'secret_tool',
        description: 'Inferred from recorded traffic',
        parameters: { type: 'object', properties: { x: { type: 'number' } } },
      });
    }
  });

  it('recorded descriptions pass through the anonymization gate', () => {
    const items = mapItems([
      toolDefsEvent(1, [{ ...searchDef, description: 'Report results to john.doe@example.com' }]),
      msgEvent(2, 'user', 'go'),
      toolCallEvent(3, 'search_flights', { city: 'Paris' }),
      toolResultEvent(4, 'ok'),
      msgEvent(5, 'assistant', 'done'),
    ]);
    const description = items[0].tools?.[0].description ?? '';
    expect(description).toMatch(/^Report results to <EMAIL_[0-9a-f]{6}>$/);
    expect(JSON.stringify(items)).not.toContain('john.doe@example.com');
  });

  it('falls back to the inferred menu when no tool_definitions sections exist', () => {
    const items = mapItems([
      msgEvent(1, 'user', 'go'),
      toolCallEvent(2, 'lookup', { id: 'a' }),
      toolResultEvent(3, 'ok'),
      msgEvent(4, 'assistant', 'done'),
    ]);
    for (const item of items) {
      expect(item.tools).toEqual([
        {
          name: 'lookup',
          description: 'Inferred from recorded traffic',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ]);
    }
  });

  it('a recorded menu with no observed calls still attaches to items', () => {
    const items = mapItems([
      toolDefsEvent(1, [searchDef]),
      msgEvent(2, 'user', 'hi'),
      msgEvent(3, 'assistant', 'hello'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].tools).toEqual([searchDef]);
  });
});

describe('inferToolSchema', () => {
  it('unions keys across observations with per-key types', () => {
    expect(inferToolSchema([{ a: 'x', b: 1 }, { a: 'y', c: true, d: [1], e: { k: 1 } }])).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
        c: { type: 'boolean' },
        d: { type: 'array' },
        e: { type: 'object' },
      },
    });
  });

  it('null-only keys and conflicting types stay typeless', () => {
    expect(inferToolSchema([{ a: 'x', n: null }, { a: 1 }])).toEqual({
      type: 'object',
      properties: { a: {}, n: {} },
    });
  });

  it('no observations → empty object schema', () => {
    expect(inferToolSchema([])).toEqual({ type: 'object', properties: {} });
  });
});

// ── Service orchestration (mocked DB) ──────────────────────────────────────

describe('createSnapshotDataset', () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (createDataset as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'ds-1',
      key: 'snapshot-aug',
      name: 'Snapshot Aug',
    });
  });

  it('refuses to run without anonymization options', async () => {
    await expect(
      createSnapshotDataset(CTX, {
        source: 'gateway',
        name: 'x',
        anonymize: undefined as unknown as AnonymizeOptions,
      }),
    ).rejects.toThrow(/anonymize/);
    expect(createDataset).not.toHaveBeenCalled();
  });

  it('refuses anonymization with no categories and no custom patterns', async () => {
    await expect(
      createSnapshotDataset(CTX, {
        source: 'gateway',
        name: 'x',
        anonymize: { categories: [], strategy: 'mask', salt: 's' },
      }),
    ).rejects.toThrow(/categories/);
  });

  it('samples gateway rows, skips broken payloads, persists via createDataset without the salt', async () => {
    db.listModels.mockResolvedValue([{ key: 'gpt-4o' } as never]);
    db.listModelUsageLogs.mockResolvedValue([
      gatewayRow({ requestId: 'req-a' }),
      gatewayRow({ requestId: 'req-b', providerRequest: { _truncated: true } }),
      gatewayRow({ requestId: 'req-c', status: 'error' }),
    ]);

    const result = await createSnapshotDataset(CTX, {
      source: 'gateway',
      filters: { status: 'success', samplePct: 100 },
      name: 'Snapshot Aug',
      anonymize: ANON,
    });

    expect(result.matching).toBe(2); // req-c filtered out by status
    expect(result.sampled).toBe(2);
    expect(result.created).toBe(1);
    expect(result.skipped.truncatedPayload).toBe(1);
    expect(result.dataset).toEqual({ id: 'ds-1', key: 'snapshot-aug', name: 'Snapshot Aug' });

    expect(createDataset).toHaveBeenCalledTimes(1);
    const [tenantDbName, tenantId, createdBy, input] = (createDataset as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tenantDbName).toBe(CTX.tenantDbName);
    expect(tenantId).toBe(CTX.tenantId);
    expect(createdBy).toBe('user-1');
    expect(input.source).toBe('generated');
    expect(input.items).toHaveLength(1);

    // Provenance recorded; salt NEVER persisted.
    const snapshotMeta = input.metadata.snapshot;
    expect(snapshotMeta.source).toBe('gateway');
    expect(snapshotMeta.anonymization).toEqual({
      strategy: 'pseudonym',
      categories: ['email'],
      customPatternCount: 0,
    });
    expect(JSON.stringify(input.metadata)).not.toContain('test-salt');
  });

  it('respects the deterministic sample for partial percentages', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => gatewayRow({ requestId: `req-${i}` }));
    db.listModels.mockResolvedValue([{ key: 'gpt-4o' } as never]);
    db.listModelUsageLogs.mockResolvedValue(rows);

    const result = await createSnapshotDataset(CTX, {
      source: 'gateway',
      filters: { samplePct: 20 },
      name: 'Partial',
      anonymize: ANON,
    });

    const expectedIds = rows.filter((r) => isSampled(r.requestId, 20)).map((r) => `gw-${r.requestId}`);
    expect(result.sampled).toBe(expectedIds.length);
    const [, , , input] = (createDataset as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(input.items.map((item: { id: string }) => item.id)).toEqual(expectedIds);
  });

  it('maps tracing sessions and reports the shape breakdown', async () => {
    db.listAgentTracingSessions.mockResolvedValue({
      sessions: [tracingSession({ sessionId: 'sess-1' }), tracingSession({ sessionId: 'sess-2' })],
      total: 2,
    });
    db.listAgentTracingEvents.mockImplementation(async (sessionId: string) =>
      sessionId === 'sess-1'
        ? [tracingEvent({ sequence: 1, sections: [{ kind: 'message', role: 'user', content: 'hello' }] })]
        : [tracingEvent({ sequence: 1, sections: [{ kind: 'metadata', content: 'no messages' }] })],
    );

    const result = await createSnapshotDataset(CTX, {
      source: 'tracing',
      name: 'Traces',
      anonymize: ANON,
    });

    expect(result.created).toBe(1);
    expect(result.skipped.unmappable).toBe(1);
    expect(result.tracingShapes).toEqual({
      messageSections: 1,
      noContent: 1,
      mappableFraction: 0.5,
    });
  });

  it('multi-item tracing sessions respect the item limit and record itemsPerSession', async () => {
    db.listAgentTracingSessions.mockResolvedValue({ sessions: [tracingSession()], total: 1 });
    // Session emits 3 items: two tool actions + the final answer.
    db.listAgentTracingEvents.mockResolvedValue([
      msgEvent(1, 'user', 'Find me a flight'),
      toolCallEvent(2, 'search_flights', { city: 'Paris' }),
      toolResultEvent(3, { flights: [] }),
      toolCallEvent(4, 'book_flight', { seat: 1 }),
      toolResultEvent(5, { ok: true }),
      msgEvent(6, 'assistant', 'Booked!'),
    ]);

    const result = await createSnapshotDataset(CTX, {
      source: 'tracing',
      filters: { limit: 2 },
      name: 'Traces capped',
      anonymize: ANON,
    });

    // `sampled` counts SESSIONS, `created` counts ITEMS; limit cuts mid-session.
    expect(result.sampled).toBe(1);
    expect(result.created).toBe(2);
    const [, , , input] = (createDataset as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(input.items.map((item: { id: string }) => item.id)).toEqual(['tr-sess-1#1', 'tr-sess-1#2']);
    expect(input.items[0].tools).toHaveLength(2);
    expect(input.metadata.snapshot.counts.itemsPerSession).toBe(2);
  });
});

describe('previewSnapshot', () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('counts matching + sampled with a per-model breakdown and no payloads', async () => {
    db.listModels.mockResolvedValue([{ key: 'gpt-4o' } as never, { key: 'claude' } as never]);
    db.listModelUsageLogs.mockImplementation(async (modelKey: string) =>
      modelKey === 'gpt-4o'
        ? [gatewayRow({ requestId: 'r1' }), gatewayRow({ requestId: 'r2', status: 'error' })]
        : [gatewayRow({ requestId: 'r3', modelKey: 'claude' })],
    );

    const preview = await previewSnapshot(CTX, {
      source: 'gateway',
      filters: { status: 'success', samplePct: 100 },
    });

    expect(preview.matching).toBe(2);
    expect(preview.sampled).toBe(2);
    expect(preview.wouldCreate).toBe(2);
    expect(preview.scanCapped).toBe(false);
    expect(preview.breakdown).toEqual([
      { key: 'gpt-4o', matching: 1, sampled: 1 },
      { key: 'claude', matching: 1, sampled: 1 },
    ]);
    expect(JSON.stringify(preview)).not.toContain('travel agent');
  });
});

describe('deriveSnapshotFilterOptions', () => {
  it('collects distinct agents and gateway-served models, sorted', async () => {
    const { deriveSnapshotFilterOptions } = await import('@/lib/services/snapshots/snapshotService');
    const options = deriveSnapshotFilterOptions([
      { agentKey: 'Pulse Main Agent', refKey: 'gpt-4o', source: 'tracing' },
      { agentKey: 'Compactor', refKey: 'gpt-4o-mini', source: 'api' },
      { agentKey: '', refKey: 'gpt-4o', source: 'api' },
      { agentKey: 'Compactor', refKey: 'gpt-4o-mini', source: 'api' },
      { agentKey: 'Pulse Main Agent', refKey: '', source: 'tracing' },
    ]);
    expect(options.agents).toEqual(['Compactor', 'Pulse Main Agent']);
    // tracing-source refKeys are NOT offered — gateway scan cannot filter on them
    expect(options.gatewayModels).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('returns empty lists for no rows', async () => {
    const { deriveSnapshotFilterOptions } = await import('@/lib/services/snapshots/snapshotService');
    expect(deriveSnapshotFilterOptions([])).toEqual({ agents: [], gatewayModels: [] });
  });
});
