/**
 * A small, self-contained Aho-Corasick automaton for multi-pattern substring
 * search in a single pass over the text.
 *
 * Used by `dictionary.ts` for TENANT CUSTOM PHRASE lists (arbitrary,
 * uncontrolled-length phrase sets — e.g. a customer-name list, a list of
 * internal project codenames) where the built-in gazetteer's segment+Set
 * lookup (single dictionary word per `Intl.Segmenter` token, see the header
 * comment in `dictionary.ts` for why) doesn't apply: a custom phrase can be
 * any string, need not align to word-segmenter boundaries the way a curated
 * single-token gazetteer entry does, and the list can be large enough (the
 * existing tenant word-list cap is 20,000 entries — see
 * `guardrail/wordListService.ts`) that anything worse than one linear pass
 * over the text, independent of pattern count, would not scale.
 *
 * Callers are responsible for case-folding text and patterns identically
 * before calling `search` (this class does no normalization of its own) and
 * for any word-boundary check on the result (`isWordBoundaryMatch` below
 * does the common one).
 */

interface AcNode {
  children: Map<string, AcNode>;
  fail: AcNode | null;
  /** Pattern indices whose full text ends at this node (own + inherited via fail links, filled in `build()`). */
  output: number[];
}

export interface AcMatch {
  /** Start offset in the searched text (inclusive). */
  start: number;
  /** End offset in the searched text (exclusive). */
  end: number;
  /** Index into the `patterns` array passed to the constructor. */
  patternIndex: number;
}

export class AhoCorasick {
  private readonly root: AcNode = { children: new Map(), fail: null, output: [] };

  constructor(private readonly patterns: string[]) {
    for (let i = 0; i < patterns.length; i++) {
      this.insert(patterns[i], i);
    }
    this.build();
  }

  private insert(pattern: string, index: number): void {
    let node = this.root;
    for (const ch of pattern) {
      let next = node.children.get(ch);
      if (!next) {
        next = { children: new Map(), fail: null, output: [] };
        node.children.set(ch, next);
      }
      node = next;
    }
    node.output.push(index);
  }

  /** BFS-build failure links and propagate output sets along them (classic Aho-Corasick construction). */
  private build(): void {
    const queue: AcNode[] = [];
    for (const child of this.root.children.values()) {
      child.fail = this.root;
      queue.push(child);
    }
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const [ch, child] of node.children) {
        queue.push(child);
        let f = node.fail;
        while (f && !f.children.has(ch)) f = f.fail;
        child.fail = f ? (f.children.get(ch) ?? this.root) : this.root;
        if (child.fail.output.length > 0) {
          child.output = child.output.concat(child.fail.output);
        }
      }
    }
  }

  /**
   * Every occurrence of every pattern in `text`, one pass, O(text.length +
   * matches). Overlapping matches (a shorter pattern inside a longer one, or
   * two patterns sharing a suffix) are all returned — callers pick among
   * them (e.g. longest-match-wins, per `resolveDictionaryOverlaps`).
   */
  search(text: string): AcMatch[] {
    const results: AcMatch[] = [];
    let node = this.root;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      while (node !== this.root && !node.children.has(ch)) {
        node = node.fail ?? this.root;
      }
      node = node.children.get(ch) ?? this.root;
      for (const patternIndex of node.output) {
        const len = this.patterns[patternIndex].length;
        results.push({ start: i - len + 1, end: i + 1, patternIndex });
      }
    }
    return results;
  }
}

/**
 * A Unicode "letter" check good enough to tell a real word boundary (space,
 * punctuation, digit, start/end of string) from a mid-word cut. Used to
 * reject e.g. a custom phrase "can" matching inside "Canada".
 */
function isLetter(ch: string | undefined): boolean {
  if (!ch) return false;
  return /\p{L}/u.test(ch);
}

/** True if `[start, end)` in `text` is not glued to a letter on either side. */
export function isWordBoundaryMatch(text: string, start: number, end: number): boolean {
  return !isLetter(text[start - 1]) && !isLetter(text[end]);
}

/** Span comparator: lower start first, longer match wins ties. */
export const byStartThenLongest = (a: { start: number; end: number }, b: { start: number; end: number }): number =>
  a.start - b.start || (b.end - b.start) - (a.end - a.start);

/**
 * Longest-match-wins de-overlap for same-source matches: sort by start then
 * by descending length, keep a match only if it doesn't overlap one already
 * kept. Mirrors `detector.ts`'s `resolveOverlaps` but pattern-index based.
 */
export function resolveAcOverlaps(matches: AcMatch[]): AcMatch[] {
  const sorted = matches.slice().sort(byStartThenLongest);
  const out: AcMatch[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (!last || m.start >= last.end) out.push(m);
  }
  return out;
}
