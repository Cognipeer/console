import { describe, it, expect } from 'vitest';
import { diffShape, scoreJsonShape } from '@/lib/services/evaluation/scorers/jsonShapeScorer';
import type { DatasetItem, TargetOutput } from '@/lib/services/evaluation/types';

/** The real regression: a full agent envelope vs a reply that kept only `message`. */
const FULL_ENVELOPE = JSON.stringify({
  reply: true,
  message: 'Claude bağlantı testi başarıyla tamamlandı.',
  pinMessage: false,
  suggestedReplies: [],
  dispatched: [],
  topicKey: 'agent-guvenligi',
  topicName: 'Ajan güvenliği',
});
const MESSAGE_ONLY = JSON.stringify({ message: 'Claude bağlantı testi başarılı.' });

function item(reference?: string): DatasetItem {
  return { id: 'i1', input: [{ role: 'user', content: 'q' }], expected: reference ? { reference } : undefined };
}
function out(text: string): TargetOutput {
  return { text };
}

describe('diffShape', () => {
  it('lists every key the output failed to produce', () => {
    const diff = diffShape(JSON.parse(FULL_ENVELOPE), JSON.parse(MESSAGE_ONLY));
    expect(diff.missingKeys).toEqual(
      expect.arrayContaining(['reply', 'pinMessage', 'suggestedReplies', 'dispatched', 'topicKey', 'topicName']),
    );
    expect(diff.missingKeys).not.toContain('message');
  });

  it('flags a type mismatch rather than calling the key present', () => {
    const diff = diffShape({ reply: true }, { reply: 'yes' });
    expect(diff.typeMismatches).toEqual([{ path: 'reply', expected: 'boolean', got: 'string' }]);
  });

  it('reports extra keys without counting them as failures', () => {
    const diff = diffShape({ a: 1 }, { a: 1, b: 2 });
    expect(diff.extraKeys).toEqual(['b']);
    expect(diff.missingKeys).toEqual([]);
  });

  it('recurses into nested objects with dotted paths', () => {
    const diff = diffShape({ meta: { id: 1, tag: 'x' } }, { meta: { id: 2 } });
    expect(diff.missingKeys).toEqual(['meta.tag']);
  });

  it('compares arrays by element shape, not by length', () => {
    const diff = diffShape({ items: [{ id: 1, name: 'a' }] }, { items: [{ id: 2, name: 'b' }, { id: 3, name: 'c' }] });
    expect(diff.missingKeys).toEqual([]);
    expect(diff.typeMismatches).toEqual([]);
  });

  it('finds a missing key inside array elements', () => {
    const diff = diffShape({ items: [{ id: 1, name: 'a' }] }, { items: [{ id: 2 }] });
    expect(diff.missingKeys).toEqual(['items[].name']);
  });

  it('does not infer a type from a null reference value', () => {
    expect(diffShape({ x: null }, { x: 'anything' }).typeMismatches).toEqual([]);
  });
});

describe('scoreJsonShape', () => {
  it('FAILS the envelope-vs-message-only case that similarity scoring passes', () => {
    const result = scoreJsonShape(item(FULL_ENVELOPE), out(MESSAGE_ONLY), { type: 'json-shape' });
    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(1);
    expect(String(result.detail?.reasoning)).toContain('topicKey');
  });

  it('passes an output with the same shape but different content', () => {
    const sameShape = JSON.stringify({
      reply: false, message: 'something else entirely', pinMessage: true,
      suggestedReplies: ['a'], dispatched: [], topicKey: 'other', topicName: 'Other',
    });
    const result = scoreJsonShape(item(FULL_ENVELOPE), out(sameShape), { type: 'json-shape' });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('fails when the output is prose but JSON was expected', () => {
    const result = scoreJsonShape(item(FULL_ENVELOPE), out('Test başarılı oldu.'), { type: 'json-shape' });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(String(result.detail?.reason)).toContain('unparseable');
  });

  it('tolerates a fenced code block around the JSON', () => {
    const result = scoreJsonShape(item(FULL_ENVELOPE), out('```json\n' + FULL_ENVELOPE + '\n```'), { type: 'json-shape' });
    expect(result.passed).toBe(true);
  });

  it('skips items whose reference is prose — mixed datasets stay usable', () => {
    const result = scoreJsonShape(item('just a sentence'), out('another sentence'), { type: 'json-shape' });
    expect(result.passed).toBe(true);
    expect(result.detail?.skipped).toBe('reference is not JSON');
  });

  it('skips items with no reference at all', () => {
    const result = scoreJsonShape(item(), out('{}'), { type: 'json-shape' });
    expect(result.passed).toBe(true);
    expect(result.detail?.skipped).toBe('no reference output');
  });

  it('scores partial conformance proportionally', () => {
    // 2 of 4 keys arrive.
    const result = scoreJsonShape(
      item(JSON.stringify({ a: 1, b: 2, c: 3, d: 4 })),
      out(JSON.stringify({ a: 9, b: 8 })),
      { type: 'json-shape' },
    );
    expect(result.score).toBeCloseTo(0.5);
  });

  it('honours a relaxed threshold', () => {
    const result = scoreJsonShape(
      item(JSON.stringify({ a: 1, b: 2, c: 3, d: 4 })),
      out(JSON.stringify({ a: 9, b: 8, c: 7 })),
      { type: 'json-shape', threshold: 0.7 },
    );
    expect(result.score).toBeCloseTo(0.75);
    expect(result.passed).toBe(true);
  });
});
