import type { GuardrailFinding } from './types';

/**
 * Masks each finding's matched value in the text, labelling the mask with the
 * finding's category (`[REDACTED:email]`, `[REDACTED:banned_word]`, …). Works
 * for any finding type that carries a `value` — PII, word filter, etc. Longer
 * values are replaced first so overlapping matches (e.g. a URL containing an
 * email) don't leave fragments behind.
 *
 * NOT deprecated, and deliberately NOT reimplemented on top of `applyMutations`
 * — the two answer different questions and only one of them is right here.
 * `applyMutations` is span-addressed and scopes a value rewrite to the ONE
 * segment the finding came from, which is exactly what enforcement wants: it
 * must not touch occurrences the finding was never about. This function is the
 * LOG-MASKING path (hooks/engine.ts's `maskTextForLogging`), where the opposite
 * rule holds — every occurrence of a detected value must disappear before the
 * text is persisted, including the ones no finding pointed at, because a single
 * surviving copy defeats the whole point of masking. It also has to work on
 * bare `GuardrailFinding`s that carry no `path` and no `span` at all, which is
 * what a legacy finding and an LLM-family finding both are.
 *
 * Enforcement rewrites go through `applyMutations`; this stays the redactor of
 * record for anything that is about to be written to a log row.
 */
export function redactFindings(text: string, findings: GuardrailFinding[]): string {
  const values = [...new Set(findings.map((f) => f.value).filter((v): v is string => Boolean(v)))]
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const value of values) {
    const finding = findings.find((f) => f.value === value);
    result = result.split(value).join(`[REDACTED:${finding?.category ?? 'pii'}]`);
  }
  return result;
}
