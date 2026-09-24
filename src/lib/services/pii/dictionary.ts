/**
 * L2 — the dictionary / gazetteer pass.
 *
 * Produces `person` / `organization` / `location` candidates for text the
 * regex layer (L1) cannot see at all: a name, a company, a district has no
 * fixed shape a pattern can anchor on. See
 * `internal-notes/pii-v2-nlp-ve-asset-registry-plani.md` §1 "L2 - Sözlük /
 * gazetteer" for the design this implements.
 *
 * ── WHY SEGMENT+SET, NOT A FLAT AHO-CORASICK SCAN OVER THE GAZETTEER ───────
 * The plan sketch called for running the built-in name/place lists through
 * the same Aho-Corasick automaton as everything else. Building this module
 * surfaced two reasons that's the wrong tool for THIS list, even though
 * `ahoCorasick.ts` (used below, for custom phrases) is exactly right for a
 * large uncontrolled phrase set:
 *
 *   1. Word-boundary correctness. A flat scan over raw casefolded text
 *      matches "can" inside "Canada" as readily as the word "Can". Turkish
 *      possessive/case suffixes compound this: `Intl.Segmenter` sometimes
 *      folds a suffix into its word ("Yılmaz'ın" is ONE segment) and
 *      sometimes doesn't ("12'de" segments as "12", "'", "de") — there is no
 *      single delimiter-joining scheme that survives both without either
 *      false-splitting names or false-merging unrelated tokens. Iterating
 *      `Intl.Segmenter`'s own word-like segments and doing an O(1) Set
 *      lookup per segment sidesteps the whole problem: the segmenter, not a
 *      hand-rolled boundary rule, decides what a "word" is.
 *   2. The interesting logic isn't the lookup. Whether "Ahmet Yılmaz" is a
 *      person is a SEQUENCE question (title? first name? surname? in what
 *      order, how far apart) that needs segment-level adjacency reasoning
 *      regardless of how the individual-word lookup is implemented. A flat
 *      substring automaton returns "these bytes matched a pattern" and none
 *      of that grammar — so it doesn't remove the sequence code, only adds a
 *      second matching path alongside it.
 *
 * Aho-Corasick genuinely IS the right structure for `customPhrases` below —
 * an arbitrary, potentially-large (tenant word lists cap at 20,000 entries),
 * uncontrolled-length phrase list where segment alignment can't be assumed —
 * so it is used there, single automaton, one pass over the text.
 */

import type { PiiLanguage } from '@/lib/database';
import { type Candidate, foldGeneral } from './confidence';
import { AhoCorasick, isWordBoundaryMatch, resolveAcOverlaps } from './ahoCorasick';
import {
  TR_PROVINCES,
  TR_DISTRICTS_SEED,
  TR_FIRST_NAMES,
  TR_SURNAMES,
  TR_TITLES,
  TR_NAME_SUFFIX_TITLES,
  TR_ORG_SUFFIXES,
  TR_NAME_SUFFIXES,
} from './data/trGazetteer';

// ── Gazetteer sets (built once at module load) ─────────────────────────────

const fold = (s: string): string => s.toLocaleLowerCase('tr');

function toSet(list: string[]): Set<string> {
  return new Set(list.map(fold));
}

const FIRST_NAMES = toSet(TR_FIRST_NAMES);
const SURNAMES = toSet(TR_SURNAMES);
const PROVINCES = toSet(TR_PROVINCES);
const DISTRICTS = toSet(TR_DISTRICTS_SEED);
// Titles/org-suffixes may be multi-word ("Prof. Dr.", "Ltd. Şti.") AND
// `Intl.Segmenter` sometimes puts a trailing "." in its OWN non-word-like
// segment instead of folding it into the word before it (verified: "A.Ş."
// segments as "A.Ş" + "." — two segments, not one "A.Ş." token) — so a
// segment's raw text alone never carries its trailing dot. Stripping
// trailing dots on BOTH sides (the seed list here, and every lookup key
// built from a segment) is what makes those line up regardless of which
// side the segmenter happened to keep the period on.
const normalizeMultiWord = (s: string): string => fold(s).replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
const TITLES = new Set(TR_TITLES.map(normalizeMultiWord));
const SUFFIX_TITLES = toSet(TR_NAME_SUFFIX_TITLES);
const ORG_SUFFIXES = new Set(TR_ORG_SUFFIXES.map(normalizeMultiWord));

