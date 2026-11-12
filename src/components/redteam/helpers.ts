/**
 * Pure helpers shared by the red-team screens (no React, no fetching), so the
 * rules that matter — which attempts can be reviewed, what an inconclusive run
 * says, how a new attempt id is picked — are testable on their own.
 */

import { attemptKeyOf } from '@/lib/services/redteam/attemptKey';
import { ATTEMPT_ID_PATTERN } from '@/lib/services/redteam/limits';
import type { NativeProbe } from '@/lib/services/redteam/import/types';
import type {
  BuiltinProbeDefinitionView,
  CustomProbeView,
  ProbeCatalogView,
  RedTeamAggregateView,
  RedTeamAttemptView,
  RedTeamInconclusiveReason,
  RedTeamOutcome,
  RedTeamRunStatus,
  RedTeamRunView,
  RedTeamTargetKind,
} from './types';

/** A rate as a percentage; `—` when the run had nothing to measure (null) or none was recorded. */
export function pct(value?: number | null): string {
  return value === undefined || value === null || !Number.isFinite(value) ? '—' : `${Math.round(value * 100)}%`;
}

export function effectiveOutcome(a: Pick<RedTeamAttemptView, 'outcome' | 'review'>): RedTeamOutcome {
  return a.review?.outcome ?? a.outcome;
}

/** The row key of an attempt; a payload from before keys were stored falls back to probe + id. */
export function attemptKeyFor(a: Pick<RedTeamAttemptView, 'attemptKey' | 'probeKey' | 'attemptId'>): string {
  return a.attemptKey || attemptKeyOf(a);
}

/** The target failed before any turn completed: nothing was judged. */
export function isFailedAttempt(a: Pick<RedTeamAttemptView, 'error' | 'partial'>): boolean {
  return Boolean(a.error) && !a.partial;
}

