/**
 * Unit tests — evaluation tool-call (trajectory) scorer + extractToolCalls.
 * Covers canonicalJson stability, selection F1, sequence similarity, every
 * argsMatch mode, the empty-expected/empty-actual abstention case, threshold
 * pass/fail, and OpenAI/Responses tool-call extraction (invalid-JSON args).
 */

import { describe, it, expect, vi } from 'vitest';
import { scoreToolCall, canonicalJson } from '@/lib/services/evaluation/scorers/toolCallScorer';
import type {
  DatasetItem,
  ExpectedToolCall,
  NormalizedToolCall,
  ToolCallScorerConfig,
} from '@/lib/services/evaluation/types';

// adapters.ts pulls in the model runtime + database at import time; stub the
// heavy modules so extractToolCalls (pure) can be tested in isolation.
// TRAP: factories must be synchronous — async vi.mock factories silently
// fail to intercept.
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: vi.fn(),
  handleEmbeddingRequest: vi.fn(),
}));
vi.mock('@/lib/services/models/usageLogger', () => ({
  calculateCost: vi.fn(() => ({ currency: 'USD', inputCost: 0, outputCost: 0, cachedCost: 0, totalCost: 0 })),
}));
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

import { extractToolCalls } from '@/lib/services/evaluation/adapters';

const CONFIG: ToolCallScorerConfig = { type: 'tool-call' };

function item(toolCalls?: ExpectedToolCall[]): DatasetItem {
  return {
    id: 'i1',
    input: [{ role: 'user', content: 'hi' }],
    expected: toolCalls === undefined ? undefined : { toolCalls },
  };
}

function out(toolCalls?: NormalizedToolCall[]): { toolCalls?: NormalizedToolCall[] } {
  return { toolCalls };
}

describe('canonicalJson', () => {
  it('is stable across object key order, recursively', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('trims string values (including nested and array members)', () => {
    expect(canonicalJson({ q: '  hello  ' })).toBe('{"q":"hello"}');
    expect(canonicalJson(['  x ', { y: ' z ' }])).toBe('["x",{"y":"z"}]');
  });

  it('follows JSON semantics for undefined and primitives', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(3)).toBe('3');
  });
});

describe('toolCallScorer — selection', () => {
  it('scores 1 when the exact tool multiset is called', () => {
    const r = scoreToolCall(
      item([{ name: 'search', argsMatch: 'ignore' }]),
      out([{ name: 'search', args: {} }]),
      CONFIG,
    );
    expect(r.detail?.selection).toBe(1);
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
  });

  it('computes F1 over name multisets for partial overlap', () => {
    // expected {a, b}, actual {a, c}: intersection 1, P = R = 1/2, F1 = 1/2.
    const r = scoreToolCall(
      item([
        { name: 'a', argsMatch: 'ignore' },
        { name: 'b', argsMatch: 'ignore' },
      ]),
      out([
        { name: 'a', args: {} },
        { name: 'c', args: {} },
      ]),
      CONFIG,
    );
    expect(r.detail?.selection).toBeCloseTo(0.5);
    expect(r.detail?.unexpectedCalls).toEqual(['c']);
  });

  it('respects multiset counts (a called once when expected twice)', () => {
    // expected {a, a}, actual {a}: intersection 1, P = 1, R = 1/2, F1 = 2/3.
    const r = scoreToolCall(
      item([
        { name: 'a', argsMatch: 'ignore' },
        { name: 'a', argsMatch: 'ignore' },
      ]),
      out([{ name: 'a', args: {} }]),
      CONFIG,
    );
    expect(r.detail?.selection).toBeCloseTo(2 / 3);
  });

  it('scores 0 when expected calls exist but none were made', () => {
    const r = scoreToolCall(item([{ name: 'a', argsMatch: 'ignore' }]), out([]), CONFIG);
    expect(r.detail?.selection).toBe(0);
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });
});