// Longest-first so "'nin" is tried before "'in" would wrongly match its tail.
const SORTED_SUFFIXES = [...TR_NAME_SUFFIXES].sort((a, b) => b.length - a.length);

/** Strip a trailing Turkish possessive/case suffix, apostrophe form only (see module header: bare-suffix stripping is too ambiguous to attempt safely with a seed-sized dictionary). */
function stripSuffix(word: string): string {
  for (const suf of SORTED_SUFFIXES) {
    if (!suf.startsWith("'")) continue;
    if (word.length > suf.length && word.endsWith(suf)) {
      return word.slice(0, -suf.length);
    }
  }
  return word;
}

function isCapitalized(s: string): boolean {
  return /^\p{Lu}/u.test(s);
}

interface WordSeg {
  text: string;
  start: number;
  end: number;
  /** Lookup key: lowercased, apostrophe-suffix stripped. */
  key: string;
  capitalized: boolean;
}

function segmentWords(text: string): WordSeg[] {
  const segmenter = new Intl.Segmenter('tr', { granularity: 'word' });
  const out: WordSeg[] = [];
  for (const s of segmenter.segment(text)) {
    if (!s.isWordLike) continue;
    // Digit-only "words" (dates, amounts) can never be a name/place/org hit.
    if (/^\d+$/.test(s.segment)) continue;
    out.push({
      text: s.segment,
      start: s.index,
      end: s.index + s.segment.length,
      key: stripSuffix(fold(s.segment)),
      capitalized: isCapitalized(s.segment),
    });
  }
  return out;
}

/** Two word segments are "adjacent" for sequence matching if only whitespace separates them in the original text — a comma or newline between them means two different mentions, not one entity. */
function adjacent(text: string, a: WordSeg, b: WordSeg): boolean {
  return /^\s*$/.test(text.slice(a.end, b.start));
}

const EV = (s: string): string[] => [s];

/**
 * Sweep the word stream left-to-right, greedily matching the longest known
 * sequence starting at each position: title+first+surname > title+first >
 * first+surname > first+suffixTitle > lone first/surname; similarly for
 * organizations (1-3 capitalized words + a legal-entity suffix) and
 * locations (province/district, optionally paired).
 */
