/**
 * Unit tests for the dataset-item editor's pure helpers
 * (src/components/evaluations/datasetItemHelpers.ts): JSON validity,
 * draft ↔ item conversion (round-trip + validation), tool-name inference,
 * toolCallId declaration, id suggestion, summaries, and the simple-row /
 * default-tools conversions used by the manual creation flow.
 * No React/DOM involved.
 */

import { describe, expect, it } from 'vitest';
import type { EvalDatasetItemView } from '@/components/evaluations/types';
import {
  applyDefaultTools,
  declaredToolCallIds,
  declaredToolNames,
  draftToItem,
  emptyItemDraft,
  emptyTurnDraft,
  inferMissingToolNames,
  itemToDraft,
  jsonTextError,
  parseItemJson,
  parseJsonValueLoose,
  resolveArgsMatch,
  simpleRowToItem,
  suggestItemId,
  summarizeItem,
  toolDraftsToDefinitions,
  type TurnDraft,
} from '@/components/evaluations/datasetItemHelpers';
import { editorRowsToItems } from '@/components/evaluations/datasetImport';

/** The JSON_TEMPLATE tool-trajectory item, used as the round-trip fixture. */
const TRAJECTORY_ITEM: EvalDatasetItemView = {
  id: 'q3-tool-trajectory',
  input: [
    { role: 'system', content: 'You are a travel booking assistant.' },
    { role: 'user', content: 'Book a flight to Paris.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'search_flights', args: { city: 'Paris' } }],
    },
    { role: 'tool', toolCallId: 'call_1', name: 'search_flights', content: '{"flights":[{"id":"AF123"}]}' },
    { role: 'user', content: 'Take the first one.' },
  ],
  tools: [
    {
      name: 'search_flights',
      description: 'Search available flights',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
    { name: 'book_flight', description: 'Book a flight by id' },
  ],
  toolResults: { 'search_flights({"city":"Paris"})': { flights: [{ id: 'AF123' }] } },
  expected: {
    reference: 'AF123 is booked.',
    toolCalls: [{ name: 'book_flight', argsMatch: 'subset', args: { flightId: 'AF123' } }],
    mustContain: ['AF123'],
    jsonPath: [{ path: 'data.ok', exists: true, equals: true }],
  },
  tags: ['travel'],
};

describe('jsonTextError', () => {
  it('accepts blank and valid JSON', () => {
    expect(jsonTextError('')).toBeNull();
    expect(jsonTextError('   ')).toBeNull();
    expect(jsonTextError('{"a":1}')).toBeNull();
    expect(jsonTextError('[1,2]')).toBeNull();
  });

  it('reports invalid JSON', () => {
    expect(jsonTextError('{oops')).toMatch(/^Invalid JSON/);
  });

  it('enforces object shape when required', () => {
    expect(jsonTextError('[1]', { requireObject: true })).toBe('Must be a JSON object');
    expect(jsonTextError('"str"', { requireObject: true })).toBe('Must be a JSON object');
    expect(jsonTextError('{"a":1}', { requireObject: true })).toBeNull();
  });
});

describe('parseJsonValueLoose', () => {
  it('parses valid JSON values', () => {
    expect(parseJsonValueLoose('42')).toBe(42);
    expect(parseJsonValueLoose('true')).toBe(true);
    expect(parseJsonValueLoose('"Paris"')).toBe('Paris');
    expect(parseJsonValueLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('falls back to a plain string for bare text', () => {
    expect(parseJsonValueLoose('Paris')).toBe('Paris');
  });
});

describe('itemToDraft / draftToItem round-trip', () => {
  it('round-trips the full tool-trajectory item losslessly', () => {
    const draft = itemToDraft(TRAJECTORY_ITEM);
    const result = draftToItem(draft);
    expect(result.errors).toEqual([]);
    expect(result.item).toEqual(TRAJECTORY_ITEM);
  });

  it('preserves unknown item and expected keys', () => {
    const item: EvalDatasetItemView = {
      id: 'x',
      input: [{ role: 'user', content: 'hi' }],
      expected: { reference: 'yo', customScore: { min: 0.5 } },
      // custom top-level key power users may add via raw JSON
      metadata: { origin: 'traffic' },
    } as EvalDatasetItemView & { metadata: unknown };
    const result = draftToItem(itemToDraft(item));
    expect(result.errors).toEqual([]);
    expect((result.item as unknown as Record<string, unknown>).metadata).toEqual({ origin: 'traffic' });
    expect(result.item?.expected?.customScore).toEqual({ min: 0.5 });
    expect(result.item?.expected?.reference).toBe('yo');
  });

  it('omits empty optional structures', () => {
    const draft = emptyItemDraft('slim');
    draft.turns[0].content = 'question';
    const result = draftToItem(draft);
    expect(result.errors).toEqual([]);
    expect(result.item).toEqual({ id: 'slim', input: [{ role: 'user', content: 'question' }] });
  });

  it('serializes expected tool calls per argsMatch mode', () => {
    const draft = emptyItemDraft('etc');
    draft.turns[0].content = 'q';
    draft.expectedToolCalls = [
      { name: 'a', argsMatch: 'exact', argsText: '', argsSchemaText: '' },
      { name: 'b', argsMatch: 'subset', argsText: '{"k":1}', argsSchemaText: '' },
      { name: 'c', argsMatch: 'schema', argsText: '', argsSchemaText: '{"type":"object"}' },
      { name: 'd', argsMatch: 'ignore', argsText: '{"junk":true}', argsSchemaText: '' },
    ];
    const result = draftToItem(draft);
    expect(result.errors).toEqual([]);
    expect(result.item?.expected?.toolCalls).toEqual([
      { name: 'a', argsMatch: 'exact', args: {} },
      { name: 'b', argsMatch: 'subset', args: { k: 1 } },
      { name: 'c', argsMatch: 'schema', argsSchema: { type: 'object' } },
      { name: 'd', argsMatch: 'ignore' },
    ]);
  });

  it('collects validation errors instead of failing fast', () => {
    const draft = emptyItemDraft('');
    draft.turns = [
      { ...emptyTurnDraft('assistant'), toolCalls: [{ id: '', name: '', argsText: '{bad' }] },
      { ...emptyTurnDraft('tool'), content: 'result' },
    ];
    draft.regex = '(';
    const result = draftToItem(draft);
    expect(result.item).toBeUndefined();
    expect(result.errors.join('\n')).toMatch(/Item id is required/);
    expect(result.errors.join('\n')).toMatch(/tool call 1 needs a name/);
    expect(result.errors.join('\n')).toMatch(/tool call 1 args/);
    expect(result.errors.join('\n')).toMatch(/tool turns need a toolCallId/);
    expect(result.errors.join('\n')).toMatch(/regex does not compile/);
  });

  it('rejects an empty conversation', () => {
    const draft = emptyItemDraft('empty');
    const result = draftToItem(draft);
    expect(result.item).toBeUndefined();
    expect(result.errors.join('\n')).toMatch(/at least one turn with content/);
  });

  it('accepts a free-text toolCallId that no assistant turn declared', () => {
    const draft = emptyItemDraft('free');
    draft.turns = [{ ...emptyTurnDraft('tool'), content: '{}', toolCallId: 'call_external' }];
    const result = draftToItem(draft);
    expect(result.errors).toEqual([]);
    expect(result.item?.input[0].toolCallId).toBe('call_external');
  });

  it('validates toolResults rows (key required, strict JSON values)', () => {
    const draft = emptyItemDraft('tr');
    draft.turns[0].content = 'q';
    draft.toolResultRows = [
      { key: '', valueText: '{}' },
      { key: 'a()', valueText: 'not json' },
      { key: 'b()', valueText: '"quoted string"' },
    ];
    const result = draftToItem(draft);
    expect(result.item).toBeUndefined();
    expect(result.errors.join('\n')).toMatch(/key is required/);
    expect(result.errors.join('\n')).toMatch(/value must be valid JSON/);
  });
});

describe('parseItemJson', () => {
  it('rejects empty / invalid / non-object / missing input', () => {
    expect(parseItemJson('')).toEqual({ error: 'Item JSON is empty.' });
    expect(parseItemJson('{nope')).toMatchObject({ error: expect.stringMatching(/^Invalid JSON/) });
    expect(parseItemJson('[1]')).toEqual({ error: 'Item must be a JSON object.' });
    expect(parseItemJson('{"id":"x"}')).toEqual({ error: 'Item must have an "input" array of messages.' });
  });

  it('accepts a full item and coerces a missing id to empty string', () => {
    const parsed = parseItemJson('{"input":[{"role":"user","content":"hi"}]}');
    expect('item' in parsed && parsed.item.id).toBe('');
  });
});

describe('inferMissingToolNames', () => {
  const turns: TurnDraft[] = [
    { ...emptyTurnDraft('assistant'), toolCalls: [
      { id: '1', name: 'search_flights', argsText: '' },
      { id: '2', name: 'book_flight', argsText: '' },
      { id: '3', name: 'search_flights', argsText: '' },
    ] },
    { ...emptyTurnDraft('user'), content: 'ok' },
  ];

  it('returns deduplicated names not yet declared', () => {
    expect(inferMissingToolNames(turns, [{ name: 'search_flights' }])).toEqual(['book_flight']);
  });

  it('returns empty when everything is declared', () => {
    expect(inferMissingToolNames(turns, [{ name: 'search_flights' }, { name: 'book_flight' }])).toEqual([]);
  });
});

describe('declaredToolCallIds', () => {
  const turns: TurnDraft[] = [
    { ...emptyTurnDraft('assistant'), toolCalls: [{ id: 'call_1', name: 'a', argsText: '' }] },
    { ...emptyTurnDraft('tool'), toolCallId: 'call_1' },
    { ...emptyTurnDraft('assistant'), toolCalls: [{ id: 'call_2', name: 'b', argsText: '' }, { id: '', name: 'c', argsText: '' }] },
  ];

  it('collects ids from assistant turns before the given index', () => {
    expect(declaredToolCallIds(turns, 1)).toEqual(['call_1']);
    expect(declaredToolCallIds(turns, 2)).toEqual(['call_1']);
  });

  it('collects all ids when no index given, skipping blanks', () => {
    expect(declaredToolCallIds(turns)).toEqual(['call_1', 'call_2']);
  });
});

describe('declaredToolNames', () => {
  it('dedupes and skips blanks', () => {
    expect(declaredToolNames([{ name: 'a' }, { name: ' ' }, { name: 'a' }, { name: 'b' }])).toEqual(['a', 'b']);
  });
});

describe('suggestItemId', () => {
  it('starts at manual-1 and skips taken ids', () => {
    expect(suggestItemId([])).toBe('manual-1');
    expect(suggestItemId(['manual-1', 'manual-2', 'other'])).toBe('manual-3');
    expect(suggestItemId(['manual-2'])).toBe('manual-1');
  });
});

describe('resolveArgsMatch', () => {
  it('mirrors the scorer defaults', () => {
    expect(resolveArgsMatch({ name: 'x', argsMatch: 'schema' })).toBe('schema');
    expect(resolveArgsMatch({ name: 'x', args: {} })).toBe('exact');
    expect(resolveArgsMatch({ name: 'x', argsSchema: {} })).toBe('schema');
    expect(resolveArgsMatch({ name: 'x' })).toBe('ignore');
  });
});

describe('summarizeItem', () => {
  it('summarizes the trajectory item', () => {
    expect(summarizeItem(TRAJECTORY_ITEM)).toEqual({
      turns: 5,
      tools: 2,
      hasReference: true,
      hasExpectedToolCalls: true,
      hasAssertions: true,
    });
  });

  it('reports a bare item as expectation-free', () => {
    expect(summarizeItem({ id: 'x', input: [{ role: 'user', content: 'q' }] })).toEqual({
      turns: 1,
      tools: 0,
      hasReference: false,
      hasExpectedToolCalls: false,
      hasAssertions: false,
    });
  });
});

describe('simpleRowToItem', () => {
  it('lifts a simple row into a single-turn item', () => {
    const item = simpleRowToItem(
      { id: '', input: ' What is 2+2? ', reference: '4', contains: '4|four', tags: 'math, smoke' },
      'item-3',
    );
    expect(item).toEqual({
      id: 'item-3',
      input: [{ role: 'user', content: 'What is 2+2?' }],
      expected: { reference: '4', mustContain: ['4', 'four'] },
      tags: ['math', 'smoke'],
    });
  });

  it('keeps an explicit id and omits empty expected/tags', () => {
    const item = simpleRowToItem({ id: 'q9', input: 'hi', reference: '', contains: '', tags: '' }, 'item-1');
    expect(item).toEqual({ id: 'q9', input: [{ role: 'user', content: 'hi' }] });
  });
});

describe('applyDefaultTools', () => {
  const defaults = [{ name: 'search', description: 'Search' }];

  it('fills tools only for items without their own', () => {
    const items: EvalDatasetItemView[] = [
      { id: 'a', input: [{ role: 'user', content: 'x' }] },
      { id: 'b', input: [{ role: 'user', content: 'y' }], tools: [{ name: 'own' }] },
    ];
    const [a, b] = applyDefaultTools(items, defaults);
    expect(a.tools).toEqual(defaults);
    expect(a.tools).not.toBe(defaults); // cloned, not shared
    expect(b.tools).toEqual([{ name: 'own' }]);
  });

  it('is a no-op without defaults', () => {
    const items: EvalDatasetItemView[] = [{ id: 'a', input: [] }];
    expect(applyDefaultTools(items, [])).toBe(items);
  });
});

describe('toolDraftsToDefinitions', () => {
  it('converts drafts and trims optional fields', () => {
    const { tools, errors } = toolDraftsToDefinitions([
      { name: ' search ', description: '', parametersText: '{"type":"object"}' },
    ]);
    expect(errors).toEqual([]);
    expect(tools).toEqual([{ name: 'search', parameters: { type: 'object' } }]);
  });

  it('reports missing names and invalid parameters', () => {
    const { errors } = toolDraftsToDefinitions([
      { name: '', description: '', parametersText: '' },
      { name: 'x', description: '', parametersText: '{bad' },
    ]);
    expect(errors).toHaveLength(2);
  });
});

describe('editorRowsToItems (advanced rows + default tools)', () => {
  it('passes advanced rows through and applies default tools to tool-less items', () => {
    const advanced: EvalDatasetItemView = {
      id: 'adv-1',
      input: [{ role: 'user', content: 'multi' }],
      tools: [{ name: 'own_tool' }],
    };
    const items = editorRowsToItems(
      [
        { id: '', input: 'simple q', reference: 'a', contains: '', tags: '' },
        { id: '', input: '', reference: '', contains: '', tags: '', item: advanced },
        { id: '', input: '', reference: '', contains: '', tags: '' }, // skipped: empty simple row
      ],
      [{ name: 'default_tool' }],
    );
    expect(items).toHaveLength(2);
    expect(items[0].tools).toEqual([{ name: 'default_tool' }]);
    expect(items[1]).toEqual(advanced); // keeps its own tools
  });
});