describe('toolCallScorer — sequence', () => {
  it('scores 1 for the exact order and penalises swaps via Levenshtein', () => {
    const expected: ExpectedToolCall[] = [
      { name: 'a', argsMatch: 'ignore' },
      { name: 'b', argsMatch: 'ignore' },
      { name: 'c', argsMatch: 'ignore' },
    ];
    const inOrder = scoreToolCall(
      item(expected),
      out([
        { name: 'a', args: {} },
        { name: 'b', args: {} },
        { name: 'c', args: {} },
      ]),
      CONFIG,
    );
    expect(inOrder.detail?.sequence).toBe(1);

    // a,c,b vs a,b,c: 2 substitutions over max length 3 → 1 - 2/3 = 1/3.
    const swapped = scoreToolCall(
      item(expected),
      out([
        { name: 'a', args: {} },
        { name: 'c', args: {} },
        { name: 'b', args: {} },
      ]),
      CONFIG,
    );
    expect(swapped.detail?.sequence).toBeCloseTo(1 / 3);
    // Selection is still perfect — same multiset.
    expect(swapped.detail?.selection).toBe(1);
  });
});

describe('toolCallScorer — args matching', () => {
  it("'exact' compares canonical JSON (key order / whitespace insensitive)", () => {
    const expected: ExpectedToolCall[] = [{ name: 'search', argsMatch: 'exact', args: { q: 'cats', limit: 5 } }];
    const pass = scoreToolCall(item(expected), out([{ name: 'search', args: { limit: 5, q: '  cats ' } }]), CONFIG);
    expect(pass.score).toBe(1);
    const fail = scoreToolCall(item(expected), out([{ name: 'search', args: { q: 'dogs', limit: 5 } }]), CONFIG);
    expect(fail.detail?.args).toBe(0);
  });

  it("'subset' requires expected keys deep-present in actual, extras allowed", () => {
    const expected: ExpectedToolCall[] = [
      { name: 'search', argsMatch: 'subset', args: { filter: { lang: 'en' } } },
    ];
    const pass = scoreToolCall(
      item(expected),
      out([{ name: 'search', args: { filter: { lang: 'en', region: 'us' }, limit: 10 } }]),
      CONFIG,
    );
    expect(pass.score).toBe(1);
    const fail = scoreToolCall(item(expected), out([{ name: 'search', args: { filter: { lang: 'tr' } } }]), CONFIG);
    expect(fail.detail?.args).toBe(0);
  });

  it("'schema' validates actual args against argsSchema", () => {
    const expected: ExpectedToolCall[] = [
      {
        name: 'search',
        argsMatch: 'schema',
        argsSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } },
      },
    ];
    const pass = scoreToolCall(item(expected), out([{ name: 'search', args: { q: 'cats' } }]), CONFIG);
    expect(pass.score).toBe(1);
    const fail = scoreToolCall(item(expected), out([{ name: 'search', args: { q: 42 } }]), CONFIG);
    expect(fail.detail?.args).toBe(0);
  });

  it("'ignore' excludes the call from args scoring entirely", () => {
    const r = scoreToolCall(
      item([{ name: 'search', argsMatch: 'ignore', args: { q: 'ignored' } }]),
      out([{ name: 'search', args: { q: 'totally different' } }]),
      CONFIG,
    );
    // No args component: renormalised over selection + sequence only → 1.
    expect(r.detail?.args).toBeUndefined();
    expect(r.score).toBe(1);
  });

  it('scores an unmatched expected call as 0 args', () => {
    const r = scoreToolCall(
      item([
        { name: 'a', argsMatch: 'exact', args: {} },
        { name: 'b', argsMatch: 'exact', args: {} },
      ]),
      out([{ name: 'a', args: {} }]),
      CONFIG,
    );
    expect(r.detail?.args).toBeCloseTo(0.5);
    const calls = r.detail?.calls as Array<{ name: string; argsScore?: number }>;
    expect(calls.find((c) => c.name === 'b')?.argsScore).toBe(0);
  });
});