export function isFinishedStatus(status: RedTeamRunStatus | string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function isActiveStatus(status: RedTeamRunStatus | string | undefined): boolean {
  return status === 'pending' || status === 'running';
}

export type ReviewBlock = 'run-active' | 'restricted' | 'failed';

/** Why an attempt cannot be reviewed now, or null when it can. */
export function reviewBlockedReason(run: Pick<RedTeamRunView, 'status'>, a: RedTeamAttemptView): ReviewBlock | null {
  if (!isFinishedStatus(run.status)) return 'run-active';
  if (a.restricted) return 'restricted';
  if (isFailedAttempt(a)) return 'failed';
  return null;
}

export const REVIEW_BLOCK_HINT: Record<ReviewBlock, string> = {
  'run-active': 'Review is available once the scan has finished.',
  restricted: 'This attempt used knowledge base documents you cannot read, so it cannot be reviewed.',
  failed: 'The target failed before answering, so there is nothing to review.',
};

export const INCONCLUSIVE_REASON_TEXT: Record<RedTeamInconclusiveReason, string> = {
  'no-completed-attempts': 'No attempt completed, so there is nothing to measure.',
  'target-errors': 'Too many attempts ended in a target error.',
  'judge-errors': 'Too many judge calls failed, so verdicts that needed a judge are unreliable.',
};

/**
 * The reasons a run's rates should not be trusted, in order; empty when the run
 * is conclusive. A run stored before reasons existed that is flagged
 * inconclusive was flagged for judge errors.
 */
export function inconclusiveReasons(
  aggregate?: Pick<RedTeamAggregateView, 'inconclusive' | 'inconclusiveReasons'> | null,
): RedTeamInconclusiveReason[] {
  if (!aggregate) return [];
  if (aggregate.inconclusiveReasons && aggregate.inconclusiveReasons.length > 0) return aggregate.inconclusiveReasons;
  return aggregate.inconclusive ? ['judge-errors'] : [];
}

/** The tag for a partial attempt, e.g. `partial — target error after 2 turns`. */
export function partialLabel(a: Pick<RedTeamAttemptView, 'transcript'>): string {
  const turns = a.transcript?.length ?? 0;
  return `partial — target error after ${turns} turn${turns === 1 ? '' : 's'}`;
}

/**
 * The id for a new attempt of a custom probe: the largest numeric suffix among
 * the ids in use + 1, so an id that was removed earlier is never handed out
 * again (a stored run refers to attempts by id). Ids without a numeric suffix
 * count as 0.
 */
export function nextAttemptId(existing: string[], prefix = 'attempt-', floor = 0): string {
  return `${prefix}${highestAttemptSuffix(existing, floor) + 1}`;
}

/** The largest numeric suffix among the ids (or `floor` when that is larger); ids without a suffix count as 0. */
export function highestAttemptSuffix(ids: string[], floor = 0): number {
  let max = floor;
  for (const id of ids) {
    const m = /(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return max;
}

/** Why an attempt id cannot be saved, or null. `others` are the ids of the other attempts in the probe. */
export function attemptIdError(id: string, others: string[]): string | null {
  if (!id.trim()) return 'An attempt id is required.';
  if (!ATTEMPT_ID_PATTERN.test(id)) return 'Use letters, digits, ".", "_" or "-" (up to 64 characters).';
  if (others.includes(id)) return 'Another attempt already uses this id.';
  return null;
}

/** Splits a textarea of forbidden patterns: one per line, blank lines dropped. */
export function splitPatternLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Selected probe keys that no longer match a probe in the catalog. Keys of a
 * disabled custom probe are not counted: they still exist, they are just skipped.
 */
export function missingProbeKeys(selected: string[], catalogKeys: string[], disabledKeys: string[] = []): string[] {
  const known = new Set([...catalogKeys, ...disabledKeys]);
  return selected.filter((k) => !known.has(k));
}

/** The selected probes that exist but are disabled, with their names. */
export function selectedDisabledProbes(
  selected: string[],
  disabled: Array<{ key: string; name: string }> = [],
): Array<{ key: string; name: string }> {
  const chosen = new Set(selected);
  return disabled.filter((d) => chosen.has(d.key));
}

/**
 * Merges a freshly polled first page into the rows already loaded: rows that
 * are new come first, rows that are already loaded are replaced in place, and
 * the loaded tail is kept.
 */
export function mergePolledPage<T extends { id: string }>(prev: T[], page: T[], limit?: number): T[] {
  // A page shorter than its limit is the whole list, so it replaces the rows (a deleted run disappears).
  if (limit !== undefined && page.length < limit) return page;
  const fresh = new Map(page.map((r) => [r.id, r]));
  const known = new Set(prev.map((r) => r.id));
  const added = page.filter((r) => !known.has(r.id));
  return [...added, ...prev.map((r) => fresh.get(r.id) ?? r)];
}

/** Appends a "Load more" page, dropping rows whose id is already loaded (offset paging can repeat one). */
export function appendPage<T extends { id: string }>(prev: T[], page: T[]): T[] {
  const known = new Set(prev.map((r) => r.id));
  const out: T[] = [];
  for (const r of page) {
    if (known.has(r.id)) continue;
    known.add(r.id);
    out.push(r);
  }
  return [...prev, ...out];
}

/** The largest page the runs endpoint returns; polling asks for no more than this. */
export const POLL_PAGE_LIMIT = 100;

/* ── Probe library: catalog, picker, import preview ───────────────────────── */

/** A probe added within this many days carries the NEW badge. */
export const NEW_PROBE_DAYS = 90;

/** True when `addedAt` (an ISO date) is within the last NEW_PROBE_DAYS days. A missing or unreadable date is not new. */
export function isNewProbe(addedAt: string | undefined, now: Date = new Date()): boolean {
  if (!addedAt) return false;
  const added = new Date(addedAt).getTime();
  if (!Number.isFinite(added)) return false;
  const ageDays = (now.getTime() - added) / 86_400_000;
  return ageDays >= 0 && ageDays <= NEW_PROBE_DAYS;
}

/** The "Works with" labels of a probe: `Model`, `Agent`, or `Model only`, plus its requirements. */
export function worksWithLabels(
  probe: Pick<ProbeCatalogView, 'targets' | 'requires' | 'requiresHistory'> & { agentAttemptCount?: number },
): string[] {
  const targets = probe.targets && probe.targets.length > 0 ? probe.targets : (['model', 'agent'] as RedTeamTargetKind[]);
  const labels: string[] = [];
  const model = targets.includes('model');
  // A probe none of whose attempts can run on an agent does not work with agents, whatever it declares.
  const agent = targets.includes('agent') && probe.agentAttemptCount !== 0;
  if (model && agent) labels.push('Model', 'Agent');
  else if (model) labels.push('Model only');
  else if (agent) labels.push('Agent only');
  const requires = new Set(probe.requires ?? []);
  if (requires.has('long-context')) labels.push('Long context');
  if (requires.has('caller-history') || probe.requiresHistory) labels.push('Caller history');
  return labels;
}

/**
 * Whether a probe can run against the target kind at all (a probe without `targets` runs on both).
 * A probe none of whose attempts can run on an agent (`agentAttemptCount` 0) does not count for agents.
 */
export function probeTargetsKind(probe: Pick<ProbeCatalogView, 'targets'> & { agentAttemptCount?: number }, kind: RedTeamTargetKind): boolean {
  if (kind === 'agent' && probe.agentAttemptCount === 0) return false;
  return !probe.targets || probe.targets.length === 0 || probe.targets.includes(kind);
}

/** Detector keys that only lean towards safe or review; they never prove an attack worked. */
const SOFT_DETECTORS = new Set(['refusal', 'non-refusal']);

export function isJudgeDetector(key: string): boolean {
  return key.startsWith('llm-judge');
}

/** `deterministic` when no judge is involved, `judge` when only judges decide, `both` otherwise. */
export function detectionKind(detectors: string[] | undefined): 'deterministic' | 'judge' | 'both' | 'unknown' {
  if (!detectors || detectors.length === 0) return 'unknown';
  const judges = detectors.filter(isJudgeDetector).length;
  const others = detectors.filter((d) => !isJudgeDetector(d) && !SOFT_DETECTORS.has(d)).length;
  if (judges === 0) return 'deterministic';
  return others === 0 ? 'judge' : 'both';
}

/** The detection filter of the built-in table. */
export type DetectionFilter = 'deterministic' | 'judge';

export interface BuiltinFilters {
  category?: string | null;
  severity?: string | null;
  target?: RedTeamTargetKind | null;
  detection?: DetectionFilter | null;
}

/** Applies the Built-in tab filters. A probe whose detectors are unknown passes the detection filter. */
export function filterBuiltinProbes(probes: ProbeCatalogView[], f: BuiltinFilters): ProbeCatalogView[] {
  return probes.filter((p) => {
    if (f.category && p.category !== f.category) return false;
    if (f.severity && p.severity !== f.severity) return false;
    if (f.target && !probeTargetsKind(p, f.target)) return false;
    if (f.detection) {
      const kind = detectionKind(p.detectors);
      if (kind === 'unknown') return true;
      if (f.detection === 'judge' && kind === 'deterministic') return false;
      if (f.detection === 'deterministic' && kind === 'judge') return false;
    }
    return true;
  });
}

export interface DetectorInfo {
  label: string;
  help: string;
}

const DETECTOR_INFO: Record<string, DetectorInfo> = {
  refusal: { label: 'Refusal', help: 'Reads an explicit refusal as the safe outcome. Not proof on its own.' },
  pattern: { label: 'Canary / pattern', help: 'Hard proof: the planted canary or a forbidden pattern appears in the output.' },
  pii: { label: 'PII', help: 'Personal data in the output.' },
  'encoding-leak': { label: 'Encoded leak', help: 'The planted value appears encoded (base64, hex, reversed and similar).' },
  'insecure-output': { label: 'Insecure output', help: 'Output that would run or inject downstream (script tags, shell or SQL fragments).' },
  'markdown-exfil': { label: 'Markdown exfiltration', help: 'The canary is placed in an image, link or URL. An image is fetched on render, with no click.' },
  'ansi-escape': { label: 'Terminal escapes', help: 'Raw ANSI/OSC escape sequences in the output.' },
  'tag-smuggling': { label: 'Tag characters', help: 'Hidden Unicode tag characters in the output.' },
  consumption: { label: 'Output size', help: 'The reply is unusually long for the request.' },
  'non-refusal': { label: 'Answered', help: 'Soft signal: no refusal at all. It goes to review when no judge is configured.' },
};

/** A readable name and help line for a detector key (`llm-judge:<lens>` included). */
export function detectorInfo(key: string): DetectorInfo {
  if (isJudgeDetector(key)) {
    const lens = key.split(':')[1];
    return { label: lens ? `Judge · ${lens}` : 'Judge', help: 'An LLM judge grades the transcript. Needs a judge model on the campaign.' };
  }
  return DETECTOR_INFO[key] ?? { label: key, help: '' };
}

/** True for a detector that proves an attack worked on its own. */
export function isHardProofDetector(key: string): boolean {
  return !isJudgeDetector(key) && !SOFT_DETECTORS.has(key);
}

/* Picker grouping */

export type PickerGroupId = 'default' | 'more' | 'custom' | 'imported';

export interface PickerGroup {
  id: PickerGroupId;
  label: string;
  probes: ProbeCatalogView[];
}

const PICKER_GROUP_LABEL: Record<PickerGroupId, string> = {
  default: 'Built-in (default set)',
  more: 'Built-in (more)',
  custom: 'Custom',
  imported: 'Imported',
};

/**
 * Splits catalog probes into the picker groups, in display order, leaving out
 * empty ones. A built-in without `isDefault` (older server) counts as default.
 */
export function groupPickerProbes(probes: ProbeCatalogView[]): PickerGroup[] {
  const buckets: Record<PickerGroupId, ProbeCatalogView[]> = { default: [], more: [], custom: [], imported: [] };
  for (const p of probes) {
    if (p.custom) buckets[p.origin === 'import' ? 'imported' : 'custom'].push(p);
    else buckets[p.isDefault === false ? 'more' : 'default'].push(p);
  }
  return (['default', 'more', 'custom', 'imported'] as PickerGroupId[])
    .filter((id) => buckets[id].length > 0)
    .map((id) => ({ id, label: PICKER_GROUP_LABEL[id], probes: buckets[id] }));
}

/** The size of the set that runs when nothing is selected. */
export function defaultSetCount(probes: ProbeCatalogView[]): number {
  const builtins = probes.filter((p) => !p.custom);
  const flagged = builtins.filter((p) => p.isDefault === true).length;
  return flagged > 0 ? flagged : builtins.length;
}

export function defaultSetNote(probes: ProbeCatalogView[]): string {
  const n = defaultSetCount(probes);
  return `Runs the default set: ${n} probe${n === 1 ? '' : 's'}`;
}

export type AgentFit = { kind: 'full' } | { kind: 'none'; text: string } | { kind: 'partial'; text: string };

/** How a probe fits an agent campaign: not at all, partly, or fully. Unknown counts mean fully. */
export function agentFit(probe: Pick<ProbeCatalogView, 'agentAttemptCount' | 'attemptCount' | 'targets'>): AgentFit {
  if (probe.targets && probe.targets.length > 0 && !probe.targets.includes('agent')) {
    return { kind: 'none', text: 'Not run against agents' };
  }
  const run = probe.agentAttemptCount;
  const total = probe.attemptCount;
  if (typeof run !== 'number' || typeof total !== 'number') return { kind: 'full' };
  if (run === 0) return { kind: 'none', text: 'Not run against agents' };
  if (run < total) return { kind: 'partial', text: `${run} of ${total} attempts run on agents` };
  return { kind: 'full' };
}

/** Catalog keys of one OWASP category, for "Select all in <category>". */
export function keysInCategory(probes: ProbeCatalogView[], category: string): string[] {
  return probes.filter((p) => p.category === category).map((p) => p.key);
}

/* Custom probe source */

/** The Source column of a custom probe: "Manual", "Clone of <key> v<n>" or "Imported · <source>". */
export function probeSourceLabel(p: Pick<CustomProbeView, 'origin' | 'clonedFrom' | 'source'>): string {
  if (p.origin === 'clone' && p.clonedFrom) return `Clone of ${p.clonedFrom.probeKey} v${p.clonedFrom.version}`;
  if (p.origin === 'import') return p.source?.name ? `Imported · ${p.source.name}` : 'Imported';
  return 'Manual';
}

export type SourceFilter = 'manual' | 'clone' | 'import';

/** A probe stored before origins existed is manual. */
export function probeOriginOf(p: Pick<CustomProbeView, 'origin'>): SourceFilter {
  return p.origin ?? 'manual';
}

/* Over-refusal */

/** Verdict wording of an attempt: an over-refusal attempt is "Refused" (failed) or "Answered" (fine). */
export function outcomeLabel(a: Pick<RedTeamAttemptView, 'polarity'>, outcome: RedTeamOutcome): string {
  if (a.polarity === 'over-refusal') {
    if (outcome === 'vulnerable') return 'Refused';
    if (outcome === 'safe') return 'Answered';
  }
  return outcome.replace('_', ' ');
}

export type AttemptKindFilter = 'all' | 'attack' | 'over-refusal';

export function filterAttemptsByKind<T extends Pick<RedTeamAttemptView, 'polarity'>>(attempts: T[], kind: AttemptKindFilter): T[] {
  if (kind === 'all') return attempts;
  return attempts.filter((a) => (kind === 'over-refusal') === (a.polarity === 'over-refusal'));
}

/** The tile text under the over-refusal rate. */
export function overRefusalDetail(o: { refused: number; completed: number; failed?: number }): string {
  // The tile keeps this on one line, so the version with failures is shorter.
  return o.failed
    ? `${o.refused} of ${o.completed} refused · ${o.failed} unanswered`
    : `${o.refused} of ${o.completed} harmless prompts refused`;
}

/* Import preview masking */

/** Placeholder for a masked preview cell. */
export function maskText(text: string): string {
  return `•••• (${text.length} characters)`;
}

/** Previews start masked when the format is sensitive or the rows are harmful requests or strings. */
export function shouldMaskPreview(sensitive: boolean | undefined, polarity: string): boolean {
  return Boolean(sensitive) || polarity === 'harmful-request' || polarity === 'forbidden-strings';
}

/** The text shown in a preview cell. */
export function previewCell(text: string, masked: boolean, max = 160): string {
  if (masked) return maskText(text);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* Native export */

/** A stored or built-in probe in the Console export shape (see import/native). */
export function toNativeProbe(p: CustomProbeView | BuiltinProbeDefinitionView): NativeProbe {
  const builtin = 'detectorSpec' in p;
  const detectors = builtin ? (p as BuiltinProbeDefinitionView).detectorSpec : (p as CustomProbeView).detectors;
  const stored = builtin ? undefined : (p as CustomProbeView);
  return {
    name: builtin ? `${p.key}-copy` : p.name,
    description: p.description || undefined,
    family: p.family || undefined,
    category: p.category,
    severity: p.severity as NativeProbe['severity'],
    polarity: p.polarity,
    attempts: p.attempts as unknown as NativeProbe['attempts'],
    detectors: detectors as unknown as NativeProbe['detectors'],
    source: stored?.source ? ({ ...stored.source, importedAt: undefined } as unknown as NativeProbe['source']) : undefined,
    clonedFrom: builtin ? { probeKey: p.key, version: (p as BuiltinProbeDefinitionView).version ?? 1 } : stored?.clonedFrom,
  };
}

/** A file name for an export: letters, digits, `.`, `_` and `-` only. */
export function exportFileName(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe || 'probe'}.redteam.yaml`;
}
