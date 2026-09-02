/**
 * `applyMutations` — the ONE place a guardrail rewrites content.
 *
 * Every policy emits mutations instead of rewriting the subject itself, and they
 * are all applied here, once, against the ORIGINAL subject. That is what makes
 * evaluation order stop being load-bearing: no policy can see another policy's
 * rewrite, so no policy can be defeated by running second.
 *
 * It replaces two real defects:
 *
 *  1. The legacy redaction was `result.split(value).join('[REDACTED:cat]')`.
 *     That rewrites EVERY occurrence of a matched value anywhere in the
 *     document — including occurrences inside another finding's text, and
 *     including the parts of the document the finding was never about — and it
 *     cannot express two matches that overlap at all. `replace_span` addresses
 *     a place; `replace_value` is scoped to ONE segment for the detectors that
 *     genuinely have no offsets (see SPAN_CAPABLE in ./contract).
 *
 *  2. The enforcement plane kept `results.find(r => r.sanitizedResource)` — ONE
 *     rewriting pass won and the others were discarded, which is why a second
 *     redactor had to be hand-chained onto the first. Here every pass composes.
 *
 * The algorithm is NORMATIVE: a remote enforcement point must reproduce it byte
 * for byte, or the same policy would redact differently in two places.
 *   1. Group by `path`.
 *   2. `replace_span` within a path: coalesce overlaps into the union range and
 *      pick the replacement by FAMILY_PRECEDENCE (ties: longer span, then
 *      policyId, then replacement, all lexicographic).
 *   3. `replace_value` within a path, AFTER spans: longest value first, and
 *      only at occurrences OUTSIDE any range step 2 already claimed.
 *   4. `remove` last, deepest path first.
 *   5. Rebuild `segments` and `text` from the mutated structure.
 * Every edit is computed against the ORIGINAL string and the whole set is
 * spliced in right-to-left, so no offset is ever invalidated by an earlier
 * rewrite of a different length.
 */

import {
  FAMILY_PRECEDENCE,
  isPlainRecord,
  joinSegments,
  unescapePointerToken,
  walkStringLeaves,
} from './contract';
import type { HookSubject, Mutation, MutationOutcome, SubjectSegment } from './contract';

type SpanMutation = Extract<Mutation, { op: 'replace_span' }>;
type ValueMutation = Extract<Mutation, { op: 'replace_value' }>;
type RemoveMutation = Extract<Mutation, { op: 'remove' }>;

interface Skip {
  mutation: Mutation;
  reason: string;
}

/** A non-overlapping rewrite of `[start, end)` in a single original string. */
interface Edit {
  start: number;
  end: number;
  replacement: string;
}

interface PathRewrite {
  text: string;
  applied: Mutation[];
  skipped: Skip[];
}

/**
 * Which part of the subject a mutation may rewrite, and the pointer prefix its
 * segments live under.
 *
 * 'scalar' subjects (`text`, `stream_delta`) have no structure behind their
 * segments — the segment IS the content — so a `remove` has nothing to delete.
 */
type SubjectRoot =
  | { form: 'structure'; root: unknown; prefix: string }
  | { form: 'scalar' };

function subjectRoot(subject: HookSubject): SubjectRoot {
  switch (subject.kind) {
    case 'tool_call':
      return { form: 'structure', root: subject.args, prefix: '/args' };
    case 'tool_result':
      return { form: 'structure', root: subject.result, prefix: '/result' };
    default:
      return { form: 'scalar' };
  }
}

// ── Ordering ────────────────────────────────────────────────────────────────

/**
 * Winner of a coalesced span cluster. Higher family precedence first, then the
 * longer span, then policyId and replacement lexicographically — the last two
 * exist only so the result is deterministic across processes, which it must be
 * for a remote enforcement point to agree with this one.
 */
function compareSpanWinners(a: SpanMutation, b: SpanMutation): number {
  const pa = FAMILY_PRECEDENCE[a.family];
  const pb = FAMILY_PRECEDENCE[b.family];
  if (pa !== pb) return pb - pa;
  const la = a.end - a.start;
  const lb = b.end - b.start;
  if (la !== lb) return lb - la;
  if (a.policyId !== b.policyId) return a.policyId < b.policyId ? -1 : 1;
  if (a.replacement === b.replacement) return 0;
  return a.replacement < b.replacement ? -1 : 1;
}