describe('toolCallScorer — combination / threshold', () => {
  it('returns 1 (passed) when nothing was expected and nothing was called', () => {
    expect(scoreToolCall(item([]), out([]), CONFIG).score).toBe(1);
    expect(scoreToolCall(item([]), out(undefined), CONFIG).passed).toBe(true);
    expect(scoreToolCall(item(undefined), out([]), CONFIG).score).toBe(1);
  });

  it('scores 0 when nothing was expected but calls were made', () => {
    const r = scoreToolCall(item([]), out([{ name: 'rogue', args: {} }]), CONFIG);
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  it('applies the default 0.75 threshold and honours overrides', () => {
    // Perfect selection/sequence, failing args → 0.5*1 + 0.2*1 + 0.3*0 = 0.7.
    const expected: ExpectedToolCall[] = [{ name: 'a', argsMatch: 'exact', args: { x: 1 } }];
    const actual = out([{ name: 'a', args: { x: 2 } }]);
    const r = scoreToolCall(item(expected), actual, CONFIG);
    expect(r.score).toBeCloseTo(0.7);
    expect(r.passed).toBe(false); // 0.7 < default 0.75

    const lenient = scoreToolCall(item(expected), actual, { ...CONFIG, threshold: 0.6 });
    expect(lenient.passed).toBe(true);
  });

  it('renormalises custom component weights', () => {
    // selection 1, sequence 1, args 0 with weights 1/1/2 → 2/4 = 0.5.
    const r = scoreToolCall(
      item([{ name: 'a', argsMatch: 'exact', args: { x: 1 } }]),
      out([{ name: 'a', args: { x: 2 } }]),
      { ...CONFIG, selectionWeight: 1, sequenceWeight: 1, argsWeight: 2 },
    );
    expect(r.score).toBeCloseTo(0.5);
  });

  it('defaults argsMatch from the expectation fields (args → exact)', () => {
    const r = scoreToolCall(
      item([{ name: 'a', args: { x: 1 } }]),
      out([{ name: 'a', args: { x: 1, extra: true } }]),
      CONFIG,
    );
    expect(r.detail?.args).toBe(0); // extra key breaks exact equality
  });
});

describe('extractToolCalls', () => {
  it('parses the OpenAI chat-completion tool_calls shape', () => {
    const response = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"cats","limit":5}' } },
              { id: 'c2', type: 'function', function: { name: 'fetch', arguments: '{}' } },
            ],
          },
        },
      ],
    };
    expect(extractToolCalls(response)).toEqual([
      { name: 'search', args: { q: 'cats', limit: 5 } },
      { name: 'fetch', args: {} },
    ]);
  });

  it('carries invalid-JSON arguments as { __raw }', () => {
    const response = {
      choices: [
        {
          message: {
            tool_calls: [{ function: { name: 'search', arguments: '{"q": broken' } }],
          },
        },
      ],
    };
    expect(extractToolCalls(response)).toEqual([{ name: 'search', args: { __raw: '{"q": broken' } }]);
  });

  it('parses Responses-shaped function_call output items', () => {
    const response = {
      output: [
        { type: 'function_call', name: 'search', arguments: '{"q":"cats"}' },
        { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
      ],
    };
    expect(extractToolCalls(response)).toEqual([{ name: 'search', args: { q: 'cats' } }]);
  });

  it('returns [] for responses without tool calls (or garbage input)', () => {
    expect(extractToolCalls({ choices: [{ message: { content: 'plain text' } }] })).toEqual([]);
    expect(extractToolCalls(null)).toEqual([]);
    expect(extractToolCalls('nonsense')).toEqual([]);
  });
});

