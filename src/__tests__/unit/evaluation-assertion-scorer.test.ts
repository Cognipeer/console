/**
 * Unit tests — evaluation assertion scorer.
 * Covers equals, contains/notContains, regex, json-schema, json-path, and the
 * no-assertion no-op case.
 */

import { describe, it, expect } from 'vitest';
import { scoreAssertion } from '@/lib/services/evaluation/scorers/assertionScorer';
import type { AssertionScorerConfig, DatasetItem, TargetOutput } from '@/lib/services/evaluation/types';

const CONFIG: AssertionScorerConfig = { type: 'assertion' };

function item(expected: DatasetItem['expected']): DatasetItem {
  return { id: 'i1', input: [{ role: 'user', content: 'hi' }], expected };
}
function out(text: string): TargetOutput {
  return { text };
}

describe('assertionScorer', () => {
  it('treats absence of expectations as a passing no-op', () => {
    const r = scoreAssertion(item(undefined), out('anything'), CONFIG);
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.detail?.total).toBe(0);
  });

  it('passes exact equals (trimmed) and fails otherwise', () => {
    expect(scoreAssertion(item({ equals: 'yes' }), out('  yes \n'), CONFIG).passed).toBe(true);
    expect(scoreAssertion(item({ equals: 'yes' }), out('no'), CONFIG).passed).toBe(false);
  });

  it('handles mustContain / mustNotContain', () => {
    const r = scoreAssertion(item({ mustContain: ['foo', 'bar'], mustNotContain: ['baz'] }), out('foo and bar'), CONFIG);
    expect(r.passed).toBe(true);
    const r2 = scoreAssertion(item({ mustContain: ['foo'], mustNotContain: ['bar'] }), out('foo bar'), CONFIG);
    expect(r2.passed).toBe(false);
  });

  it('computes a partial score from the fraction of checks passed', () => {
    const r = scoreAssertion(item({ mustContain: ['a', 'b', 'c', 'd'] }), out('a b'), CONFIG);
    expect(r.score).toBeCloseTo(0.5, 5);
    expect(r.passed).toBe(false);
  });

  it('evaluates regex and reports invalid patterns as failed', () => {
    expect(scoreAssertion(item({ regex: '^\\d{3}$' }), out('123'), CONFIG).passed).toBe(true);
    expect(scoreAssertion(item({ regex: '(' }), out('123'), CONFIG).passed).toBe(false);
  });

  it('validates a minimal JSON schema against parsed output', () => {
    const schema = { type: 'object' as const, required: ['name', 'age'], properties: { name: { type: 'string' as const }, age: { type: 'integer' as const } } };
    expect(scoreAssertion(item({ jsonSchema: schema }), out('{"name":"x","age":3}'), CONFIG).passed).toBe(true);
    expect(scoreAssertion(item({ jsonSchema: schema }), out('{"name":"x","age":"old"}'), CONFIG).passed).toBe(false);
    expect(scoreAssertion(item({ jsonSchema: schema }), out('not json'), CONFIG).passed).toBe(false);
  });

  it('extracts JSON from fenced / chatty output for schema checks', () => {
    const schema = { type: 'object' as const, required: ['ok'] };
    const text = 'Sure! Here you go:\n```json\n{"ok": true}\n```';
    expect(scoreAssertion(item({ jsonSchema: schema }), out(text), CONFIG).passed).toBe(true);
  });

  it('evaluates json-path existence and equality', () => {
    const text = '{"data":{"items":[{"name":"alpha"}]}}';
    const r = scoreAssertion(
      item({ jsonPath: [{ path: 'data.items[0].name', equals: 'alpha' }, { path: 'data.missing', exists: false }] }),
      out(text),
      CONFIG,
    );
    expect(r.passed).toBe(true);
    const r2 = scoreAssertion(item({ jsonPath: [{ path: 'data.items[0].name', equals: 'beta' }] }), out(text), CONFIG);
    expect(r2.passed).toBe(false);
  });

  it('respects the configured weight', () => {
    const r = scoreAssertion(item({ equals: 'x' }), out('x'), { type: 'assertion', weight: 3 });
    expect(r.weight).toBe(3);
  });
});