/**
 * Longest value first. A short value that is a substring of a longer one must
 * not claim its occurrences: redacting `example.com` out of
 * `ceo@example.com` would leave `ceo@[REDACTED:url]` — a fragment of the email
 * the longer finding was about, still on the page.
 */
function compareValueMutations(a: ValueMutation, b: ValueMutation): number {
  if (a.value.length !== b.value.length) return b.value.length - a.value.length;
  const pa = FAMILY_PRECEDENCE[a.family];
  const pb = FAMILY_PRECEDENCE[b.family];
  if (pa !== pb) return pb - pa;
  if (a.policyId !== b.policyId) return a.policyId < b.policyId ? -1 : 1;
  if (a.value === b.value) return 0;
  return a.value < b.value ? -1 : 1;
}

/**
 * Deepest path first, and within one parent the highest array index first, so
 * splicing an array never shifts a sibling that is still to be removed.
 * Numeric tokens compare numerically: '/list/10' must sort after '/list/2',
 * which plain string comparison gets backwards.
 */
function compareRemovalsDeepestFirst(a: RemoveMutation, b: RemoveMutation): number {
  const ta = a.path.split('/');
  const tb = b.path.split('/');
  if (ta.length !== tb.length) return tb.length - ta.length;
  for (let i = 0; i < ta.length; i += 1) {
    if (ta[i] === tb[i]) continue;
    const na = Number(ta[i]);
    const nb = Number(tb[i]);
    if (Number.isInteger(na) && Number.isInteger(nb)) return nb - na;
    return ta[i] < tb[i] ? 1 : -1;
  }
  return 0;
}

// ── Pointer access ──────────────────────────────────────────────────────────

/** Pointer tokens BELOW `prefix`, or null when `path` is not inside it. */
function tokensUnder(path: string, prefix: string): string[] | null {
  if (path === prefix) return [];
  if (!path.startsWith(`${prefix}/`)) return null;
  return path.slice(prefix.length + 1).split('/').map(unescapePointerToken);
}

/** Resolve every token but the last, returning the container and the final key. */
function resolveParent(
  root: unknown,
  tokens: readonly string[],
): { parent: unknown; key: string } | null {
  if (tokens.length === 0) return null;
  let node = root;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    if (Array.isArray(node)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return null;
      node = node[index];
      continue;
    }
    if (!isPlainRecord(node) || !Object.prototype.hasOwnProperty.call(node, token)) return null;
    node = node[token];
  }
  return { parent: node, key: tokens[tokens.length - 1] };
}

function setStringAtPointer(root: unknown, tokens: readonly string[], value: string): boolean {
  const target = resolveParent(root, tokens);
  if (!target) return false;
  const { parent, key } = target;
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) return false;
    if (typeof parent[index] !== 'string') return false;
    parent[index] = value;
    return true;
  }
  if (!isPlainRecord(parent) || typeof parent[key] !== 'string') return false;
  parent[key] = value;
  return true;
}

function removeAtPointer(root: unknown, tokens: readonly string[]): boolean {
  const target = resolveParent(root, tokens);
  if (!target) return false;
  const { parent, key } = target;
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) return false;
    parent.splice(index, 1);
    return true;
  }
  if (!isPlainRecord(parent) || !Object.prototype.hasOwnProperty.call(parent, key)) return false;
  delete parent[key];
  return true;
}

/**
 * Clones arrays and plain objects only; everything else is passed through by
 * reference. That pairing is deliberate and matches `walkStringLeaves`: what is
 * not cloned is not descended into, so it is never scanned, so it is never
 * written to — a rewrite can therefore never mutate an object the caller still
 * holds. The `seen` map preserves shared references (and terminates on cycles),
 * so a node reachable by two paths stays one node after the rewrite.
 */
function cloneContainers(value: unknown, seen: Map<object, unknown> = new Map()): unknown {
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(cloneContainers(item, seen));
    return out;
  }
  if (isPlainRecord(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [key, item] of Object.entries(value)) out[key] = cloneContainers(item, seen);
    return out;
  }
  return value;
}

// ── The per-path rewrite ────────────────────────────────────────────────────

