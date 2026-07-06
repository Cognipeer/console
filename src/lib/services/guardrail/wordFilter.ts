import type { GuardrailAction, IGuardrailWordFilterPolicy } from '@/lib/database';
import type { GuardrailFinding } from './types';
import { BUILTIN_WORD_LISTS } from './builtinWordLists';

// ── Word filter (deterministic, no LLM) ───────────────────────────────────
// Catches profanity and tenant-defined banned words that trivially bypass an
// LLM check budget: leetspeak (f#ck, s1k), diacritic stripping (amcık→amcik),
// stretched letters (fuuuck), spaced-out letters (f u c k) and mixed casing.
// Matching is whole-token against folded forms, so ordinary words that merely
// contain a banned substring ("classic", "assessment") do not fire.
//
// Word sources, merged at evaluation time:
//  1. Built-in lists (./builtinWordLists.ts), toggled via policy.builtinLists
//  2. Tenant-uploaded word lists (guardrail_word_lists), referenced via
//     policy.customListKeys and resolved by the caller into `extraWords`
//  3. Inline policy.words / policy.regexes

/** A tenant-provided word source resolved by the caller (e.g. an uploaded CSV list). */
export interface ResolvedWordList {
  key: string;
  words: string[];
}

// ── Normalization ─────────────────────────────────────────────────────────

const TR_FOLD: Record<string, string> = {
  ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
};

const LEET_FOLD: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
  '@': 'a', '$': 's', '!': 'i', '€': 'e', '+': 't', '*': '',
};

/** Lowercase, strip combining marks, fold Turkish characters. */
function foldChars(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[çğıöşü]/g, (ch) => TR_FOLD[ch] ?? ch);
}

/** Applies leet substitutions only when the token is letter-dominant, so "51k" stays numeric but "s1k" folds. */
function foldLeet(token: string): string {
  const letters = (token.match(/[a-z]/g) ?? []).length;
  if (letters * 2 < token.length) return token;
  return token.replace(/[0134578@$!€+*]/g, (ch) => LEET_FOLD[ch] ?? ch);
}

/** "fuuuck" → "fuck". Applied to both candidates and list entries. */
function collapseRepeats(token: string): string {
  return token.replace(/(.)\1+/g, '$1');
}

function stripNonLetters(token: string): string {
  return token.replace(/[^a-z]/g, '');
}

interface Candidate {
  /** Folded, compacted form used for matching. */
  folded: string;
  /** Unfolded lowercase form (for raw-only entries). */
  raw: string;
  /** Original surface text (for redaction). */
  original: string;
}

/**
 * Produces match candidates: each whitespace token (punctuation-trimmed,
 * leet-folded, letters-only) plus joined runs of single-character tokens so
 * "f u c k" and "a m k" are seen as one word.
 */