function scanPersonsAndOrgs(text: string, words: WordSeg[]): Candidate[] {
  const out: Candidate[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const isTitle = TITLES.has(w.key) || TITLES.has(normalizeMultiWord(w.text));
    const isFirst = FIRST_NAMES.has(w.key);
    const isSurname = SURNAMES.has(w.key);

    // title (+ first (+ surname))
    if (isTitle) {
      const n1 = words[i + 1];
      if (n1 && adjacent(text, w, n1) && FIRST_NAMES.has(n1.key)) {
        const n2 = words[i + 2];
        if (n2 && adjacent(text, n1, n2) && SURNAMES.has(n2.key)) {
          out.push({
            category: 'person', start: w.start, end: n2.end, value: text.slice(w.start, n2.end),
            baseScore: 0.92, detector: 'dictionary', severity: 'high', label: 'Person name',
            evidence: EV(`title "${w.text}" + first name + surname`),
          });
          i += 3; continue;
        }
        out.push({
          category: 'person', start: w.start, end: n1.end, value: text.slice(w.start, n1.end),
          baseScore: 0.85, detector: 'dictionary', severity: 'high', label: 'Person name',
          evidence: EV(`title "${w.text}" + first name`),
        });
        i += 2; continue;
      }
    }

    // first + surname (+ suffix title, e.g. "Ahmet Yılmaz Bey")
    if (isFirst) {
      const n1 = words[i + 1];
      if (n1 && adjacent(text, w, n1) && SURNAMES.has(n1.key)) {
        const n2 = words[i + 2];
        if (n2 && adjacent(text, n1, n2) && SUFFIX_TITLES.has(n2.key)) {
          out.push({
            category: 'person', start: w.start, end: n2.end, value: text.slice(w.start, n2.end),
            baseScore: 0.9, detector: 'dictionary', severity: 'high', label: 'Person name',
            evidence: EV(`first name + surname + "${n2.text}"`),
          });
          i += 3; continue;
        }
        out.push({
          category: 'person', start: w.start, end: n1.end, value: text.slice(w.start, n1.end),
          baseScore: 0.78, detector: 'dictionary', severity: 'high', label: 'Person name',
          evidence: EV('first name + surname'),
        });
        i += 2; continue;
      }
      if (n1 && adjacent(text, w, n1) && SUFFIX_TITLES.has(n1.key)) {
        out.push({
          category: 'person', start: w.start, end: n1.end, value: text.slice(w.start, n1.end),
          baseScore: 0.8, detector: 'dictionary', severity: 'high', label: 'Person name',
          evidence: EV(`first name + "${n1.text}"`),
        });
        i += 2; continue;
      }
    }

    // organization: 1-3 capitalized words immediately before a legal-entity suffix
    if (w.capitalized) {
      let j = i;
      const run: WordSeg[] = [w];
      while (run.length < 3 && words[j + 1] && words[j + 1].capitalized && adjacent(text, words[j], words[j + 1])) {
        // A capitalized word that is ITSELF a known suffix ("A.Ş", "Ltd")
        // must not be swallowed into the generic run — stop here so it
        // stays available as `suffixCandidate` below. Without this check,
        // "Cognipeer Teknoloji A.Ş." greedily absorbs "A.Ş" as a 3rd
        // "company name word" and there is no suffix left to find.
        if (ORG_SUFFIXES.has(normalizeMultiWord(words[j + 1].text))) break;
        j += 1;
        run.push(words[j]);
      }
      const suffixCandidate = words[j + 1];
      if (suffixCandidate && adjacent(text, words[j], suffixCandidate)) {
        const asSuffix = normalizeMultiWord(suffixCandidate.text);
        // Also try a 2-token suffix ("Ltd." + "Şti.")
        const afterSuffix = words[j + 2];
        const twoTokenSuffix = afterSuffix && adjacent(text, suffixCandidate, afterSuffix)
          ? normalizeMultiWord(`${suffixCandidate.text} ${afterSuffix.text}`)
          : null;
        // `Intl.Segmenter` often puts a suffix's trailing "." in its own
        // non-word segment right after it ("A.Ş" + "."); absorb dot(s)
        // glued directly onto the end so the reported span reads naturally
        // ("A.Ş.", not "A.Ş").
        const extendPastGluedDots = (end: number): number => {
          let e = end;
          while (text[e] === '.') e += 1;
          return e;
        };
        if (twoTokenSuffix && ORG_SUFFIXES.has(twoTokenSuffix)) {
          const end = extendPastGluedDots(afterSuffix.end);
          out.push({
            category: 'organization', start: w.start, end, value: text.slice(w.start, end),
            baseScore: 0.85, detector: 'dictionary', severity: 'medium', label: 'Organization name',
            evidence: EV(`capitalized run + "${twoTokenSuffix}"`),
          });
          i = j + 3; continue;
        }
        if (ORG_SUFFIXES.has(asSuffix)) {
          const end = extendPastGluedDots(suffixCandidate.end);
          out.push({
            category: 'organization', start: w.start, end, value: text.slice(w.start, end),
            baseScore: 0.85, detector: 'dictionary', severity: 'medium', label: 'Organization name',
            evidence: EV(`capitalized run + "${asSuffix}"`),
          });
          i = j + 2; continue;
        }
      }
    }

    // lone first/surname — low base score, needs context or NER agreement to clear a real threshold
    if (isFirst) {
      out.push({
        category: 'person', start: w.start, end: w.end, value: w.text,
        baseScore: w.capitalized ? 0.35 : 0, detector: 'dictionary', severity: 'high', label: 'Person name',
        evidence: EV('bare first-name dictionary hit'),
      });
    } else if (isSurname) {
      out.push({
        category: 'person', start: w.start, end: w.end, value: w.text,
        baseScore: w.capitalized ? 0.3 : 0, detector: 'dictionary', severity: 'high', label: 'Person name',
        evidence: EV('bare surname dictionary hit'),
      });
    }
    i += 1;
  }
  return out.filter((c) => c.baseScore > 0);
}

