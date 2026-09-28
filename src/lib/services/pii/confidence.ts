/**
 * Confidence primitives shared by every detector layer (pattern, dictionary,
 * NER). Pure functions — no I/O, no knowledge of `PiiFinding`'s shape. The
 * actual candidate → finding fusion lives in `detector.ts`, next to the mask/
 * replacement builders it needs.
 */

import type { PiiSeverity } from './categories';

/** One detector layer's opinion about one span. Not yet a `PiiFinding` —
 *  multiple candidates for the same span (agreeing or competing) are merged
 *  into a finding by `detector.ts`'s `fuseCandidates`. */
export interface Candidate {
  category: string;
  start: number;
  end: number;
  value: string;
  /** This layer's own confidence for this span, before any context boost. */
  baseScore: number;
  detector: 'pattern' | 'dictionary' | 'ner';
  severity: PiiSeverity;
  label: string;
  /** Short human-readable reasons this candidate was raised (context words matched, sequence pattern, checksum), surfaced on the finding for the test panel / audit trail. */
  evidence: string[];
}

const CONTEXT_WINDOW = 60;

/**
 * Case-fold for content whose LANGUAGE IS NOT KNOWN (a scanned window that
 * could be Turkish, English, or mixed; a tenant's own custom phrase list).
 *
 * NOT the same as `dictionary.ts`'s `fold` (`toLocaleLowerCase('tr')`), and
 * this distinction is load-bearing, not stylistic — the two halves of the
 * "Turkish I problem" pull in opposite directions and there is no single
 * fold that gets both right without knowing the text's language:
 *   - `'NINE'.toLocaleLowerCase('tr')` → "nıne" (dotless ı) — WRONG for
 *     English/ASCII content, which this function must also handle.
 *   - `'İstanbul'.toLowerCase()` (locale-independent) → "i̇stanbul" — an
 *     extra U+0307 COMBINING DOT ABOVE codepoint, which breaks a plain
 *     substring match against "istanbul" even though a person reads them
 *     as identical.
 * The fix below is not a locale choice at all: replace 'İ' (U+0130) with
 * plain 'i' BEFORE the locale-independent lowercase, so a dotted capital
 * folds correctly (no combining mark) and a plain ASCII 'I' folds the
 * English way (favoring general/cross-language content, which is what
 * `dictionary.ts`'s dedicated TR fold exists to handle instead).
 */
export function foldGeneral(s: string): string {
  return s.replace(/İ/g, 'i').toLowerCase();
}

/**
 * Case-insensitive substring search for any of `words` within
 * `CONTEXT_WINDOW` characters either side of `[start, end)`. Returns the
 * first matching word (for the evidence trail) or null.
 *
 * Deliberately a plain substring test, not a word-boundary regex: context
 * words here are short, mostly-unambiguous phrases ("vergi no", "e-posta")
 * where a mid-word false hit is vanishingly unlikely to matter, and a plain
 * `includes` is exactly what a fixed ±N-character window calls for — no
 * regex compilation per call, no catastrophic-backtracking surface.
 */
export function findContextWord(
  text: string,
  start: number,
  end: number,
  words: string[] | undefined,
): string | null {
  if (!words || words.length === 0) return null;
  const from = Math.max(0, start - CONTEXT_WINDOW);
  const to = Math.min(text.length, end + CONTEXT_WINDOW);
  const window = foldGeneral(text.slice(from, to));
  for (const word of words) {
    if (window.includes(foldGeneral(word))) return word;
  }
  return null;
}

/** Apply the fixed context boost, capped so a finding is never reported as absolutely certain. */
export function applyContextBoost(base: number, matched: boolean): number {
  if (!matched) return base;
  return Math.min(0.99, base + 0.35);
}

/**
 * Combine N independent detectors' opinions of the SAME thing:
 * `1 - Π(1 - c_i)`. Two weak-but-independent signals (e.g. a 0.4 dictionary
 * hit and a 0.5 NER hit on the same span) compound into a stronger one
 * (`1 - 0.6*0.5 = 0.7`) without either alone clearing a 0.5 threshold.
 */
export function noisyOr(scores: number[]): number {
  if (scores.length === 0) return 0;
  let survival = 1;
  for (const raw of scores) {
    const s = Math.min(0.999, Math.max(0, raw));
    survival *= 1 - s;
  }
  return 1 - survival;
}
