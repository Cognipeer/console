/**
 * PKG-7a: editor / import helper behaviour — Mongo nulls in the item editor (T6),
 * JSON import keeping responseFormat + labels (T14), the mustContain delimiter (U8)
 * and label type round-tripping (U11). Pure functions, no React/DOM.
 */

import { describe, expect, it } from 'vitest';
import {
  coerceLabelValue,
  draftToItem,
  itemToDraft,
  summarizeItem,
} from '@/components/evaluations/datasetItemHelpers';
import { parseJsonItems, rowsToItems } from '@/components/evaluations/datasetImport';
import type { EvalDatasetItemView } from '@/components/evaluations/types';

describe('itemToDraft with Mongo nulls (T6)', () => {
  const item = {
    id: 'a',
    input: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'lookup', description: null, parameters: null }],
    expected: { reference: 'x', jsonSchema: null },
    tags: ['t'],
    extraNull: null,
  } as unknown as EvalDatasetItemView;

  it('treats null tool parameters and jsonSchema as absent', () => {
    const draft = itemToDraft(item);
    expect(draft.tools[0].parametersText).toBe('');
    expect(draft.tools[0].description).toBe('');
    expect(draft.jsonSchemaText).toBe('');
    expect(draft.extraItem).not.toHaveProperty('extraNull');
  });

  it('saves without a tools-parameters error', () => {
    const result = draftToItem(itemToDraft(item));
    expect(result.errors).toEqual([]);
    expect(result.item?.tools).toEqual([{ name: 'lookup' }]);
    expect(summarizeItem(item).hasAssertions).toBe(false);
  });
});

describe('parseJsonItems (T14)', () => {
  it('keeps responseFormat and labels', () => {
    const responseFormat = { type: 'json_schema', json_schema: { name: 'o', schema: { type: 'object' } } };
    const out = parseJsonItems(
      JSON.stringify([{ id: 'q', input: [{ role: 'user', content: 'x' }], responseFormat, labels: { intent: 'billing', n: 3 } }]),
    );
    if ('error' in out) throw new Error(out.error);
    const first = out.items[0] as EvalDatasetItemView & { responseFormat?: unknown };
    expect(first.responseFormat).toEqual(responseFormat);
    expect(first.labels).toEqual({ intent: 'billing', n: 3 });
  });

  it('rejects a non-object responseFormat or labels', () => {
    const bad = parseJsonItems(JSON.stringify([{ input: [], responseFormat: 'json' }]));
    expect(bad).toEqual({ error: 'Item 0: "responseFormat" must be an object' });
    const badLabels = parseJsonItems(JSON.stringify([{ input: [], labels: ['a'] }]));
    expect(badLabels).toEqual({ error: 'Item 0: "labels" must be an object' });
  });

  it('leaves them off when absent', () => {
    const out = parseJsonItems(JSON.stringify([{ input: [{ role: 'user', content: 'x' }] }]));
    if ('error' in out) throw new Error(out.error);
    expect(out.items[0]).not.toHaveProperty('responseFormat');
    expect(out.items[0]).not.toHaveProperty('labels');
  });
});

describe('mustContain delimiter (U8)', () => {
  it('does not split on commas', () => {
    const [item] = rowsToItems([{ question: 'Capital?', contains: 'Paris, France' }]);
    expect(item.expected?.mustContain).toEqual(['Paris, France']);
  });

  it('still splits on | and ;', () => {
    const [item] = rowsToItems([{ question: 'q', contains: 'red|blue; green' }]);
    expect(item.expected?.mustContain).toEqual(['red', 'blue', 'green']);
  });
});

describe('coerceLabelValue (U11)', () => {
  it('keeps an unchanged value exactly as stored', () => {
    expect(coerceLabelValue('3', undefined, 3)).toBe(3);
    expect(coerceLabelValue('true', undefined, true)).toBe(true);
    expect(coerceLabelValue('a,b', undefined, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('coerces by the definition field type', () => {
    expect(coerceLabelValue('4', 'number', undefined)).toBe(4);
    expect(coerceLabelValue('2.5', 'score', '1')).toBe(2.5);
    expect(coerceLabelValue('false', 'boolean', undefined)).toBe(false);
  });

  it('falls back to the stored value type without a definition', () => {
    expect(coerceLabelValue('7', undefined, 3)).toBe(7);
    expect(coerceLabelValue('false', undefined, true)).toBe(false);
  });

  it('keeps text that does not fit the type as a string', () => {
    expect(coerceLabelValue('n/a', 'number', 3)).toBe('n/a');
    expect(coerceLabelValue(' billing ', 'enum', 'sales')).toBe('billing');
    expect(coerceLabelValue('3', 'string', undefined)).toBe('3');
  });
});