function scanLocations(text: string, words: WordSeg[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.capitalized) continue;
    const isProvince = PROVINCES.has(fold(w.text));
    const isDistrict = DISTRICTS.has(fold(w.text));
    if (!isProvince && !isDistrict) continue;
    const n1 = words[i + 1];
    // "Çankaya/Ankara" or "Çankaya, Ankara" — allow a single "/" or ", " separator, not just whitespace.
    const sep = n1 ? text.slice(w.end, n1.start) : '';
    const pairedSep = /^\s*[/,]\s*$/.test(sep);
    if (n1 && pairedSep && (PROVINCES.has(fold(n1.text)) || DISTRICTS.has(fold(n1.text))) && n1.capitalized) {
      out.push({
        category: 'location', start: w.start, end: n1.end, value: text.slice(w.start, n1.end),
        baseScore: 0.75, detector: 'dictionary', severity: 'low', label: 'Location',
        evidence: EV('district/province pair'),
      });
      i += 1;
      continue;
    }
    out.push({
      category: 'location', start: w.start, end: w.end, value: w.text,
      baseScore: isProvince ? 0.55 : 0.5, detector: 'dictionary', severity: 'low', label: 'Location',
      evidence: EV(isProvince ? 'province gazetteer hit' : 'district gazetteer hit'),
    });
  }
  return out;
}

/**
 * The built-in gazetteer pass. `languages` gates it (currently the seed
 * lists are Turkish-only — see `data/trGazetteer.ts`'s header — so this is a
 * no-op unless 'tr' is requested).
 */
export function scanDictionary(text: string, languages: PiiLanguage[] | undefined): Candidate[] {
  if (!text) return [];
  const langs = languages && languages.length > 0 ? languages : ['tr'];
  if (!langs.includes('tr') && !langs.includes('global')) return [];
  const words = segmentWords(text);
  return [...scanPersonsAndOrgs(text, words), ...scanLocations(text, words)];
}

/**
 * Tenant custom phrase list (arbitrary strings — a customer-name list, a
 * project codename list, anything not shaped like a single dictionary
 * word). One Aho-Corasick pass over the casefolded text; every match is
 * required to land on a word boundary in the ORIGINAL text.
 */
export function scanCustomPhrases(
  text: string,
  phrases: Array<{ value: string; categoryId: string; severity?: 'low' | 'medium' | 'high' }>,
): Candidate[] {
  if (!text || phrases.length === 0) return [];
  // General (not Turkish-locale) fold — see `foldGeneral`'s doc comment.
  // Unlike the built-in gazetteer above, a custom phrase can be in any
  // language (or ASCII product codes, all-caps acronyms, ...), so the
  // Turkish-specific 'I' rule that's correct for `TR_FIRST_NAMES` et al.
  // would be actively wrong here.
  const folded = foldGeneral(text);
  const ac = new AhoCorasick(phrases.map((p) => foldGeneral(p.value)));
  const boundaryMatches = ac.search(folded).filter((m) => isWordBoundaryMatch(text, m.start, m.end));
  const resolved = resolveAcOverlaps(boundaryMatches);
  return resolved.map((m) => {
    const phrase = phrases[m.patternIndex];
    return {
      category: phrase.categoryId,
      start: m.start,
      end: m.end,
      value: text.slice(m.start, m.end),
      baseScore: 0.8,
      detector: 'dictionary' as const,
      severity: phrase.severity ?? 'medium',
      label: phrase.categoryId,
      evidence: [`custom phrase list match: "${phrase.value}"`],
    };
  });
}
