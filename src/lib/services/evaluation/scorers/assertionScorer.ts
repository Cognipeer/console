/**
 * Assertion scorer — pure, deterministic checks against the target output.
 *
 * Supports: exact equals, substring inclusion/exclusion, regex match,
 * minimal JSON-schema validation, and JSON-path value/existence assertions.
 * The score is the fraction of checks that passed; with no checks present the
 * scorer does not apply to the item (skipped), rather than passing for free.
 */

import type { AssertionScorerConfig, DatasetItem, ScoreResult, TargetOutput } from '../types';
import { deepEqual, extractJson, getByPath, UnsupportedSchemaError, validateSchema } from './json';

/**
 * Dataset JSON is not type-checked: an `equals` / `mustContain` entry can arrive
 * as a number, boolean or null. Numbers and booleans are compared as their text;
 * anything else, and the empty string (which every text contains), is not a check.
 */
function checkText(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string' || value === '') return undefined;
  return value;
}

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

  const equalsText = checkText(expected.equals);
  if (equalsText !== undefined) {
    checks.push({ name: 'equals', passed: text.trim() === equalsText.trim() });
  }

  const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  for (const entry of asList(expected.mustContain)) {
    const sub = checkText(entry);
    if (sub !== undefined) checks.push({ name: `contains:${sub}`, passed: text.includes(sub) });
  }

  for (const entry of asList(expected.mustNotContain)) {
    const sub = checkText(entry);
    if (sub !== undefined) checks.push({ name: `notContains:${sub}`, passed: !text.includes(sub) });
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
      try {
        const schemaErrors = validateSchema(parsed.value, expected.jsonSchema);
        checks.push({ name: 'jsonSchema', passed: schemaErrors.length === 0, detail: schemaErrors[0] });
      } catch (err) {
        // A schema keyword this validator cannot honour must not pass (or fail) silently.
        if (err instanceof UnsupportedSchemaError) {
          return { scorerType: 'assertion', score: 0, passed: false, weight, error: `jsonSchema: ${err.message}` };
        }
        throw err;
      }
    }
  }

  for (const assertion of asList(expected.jsonPath) as NonNullable<typeof expected.jsonPath>) {
    if (!assertion || typeof assertion.path !== 'string' || assertion.path === '') continue;
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
  if (total === 0) {
    return {
      scorerType: 'assertion',
      score: 0,
      passed: false,
      weight,
      skipped: true,
      detail: { reason: 'no assertion checks configured on this item' },
    };
  }
  const passedCount = checks.filter((c) => c.passed).length;

  return {
    scorerType: 'assertion',
    score: passedCount / total,
    passed: passedCount === total,
    weight,
    detail: { total, passedCount, checks },
  };
}