function buildCandidates(text: string): Candidate[] {
  const folded = foldChars(text);
  const rawTokens = text.split(/\s+/).filter(Boolean);
  const foldedTokens = folded.split(/\s+/).filter(Boolean);

  const count = Math.min(rawTokens.length, foldedTokens.length);
  // Compact each token once (leet-fold + strip non-letters); both passes reuse it.
  const compacts = foldedTokens.slice(0, count).map((t) => stripNonLetters(foldLeet(t)));

  const candidates: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const compact = compacts[i];
    if (!compact) continue;
    const original = rawTokens[i].replace(/^[.,;:!?'"()[\]{}<>«»-]+|[.,;:!?'"()[\]{}<>«»-]+$/g, '');
    candidates.push({
      folded: compact,
      raw: original.toLowerCase(),
      original: original || rawTokens[i],
    });
  }

  // Join runs of >=3 single-letter candidates ("f u c k", "a m k")
  let run: Candidate[] = [];
  const flushRun = () => {
    if (run.length >= 3) {
      candidates.push({
        folded: run.map((c) => c.folded).join(''),
        raw: run.map((c) => c.raw).join(''),
        original: run.map((c) => c.original).join(' '),
      });
    }
    run = [];
  };
  for (let i = 0; i < count; i++) {
    if (compacts[i].length === 1) {
      run.push({ folded: compacts[i], raw: compacts[i], original: rawTokens[i] });
    } else {
      flushRun();
    }
  }
  flushRun();

  return candidates;
}

// ── Matching ──────────────────────────────────────────────────────────────

interface CompiledLists {
  words: Set<string>;
  collapsedWords: Set<string>;
  rawWords: Set<string>;
  stems: string[];
}

/**
 * Built-in lists never change, so fold/collapse their whole corpus ONCE at
 * module load rather than on every request. `compileLists` then only unions
 * the selected precompiled sets and folds the (few) tenant-supplied words.
 */
const BUILTIN_COMPILED: Record<string, CompiledLists> = Object.fromEntries(
  Object.entries(BUILTIN_WORD_LISTS).map(([id, list]) => {
    const words = new Set(list.words.map((w) => stripNonLetters(foldChars(w))));
    return [
      id,
      {
        words,
        collapsedWords: new Set([...words].map(collapseRepeats)),
        rawWords: new Set(list.rawWords.map((w) => w.toLowerCase())),
        stems: list.stems,
      },
    ];
  }),
);

function compileLists(
  policy: IGuardrailWordFilterPolicy,
  extraLists?: ResolvedWordList[],
): CompiledLists {
  const compiled: CompiledLists = {
    words: new Set<string>(),
    collapsedWords: new Set<string>(),
    rawWords: new Set<string>(),
    stems: [],
  };

  const listSelection = policy.builtinLists ?? { 'profanity-en': true, 'profanity-tr': true };
  for (const [listId, enabled] of Object.entries(listSelection)) {
    if (!enabled) continue;
    const pre = BUILTIN_COMPILED[listId];
    if (!pre) continue;
    for (const w of pre.words) compiled.words.add(w);
    for (const w of pre.collapsedWords) compiled.collapsedWords.add(w);
    for (const w of pre.rawWords) compiled.rawWords.add(w);
    compiled.stems.push(...pre.stems);
  }

  // Tenant-supplied words/lists are small and dynamic — fold them per call.
  // Multi-word or symbol-only entries are matched as raw phrases only.
  const addCustom = (entry: string) => {
    const trimmed = entry.trim();
    if (!trimmed) return;
    const folded = stripNonLetters(foldChars(trimmed));
    if (folded && !trimmed.includes(' ')) {
      compiled.words.add(folded);
      compiled.collapsedWords.add(collapseRepeats(folded));
    }
    compiled.rawWords.add(trimmed.toLowerCase());
  };
  for (const custom of policy.words ?? []) addCustom(custom);
  for (const list of extraLists ?? []) for (const word of list.words) addCustom(word);

  return compiled;
}

function matchCandidate(candidate: Candidate, lists: CompiledLists): boolean {
  if (lists.words.has(candidate.folded)) return true;
  if (lists.collapsedWords.has(collapseRepeats(candidate.folded))) return true;
  if (lists.rawWords.has(candidate.raw)) return true;
  if (candidate.folded.length >= 5) {
    for (const stem of lists.stems) {
      if (candidate.folded.includes(stem)) return true;
    }
  }
  return false;
}

// ── Entry point ───────────────────────────────────────────────────────────

export function runWordFilter(
  text: string,
  policy: IGuardrailWordFilterPolicy,
  extraLists?: ResolvedWordList[],
): GuardrailFinding[] {
  if (!policy.enabled || !text.trim()) return [];

  const action = (policy.action ?? 'block') as GuardrailAction;
  const findings: GuardrailFinding[] = [];
  const seen = new Set<string>();

  const lists = compileLists(policy, extraLists);
  for (const candidate of buildCandidates(text)) {
    if (!matchCandidate(candidate, lists)) continue;
    if (seen.has(candidate.folded)) continue;
    seen.add(candidate.folded);
    findings.push({
      type: 'word_filter',
      category: 'banned_word',
      severity: 'high',
      message: 'Banned or profane word detected',
      action,
      block: action === 'block',
      value: candidate.original,
    });
  }

  // Multi-word phrases ("orospu çocuğu", "kill yourself") match on the folded
  // full text so spacing/diacritic variants are covered.
  const foldedText = foldChars(text);
  for (const phrase of lists.rawWords) {
    if (!phrase.includes(' ')) continue;
    const foldedPhrase = foldChars(phrase);
    if (foldedText.includes(foldedPhrase) && !seen.has(foldedPhrase)) {
      seen.add(foldedPhrase);
      findings.push({
        type: 'word_filter',
        category: 'banned_word',
        severity: 'high',
        message: 'Banned phrase detected',
        action,
        block: action === 'block',
        value: phrase,
      });
    }
  }

  // Tenant-defined regexes, case-insensitive; invalid patterns are skipped.
  for (const source of policy.regexes ?? []) {
    if (!source?.trim()) continue;
    let pattern: RegExp;
    try {
      pattern = new RegExp(source, 'giu');
    } catch {
      continue;
    }
    const match = pattern.exec(text);
    if (match && match[0]) {
      findings.push({
        type: 'word_filter',
        category: 'custom_pattern',
        severity: 'high',
        message: `Content matches banned pattern`,
        action,
        block: action === 'block',
        value: match[0],
      });
    }
  }

  return findings;
}
