/**
 * Assertion scorer — pure, deterministic checks against the target output.
 *
 * Supports: exact equals, substring inclusion/exclusion, regex match,
 * minimal JSON-schema validation, and JSON-path value/existence assertions.
 * The score is the fraction of checks that passed; with no checks present the
 * scorer is a no-op (score 1, passed).
 */

import type { AssertionScorerConfig, DatasetItem, ScoreResult, TargetOutput } from '../types';
import { deepEqual, extractJson, getByPath, validateSchema } from './json';

interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}

export function scoreAssertion(
  item: DatasetItem,
  output: TargetOutput,
  config: AssertionScorerConfig,
): ScoreResult {
  const weight = config.weight ?? 1;
  const expected = item.expected ?? {};
  const text = output.text ?? '';
  const checks: Check[] = [];

  if (expected.equals !== undefined) {
    checks.push({ name: 'equals', passed: text.trim() === expected.equals.trim() });
  }

  for (const sub of expected.mustContain ?? []) {
    checks.push({ name: `contains:${sub}`, passed: text.includes(sub) });
  }

  for (const sub of expected.mustNotContain ?? []) {
    checks.push({ name: `notContains:${sub}`, passed: !text.includes(sub) });
  }

  if (expected.regex !== undefined) {
    try {
      checks.push({ name: 'regex', passed: new RegExp(expected.regex).test(text) });
    } catch (err) {
      checks.push({ name: 'regex', passed: false, detail: `invalid regex: ${(err as Error).message}` });
    }
  }

  if (expected.jsonSchema) {
    const parsed = extractJson(text);
    if (!parsed.ok) {
      checks.push({ name: 'jsonSchema', passed: false, detail: parsed.error });
    } else {
      const schemaErrors = validateSchema(parsed.value, expected.jsonSchema);
      checks.push({ name: 'jsonSchema', passed: schemaErrors.length === 0, detail: schemaErrors[0] });
    }
  }

  for (const assertion of expected.jsonPath ?? []) {
    const parsed = extractJson(text);
    if (!parsed.ok) {
      checks.push({ name: `jsonPath:${assertion.path}`, passed: false, detail: parsed.error });
      continue;
    }
    const lookup = getByPath(parsed.value, assertion.path);
    let passed = true;
    if (assertion.exists !== undefined) passed = passed && lookup.exists === assertion.exists;
    if (assertion.equals !== undefined) passed = passed && lookup.exists && deepEqual(lookup.value, assertion.equals);
    checks.push({ name: `jsonPath:${assertion.path}`, passed });
  }

  const total = checks.length;
  const passedCount = checks.filter((c) => c.passed).length;

  return {
    scorerType: 'assertion',
    score: total === 0 ? 1 : passedCount / total,
    passed: total === 0 ? true : passedCount === total,
    weight,
    detail: { total, passedCount, checks },
  };
}