function overlapsClaimed(
  claimed: ReadonlyArray<{ start: number; end: number }>,
  start: number,
  end: number,
): boolean {
  return claimed.some((range) => start < range.end && end > range.start);
}

function rewritePath(original: string, group: readonly Mutation[]): PathRewrite {
  const applied: Mutation[] = [];
  const skipped: Skip[] = [];
  const edits: Edit[] = [];
  /** Ranges of the ORIGINAL string already spoken for; nothing may edit twice. */
  const claimed: Array<{ start: number; end: number }> = [];

  // ── 1. replace_span: validate, then coalesce overlapping spans ──
  const spans: SpanMutation[] = [];
  for (const mutation of group) {
    if (mutation.op !== 'replace_span') continue;
    const { start, end } = mutation;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > original.length
    ) {
      // The most likely cause is a span computed against a different string —
      // a stale buffer, or a detector that scanned a normalised view. Reporting
      // it beats redacting an arbitrary range.
      skipped.push({ mutation, reason: 'span_out_of_range' });
      continue;
    }
    spans.push(mutation);
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  const clusters: Array<{ start: number; end: number; members: SpanMutation[] }> = [];
  for (const span of spans) {
    const last = clusters[clusters.length - 1];
    // `<` not `<=`: two spans that merely touch are adjacent, not overlapping,
    // and each deserves its own labelled replacement.
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      last.members.push(span);
    } else {
      clusters.push({ start: span.start, end: span.end, members: [span] });
    }
  }

  for (const cluster of clusters) {
    // The whole union range is claimed whether or not it changes, so a value
    // replacement cannot reach inside a region a span already owns.
    claimed.push({ start: cluster.start, end: cluster.end });
    const winner = [...cluster.members].sort(compareSpanWinners)[0];
    if (original.slice(cluster.start, cluster.end) === winner.replacement) {
      // Already redacted. Re-applying the same list must not wrap the marker in
      // another marker, so this is reported rather than performed.
      for (const member of cluster.members) skipped.push({ mutation: member, reason: 'already_applied' });
      continue;
    }
    edits.push({ start: cluster.start, end: cluster.end, replacement: winner.replacement });
    // Every member counts as applied: the losers of the precedence tie-break
    // still got the region they pointed at redacted, just under another label.
    for (const member of cluster.members) applied.push(member);
  }

  // ── 2. replace_value, outside the ranges spans already claimed ──
  const values = group.filter((m): m is ValueMutation => m.op === 'replace_value');
  values.sort(compareValueMutations);
  for (const mutation of values) {
    if (mutation.value.length === 0) {
      // An empty needle matches at every position; there is no sane rewrite.
      skipped.push({ mutation, reason: 'empty_value' });
      continue;
    }
    if (mutation.value === mutation.replacement) {
      skipped.push({ mutation, reason: 'replacement_equals_value' });
      continue;
    }
    let found = false;
    let placed = false;
    let index = original.indexOf(mutation.value);
    while (index !== -1) {
      found = true;
      const end = index + mutation.value.length;
      if (!overlapsClaimed(claimed, index, end)) {
        claimed.push({ start: index, end });
        edits.push({ start: index, end, replacement: mutation.replacement });
        placed = true;
      }
      // Advance past the whole needle: occurrences are non-overlapping, which
      // is the only reading under which "replace every occurrence" terminates.
      index = original.indexOf(mutation.value, end);
    }
    if (placed) applied.push(mutation);
    else skipped.push({ mutation, reason: found ? 'value_already_rewritten' : 'value_not_found' });
  }

  // ── 3. splice right-to-left ──
  // Every edit was computed against `original` and no two overlap, so applying
  // them from the end keeps every remaining offset valid however much the
  // replacements change the length.
  edits.sort((a, b) => b.start - a.start);
  let text = original;
  for (const edit of edits) {
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  }

  return { text, applied, skipped };
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function applyMutations<S extends HookSubject>(
  subject: S,
  mutations: readonly Mutation[],
): MutationOutcome<S> {
  const applied: Mutation[] = [];
  const skipped: Skip[] = [];
  const unchanged = (): MutationOutcome<S> => ({
    subject,
    text: subject.text,
    applied,
    skipped,
  });

  if (mutations.length === 0) return unchanged();

  const segmentText = new Map<string, string>();
  for (const segment of subject.segments) segmentText.set(segment.path, segment.text);

  // ── group by path; `remove` is structural and handled separately ──
  const byPath = new Map<string, { original: string; group: Mutation[] }>();
  const removes: RemoveMutation[] = [];
  for (const mutation of mutations) {
    if (mutation.op === 'remove') {
      removes.push(mutation);
      continue;
    }
    const original = segmentText.get(mutation.path);
    if (original === undefined) {
      // The segment the detector pointed at is not on this subject. Almost
      // always a mutation computed against an earlier subject (a previous
      // stream window, a pre-rewrite tool result).
      skipped.push({ mutation, reason: 'path_not_found' });
      continue;
    }
    const bucket = byPath.get(mutation.path);
    if (bucket) bucket.group.push(mutation);
    else byPath.set(mutation.path, { original, group: [mutation] });
  }

  const rewrites = new Map<string, { text: string; applied: Mutation[] }>();
  for (const [path, { original, group }] of byPath) {
    const result = rewritePath(original, group);
    skipped.push(...result.skipped);
    if (result.applied.length === 0) continue;
    rewrites.set(path, { text: result.text, applied: result.applied });
  }

  const root = subjectRoot(subject);

  // ── scalar subjects: the segments ARE the content ──
  if (root.form === 'scalar') {
    for (const mutation of removes) {
      skipped.push({ mutation, reason: 'remove_unsupported_for_subject' });
    }
    if (rewrites.size === 0) return unchanged();
    for (const rewrite of rewrites.values()) applied.push(...rewrite.applied);

    const segments: SubjectSegment[] = subject.segments.map((segment) => ({
      ...segment,
      text: rewrites.get(segment.path)?.text ?? segment.text,
    }));
    const text = joinSegments(segments);
    // A stream_delta carries exactly one segment covering the whole buffer (see
    // HookSubject), and the gate emits from `buffer` — writing only `text`
    // would produce a verdict that claims a redaction the client never sees.
    const patch =
      subject.kind === 'stream_delta' ? { segments, text, buffer: text } : { segments, text };
    // The spread widens S to its structural shape and TypeScript will not
    // narrow it back to the type parameter. The cast is sound: every field
    // replaced already exists on S with the type it is given here.
    return { subject: { ...subject, ...patch } as unknown as S, text, applied, skipped };
  }

  // ── structured subjects: rewrite a clone, then re-derive the segments ──
  if (rewrites.size === 0 && removes.length === 0) return unchanged();
  const clone = cloneContainers(root.root);
  for (const [path, rewrite] of rewrites) {
    const tokens = tokensUnder(path, root.prefix);
    const ok = tokens !== null && tokens.length > 0 && setStringAtPointer(clone, tokens, rewrite.text);
    if (ok) {
      applied.push(...rewrite.applied);
      continue;
    }
    // The segment exists but its pointer does not resolve into the structure —
    // a hand-built subject whose segments and `args`/`result` disagree. Demote
    // the whole path from applied to skipped rather than report a rewrite that
    // reached nothing.
    for (const mutation of rewrite.applied) skipped.push({ mutation, reason: 'path_unresolvable' });
  }

  for (const mutation of removes.slice().sort(compareRemovalsDeepestFirst)) {
    const tokens = tokensUnder(mutation.path, root.prefix);
    if (tokens === null || tokens.length === 0) {
      skipped.push({ mutation, reason: 'path_outside_subject' });
      continue;
    }
    if (removeAtPointer(clone, tokens)) applied.push(mutation);
    else skipped.push({ mutation, reason: 'path_not_found' });
  }

  // Nothing landed: return the ORIGINAL subject, identity included. Rebuilding
  // it would still re-walk the clone, and a re-walk can legitimately differ
  // from the segments the subject was built with (an empty string is not a
  // segment) — a silent change with zero mutations applied is worse than none.
  if (applied.length === 0) return unchanged();

  const segments = walkStringLeaves(clone, root.prefix);
  const text = joinSegments(segments);
  const patch =
    subject.kind === 'tool_call'
      ? { segments, text, args: clone as Record<string, unknown> }
      : { segments, text, result: clone };
  return { subject: { ...subject, ...patch } as unknown as S, text, applied, skipped };
}
