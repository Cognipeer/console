/**
 * Non-LLM moderation detector — `policy.detector: 'lexicon'`.
 *
 * Reuses `scanWordFilter`'s matcher (folding, leetspeak, stretched/spaced
 * letters, custom lists — see `wordFilter.ts`) UNCHANGED, once per enabled
 * moderation category, against the category-scoped lexicons in
 * `moderationWordLists.ts`. See that file's header for exactly which
 * categories have built-in coverage and why the rest (`hate`, `harassment`,
 * `sexual`, `sexual/minors`, `misinformation`) do not.
 *
 * WHAT THIS IS FOR: a `runIf`-style pre-filter (see `families/llm.ts`'s own
 * header on that pattern) or a zero-cost/zero-latency detector for tenants
 * who accept lower recall on figurative, coded, or novel phrasing in
 * exchange for no LLM call. It is NOT a claim of parity with the LLM judge —
 * a keyword hit has no notion of INTENT, so "I want to kill this bug in my
 * code" and "I want to kill him" score identically on the word "kill". Set
 * expectations with `minConfidence`-equivalent judgement: this is a coarse,
 * high-recall / lower-precision signal, same trade-off as the PII v2
 * dictionary pass.
 *
 * `child_safety` is the one category with a STRUCTURAL (not lexicon)
 * detector below — no slur/explicit-term list needed, see
 * `detectChildSafetySignal`'s own doc comment.
 */

import type { GuardrailAction, IGuardrailModerationPolicy } from '@/lib/database/provider/types.domain';
import type { GuardrailFinding } from './types';
import { scanWordFilter } from './wordFilter';
import type { ResolvedWordList } from './wordFilter';

/** Moderation category id → the built-in lexicon backing it. Categories absent here have NO built-in coverage — see this file's header and `moderationWordLists.ts`'s. */
const CATEGORY_LIST_ID: Partial<Record<string, string>> = {
  'self-harm': 'moderation-self-harm',
  'self-harm/intent': 'moderation-self-harm',
  'self-harm/instructions': 'moderation-self-harm-instructions',
  violence: 'moderation-violence',
  'violence/graphic': 'moderation-violence-graphic',
  weapons: 'moderation-weapons',
  drugs: 'moderation-drugs',
  cybercrime: 'moderation-cybercrime',
  fraud: 'moderation-fraud',
  terrorism: 'moderation-terrorism',
  illicit: 'moderation-illicit',
  // Shares the violence lexicon rather than duplicating it — "illicit and
  // violent" is, in this seed list, the same vocabulary as plain violence.
  'illicit/violent': 'moderation-violence',
};

export interface LexiconModerationOptions {
  /**
   * Tenant-curated word lists (the EXISTING `guardrail_word_lists` feature,
   * resolved by the caller via `wordListService#resolveCustomWordLists`)
   * mapped onto a moderation category id. This is how `hate`, `harassment`,
   * `sexual`, `sexual/minors` — and any built-in category a tenant wants to
   * extend — get real lexicon coverage without this file hand-authoring a
   * slur/explicit-term list.
   */
  customListsByCategory?: Record<string, ResolvedWordList[]>;
}

/**
 * Runs the lexicon pass. Returns one `GuardrailFinding` per matched
 * word/phrase per category — same finding shape `runModerationPolicy` (the
 * LLM path) produces, so a caller can treat the two interchangeably.
 */
export function runLexiconModerationPolicy(
  text: string,
  policy: IGuardrailModerationPolicy,
  globalAction: GuardrailAction,
  options?: LexiconModerationOptions,
): GuardrailFinding[] {
  if (!policy.enabled || !text.trim()) return [];

  const enabledCategories = Object.entries(policy.categories || {})
    .filter(([, on]) => on)
    .map(([id]) => id);
  if (enabledCategories.length === 0) return [];

  const findings: GuardrailFinding[] = [];
  for (const categoryId of enabledCategories) {
    const builtinListId = CATEGORY_LIST_ID[categoryId];
    const customLists = options?.customListsByCategory?.[categoryId] ?? [];
    if (!builtinListId && customLists.length === 0) continue; // no lexicon for this category — see file header

    const scan = scanWordFilter(
      text,
      { enabled: true, action: globalAction, builtinLists: builtinListId ? { [builtinListId]: true } : {} },
      customLists,
    );
    for (const f of scan.findings) {
      findings.push({
        ...f,
        type: 'moderation',
        category: categoryId,
        message: `Lexicon match for "${categoryId}"${f.value ? `: "${f.value}"` : ''}`,
      });
    }
  }

  if (enabledCategories.includes('child_safety')) {
    findings.push(...detectChildSafetySignal(text, globalAction));
  }

  return findings;
}

// ── child_safety — structural, no lexicon needed ──────────────────────────

/** Ages a "minor" reference can plausibly name — deliberately excludes 18+. */
const MINOR_AGE_RE = /\b(?:[6-9]|1[0-7])\s*(?:yaşında|yaşındayım|yaş(?:ında)?|years?[\s-]?old|y\/?o)\b/gi;

/**
 * Grooming-pattern phrases: secrecy requests, meet-alone requests, media
 * requests — the STRUCTURE groomers use to build toward exploitation, not
 * explicit sexual vocabulary. Deliberately phrase-level (EN+TR), not slurs,
 * so this needs no curated hate/sexual term list at all.
 */
const GROOMING_PHRASES = [
  "our secret", "don't tell your parents", "don't tell anyone", 'keep this between us',
  'send me a pic', 'send me pics', 'send a picture of yourself', 'meet me alone', 'come to my place alone',
  'kimseye söyleme', 'ailene söyleme', 'aramızda kalsın', 'aramızda sır olsun',
  'fotoğrafını gönder', 'yalnız buluşalım', 'yalnız gel',
];

/**
 * `child_safety` needs BOTH a minor-age reference AND a grooming-pattern
 * phrase present in the SAME text — either signal alone is far too common
 * (a birthday message; a normal "keep this between us" in an unrelated
 * context) to raise a finding this severe on its own. Requiring both is a
 * precision choice: it will miss a grooming attempt that never states an
 * age, but a bare age mention or a bare secrecy request alone is not
 * evidence of anything.
 */
export function detectChildSafetySignal(text: string, globalAction: GuardrailAction): GuardrailFinding[] {
  const folded = text.toLowerCase();
  const hasAgeSignal = MINOR_AGE_RE.test(text);
  MINOR_AGE_RE.lastIndex = 0; // stateful /g regex — reset for the next call
  if (!hasAgeSignal) return [];

  const matchedPhrase = GROOMING_PHRASES.find((p) => folded.includes(p));
  if (!matchedPhrase) return [];

  return [{
    type: 'moderation',
    category: 'child_safety',
    severity: 'high',
    message: `Structural child-safety signal: a minor-age reference co-occurs with a grooming-pattern phrase ("${matchedPhrase}")`,
    action: globalAction,
    block: true, // always escalates to block regardless of the record's configured action — see families/llm.ts's own G1-style escalation precedent for `redact` verdicts
  }];
}