describe('toProviderMessages', () => {
  it('serializes tool fidelity to the OpenAI wire format, synthesizing missing ids', async () => {
    const { toProviderMessages } = await import('@/lib/services/evaluation/adapters');
    const wire = toProviderMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'book it' },
      { role: 'assistant', content: '', toolCalls: [{ name: 'book_flight', args: { city: 'Paris' } }] },
      { role: 'tool', content: '{"ok":true}' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(wire[0]).toEqual({ role: 'system', content: 'sys' });
    expect(wire[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'book_flight', arguments: '{"city":"Paris"}' } },
      ],
    });
    // The id-less tool turn links to the oldest open synthesized call.
    expect(wire[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' });
    expect(wire[4]).toEqual({ role: 'assistant', content: 'done' });
  });

  it('keeps recorded call ids and tool names verbatim', async () => {
    const { toProviderMessages } = await import('@/lib/services/evaluation/adapters');
    const wire = toProviderMessages([
      { role: 'assistant', content: 'calling', toolCalls: [{ id: 'call_9', name: 'lookup', args: { q: 'x' } }] },
      { role: 'tool', content: 'result', toolCallId: 'call_9', name: 'lookup' },
    ]);
    expect(wire[0]).toMatchObject({ tool_calls: [{ id: 'call_9' }] });
    expect(wire[1]).toEqual({ role: 'tool', tool_call_id: 'call_9', content: 'result', name: 'lookup' });
  });
});

describe('toProviderMessages wire validity', () => {
  it('closes unanswered tool_calls with stand-in tool messages', async () => {
    const { toProviderMessages } = await import('@/lib/services/evaluation/adapters');
    const wire = toProviderMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'trcall_1', name: 'lookup', args: {} }] },
      // No tool response recorded — next turn is a user message.
      { role: 'user', content: 'and then?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'trcall_2', name: 'lookup', args: {} }] },
      // Conversation ends with an open call too.
    ]);
    expect(wire[2]).toEqual({ role: 'tool', tool_call_id: 'trcall_1', content: '[no recorded tool result]' });
    expect(wire[3]).toEqual({ role: 'user', content: 'and then?' });
    expect(wire[5]).toEqual({ role: 'tool', tool_call_id: 'trcall_2', content: '[no recorded tool result]' });
    // Validity: every tool_call id has a tool message before the next non-tool turn.
    expect(wire).toHaveLength(6);
  });

  it('does not inject stand-ins when calls are properly answered', async () => {
    const { toProviderMessages } = await import('@/lib/services/evaluation/adapters');
    const wire = toProviderMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', args: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 'c1' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(wire).toHaveLength(3);
    expect(wire.filter((m) => m.content === '[no recorded tool result]')).toHaveLength(0);
  });
});

describe('toProviderMessages orphan tool responses', () => {
  it('synthesizes the declaring assistant turn for an undeclared tool_call_id', async () => {
    const { toProviderMessages } = await import('@/lib/services/evaluation/adapters');
    const wire = toProviderMessages([
      { role: 'user', content: 'go' },
      // Result recorded, call never captured — the failing-run shape.
      { role: 'tool', content: '{"ok":true}', toolCallId: 'trcall_1', name: 'lookup' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(wire[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'trcall_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    });
    expect(wire[2]).toMatchObject({ role: 'tool', tool_call_id: 'trcall_1' });
    expect(wire[3]).toEqual({ role: 'assistant', content: 'done' });
  });

  it('closes other open calls before synthesizing an orphan declaration', async () => {
    const { toProviderMessages } = await import('@/lib/services/evaluation/adapters');
    const wire = toProviderMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'a1', name: 'first', args: {} }] },
      // Orphan for a different id while a1 is still unanswered.
      { role: 'tool', content: 'r', toolCallId: 'b2', name: 'second' },
    ]);
    // a1 must be answered before the synthesized b2 declaration.
    expect(wire[1]).toMatchObject({ role: 'tool', tool_call_id: 'a1' });
    expect(wire[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'b2' }] });
    expect(wire[3]).toMatchObject({ role: 'tool', tool_call_id: 'b2' });
  });
});
