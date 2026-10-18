/**
 * One reading of a traced session that the grouped list, the timeline and
 * the time breakdown all share — built from the event stream alone, never
 * from which integration sent it.
 *
 * Integrations disagree on three things this file reconciles:
 *
 *   1. What groups a turn. agent-sdk sends an empty `agent_iteration` span,
 *      LangGraph a node span, LangChain a chain span, OpenAI Agents an Agent
 *      span; the Claude Agent SDK and plain LangChain agents send nothing.
 *      So grouping follows structure, not type: an event with children is a
 *      group, and a flat run of model/tool calls is split into inferred
 *      steps (each model call opens one).
 *   2. What `timestamp` means. The data model says "start of the step";
 *      agent-sdk sends the moment the event was recorded, i.e. its end. Both
 *      readings are tried and the one that breaks fewer causal constraints
 *      wins (a child inside its parent; a step not starting before the
 *      previous sibling finished).
 *   3. Whether a duration exists at all. The Claude Agent SDK sends none, so
 *      such sessions get gap-based estimates, marked as estimates.
 */

import { eventResponse, humanStep, isHumanEventType, type HumanStep, type SectionShell } from '@/lib/shared/tracingSections';

export interface TraceEventInput {
  id: string;
  sequence?: number;
  type?: string;
  label?: string;
  status?: string;
  timestamp?: string;
  durationMs?: number;
  spanId?: string;
  parentSpanId?: string;
  toolName?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  finishReason?: string;
  actor?: unknown;
  actorName?: string;
  sections?: readonly SectionShell[];
  /** Precomputed by the API summary; derived from `sections` otherwise. */
  responseToolNames?: string[];
  responseAnswered?: boolean;
  /** Precomputed by the API summary; derived from `sections` otherwise. */
  human?: HumanStep;
}

export type StepCategory = 'model' | 'tool' | 'retrieval' | 'guardrail' | 'human' | 'span' | 'other';

export function stepCategory(type?: string): StepCategory {
  if (!type) return 'other';
  const t = type.toLowerCase();
  // Before the tool rule: `tool_approval` is a person's step, not a tool's.
  if (isHumanEventType(t) || t === 'user_question') return 'human';
  // Context summarization is a model call of its own (billed, often the
  // largest prompt of the turn): its time and cost belong with the LLM steps.
  if (t === 'summarization') return 'model';
  if (t === 'ai_call' || t.startsWith('llm') || t.includes('completion') || t.includes('chat')) return 'model';
  if (t === 'tool_call' || t.startsWith('tool') || t.includes('function')) return 'tool';
  if (t === 'retrieval' || t === 'embedding' || t.includes('retriev') || t.includes('embed') || t.includes('rerank')) return 'retrieval';
  if (t === 'guardrail' || t.includes('guard')) return 'guardrail';
  if (t === 'agent_iteration' || t === 'span' || t.startsWith('chain') || t.includes('agent') || t === 'server') return 'span';
  return 'other';
}

/**
 * Sessions from the retired console-sdk LangChain handler: start and end are
 * separate events and nothing carries span ids or durations, so neither a
 * hierarchy nor a timeline can be rebuilt from them.
 */
export function isLegacyHandlerSession(events: readonly TraceEventInput[]): boolean {
  return events.some((event) => /^(chain|llm|tool)_(start|end|error)$/.test(event.type ?? ''));
}

/** Drops the ` #N` some SDKs bake into the label when N is the sequence number already shown beside it. */
export function cleanLabel(event: TraceEventInput): string | undefined {
  const label = event.label?.trim();
  if (!label) return undefined;
  if (event.sequence != null) {
    const suffix = ` #${event.sequence}`;
    if (label.endsWith(suffix) && label.length > suffix.length) return label.slice(0, -suffix.length);
  }
  return label;
}

// ─── Timing ────────────────────────────────────────────────────────────────

export interface StepTiming {
  start: number;
  end: number;
  /** A measured or estimated duration exists; false = a point in time only. */
  hasDuration: boolean;
  /** Duration is the gap since the previous step, not a measurement. */
  estimated: boolean;
}

export type TimestampMode = 'start' | 'end';

/** Slack for clock rounding between an SDK's timestamps and its durations. */
const CAUSALITY_SLACK_MS = 30;

function parseTime(value?: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function validDuration(value?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function bySequence(a: TraceEventInput, b: TraceEventInput, order: Map<string, number>): number {
  const sa = a.sequence ?? Number.MAX_SAFE_INTEGER;
  const sb = b.sequence ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
}

function timingsFor(events: readonly TraceEventInput[], mode: TimestampMode): Map<string, StepTiming> {
  const timings = new Map<string, StepTiming>();
  for (const event of events) {
    const ts = parseTime(event.timestamp);
    if (ts === undefined) continue;
    const duration = validDuration(event.durationMs);
    if (duration === undefined) {
      timings.set(event.id, { start: ts, end: ts, hasDuration: false, estimated: false });
    } else {
      const start = mode === 'start' ? ts : ts - duration;
      timings.set(event.id, { start, end: start + duration, hasDuration: true, estimated: false });
    }
  }
  return timings;
}

interface Structure {
  parentOf: Map<string, TraceEventInput>;
  childrenOf: Map<string, TraceEventInput[]>;
  order: Map<string, number>;
}

function readStructure(events: readonly TraceEventInput[]): Structure {
  const bySpan = new Map<string, TraceEventInput>();
  events.forEach((event) => { if (event.spanId) bySpan.set(event.spanId, event); });
  const parentOf = new Map<string, TraceEventInput>();
  const childrenOf = new Map<string, TraceEventInput[]>();
  const order = new Map<string, number>();
  events.forEach((event, index) => {
    order.set(event.id, index);
    const parent = event.parentSpanId ? bySpan.get(event.parentSpanId) : undefined;
    if (parent && parent.id !== event.id) {
      parentOf.set(event.id, parent);
      const list = childrenOf.get(parent.id) ?? [];
      list.push(event);
      childrenOf.set(parent.id, list);
    }
  });
  return { parentOf, childrenOf, order };
}

function countViolations(
  events: readonly TraceEventInput[],
  timings: Map<string, StepTiming>,
  structure: Structure,
): number {
  let violations = 0;
  for (const event of events) {
    const own = timings.get(event.id);
    const parent = structure.parentOf.get(event.id);
    const parentTiming = parent ? timings.get(parent.id) : undefined;
    if (!own || !parentTiming) continue;
    if (own.start < parentTiming.start - CAUSALITY_SLACK_MS) violations += 1;
    if (parentTiming.hasDuration && own.end > parentTiming.end + CAUSALITY_SLACK_MS) violations += 1;
  }

  // Consecutive leaf siblings: a later step should not start before the
  // earlier one finished. Parallel siblings overlap under either reading,
  // so they don't bias the vote.
  const siblings = new Map<string, TraceEventInput[]>();
  for (const event of events) {
    if (structure.childrenOf.has(event.id)) continue;
    if (!timings.get(event.id)?.hasDuration) continue;
    const key = structure.parentOf.get(event.id)?.id ?? '__root__';
    const list = siblings.get(key) ?? [];
    list.push(event);
    siblings.set(key, list);
  }
  for (const list of siblings.values()) {
    list.sort((a, b) => bySequence(a, b, structure.order));
    for (let i = 1; i < list.length; i += 1) {
      const prev = timings.get(list[i - 1].id)!;
      const next = timings.get(list[i].id)!;
      if (next.start < prev.end - CAUSALITY_SLACK_MS) violations += 1;
    }
  }
  return violations;
}

export interface ResolvedTimings {
  mode: TimestampMode;
  timings: Map<string, StepTiming>;
}

export function resolveTimings(events: readonly TraceEventInput[], sessionStartedAt?: string): ResolvedTimings {
  const structure = readStructure(events);
  const asStart = timingsFor(events, 'start');
  const asEnd = timingsFor(events, 'end');
  const mode: TimestampMode =
    countViolations(events, asEnd, structure) < countViolations(events, asStart, structure) ? 'end' : 'start';
  const timings = mode === 'end' ? asEnd : asStart;

  // A source that reports no durations at all (Claude Agent SDK) stamps each
  // step when its result arrives: the time since the previous step is the
  // best available estimate of how long it took.
  const leaves = events.filter((event) => !structure.childrenOf.has(event.id));
  const anyMeasured = leaves.some((event) => timings.get(event.id)?.hasDuration);
  if (!anyMeasured) {
    const roots = events.filter((event) => !structure.parentOf.has(event.id));
    // Parents first, so a subagent's steps are bounded by the (estimated)
    // start of the tool call that launched it.
    const visit = (siblings: TraceEventInput[], lowerBound: number | undefined) => {
      const ordered = [...siblings].sort((a, b) => (timings.get(a.id)?.end ?? 0) - (timings.get(b.id)?.end ?? 0));
      let previousEnd = lowerBound;
      for (const event of ordered) {
        const own = timings.get(event.id);
        if (!own) continue;
        const category = stepCategory(event.type);
        if (
          !own.hasDuration
          && previousEnd !== undefined
          && previousEnd < own.end
          && (category === 'model' || category === 'tool')
        ) {
          timings.set(event.id, { start: previousEnd, end: own.end, hasDuration: true, estimated: true });
        }
        const children = structure.childrenOf.get(event.id);
        if (children) visit(children, timings.get(event.id)!.start);
        previousEnd = own.end;
      }
    };
    visit(roots, parseTime(sessionStartedAt));
  }

  return { mode, timings };
}

// ─── Grouping ──────────────────────────────────────────────────────────────

export interface TraceNode {
  key: string;
  /** Absent for an inferred step, which no SDK sent. */
  event?: TraceEventInput;
  label: string;
  category: StepCategory;
  children: TraceNode[];
  inferred: boolean;
  /** Labels of single-child wrapper spans folded into this node, outermost first. */
  foldedLabels: string[];
  timing?: StepTiming;
  /** Highest number of direct children running at the same moment. */
  parallel: number;
  /**
   * The turn picked up after a pause (tool approval, ask-user, client tool):
   * its tools run without a model call here, because the call that asked for
   * them was recorded in the session that paused.
   */
  resumed?: boolean;
  /** The approval, question or host-run tool this step records. */
  human?: HumanStep;
  /** A request nobody has answered yet: the session is waiting on it. */
  waiting?: boolean;
}

/** The person's step an event records, from the summary or its sections. */
export function eventHuman(event: TraceEventInput): HumanStep | undefined {
  return event.human ?? humanStep(event);
}

/**
 * agent-sdk records a wait twice: the request when the run pauses, the
 * outcome (with the wait as its duration) when it resumes, both under the
 * same approval/question id. Once the outcome is in, the request row says
 * nothing the outcome row doesn't, so only the outcome is kept.
 */
export function foldHumanSteps(events: readonly TraceEventInput[]): TraceEventInput[] {
  const resolved = new Set<string>();
  for (const event of events) {
    const human = eventHuman(event);
    if (human?.key && human.state !== 'pending') resolved.add(`${human.kind}:${human.key}`);
  }
  if (resolved.size === 0) return [...events];
  return events.filter((event) => {
    const human = eventHuman(event);
    return !(human?.key && human.state === 'pending' && resolved.has(`${human.kind}:${human.key}`));
  });
}

function nodeLabel(event: TraceEventInput): string {
  const category = stepCategory(event.type);
  if (category === 'human') return cleanLabel(event) || (event.type === 'user_question' ? 'Question' : 'Approval');
  if (category === 'tool') return event.toolName || cleanLabel(event) || 'tool';
  // Named for what it did, not for its model: it would otherwise read as one
  // more turn of the agent.
  if (event.type === 'summarization') return cleanLabel(event) || 'Context summarization';
  if (category === 'model') return event.model || cleanLabel(event) || 'model';
  return cleanLabel(event) || event.type || 'step';
}

function hasOwnContent(event?: TraceEventInput): boolean {
  return Boolean(event?.sections && event.sections.length > 0);
}

function startOf(node: TraceNode): number {
  return node.timing?.start ?? Number.MAX_SAFE_INTEGER;
}

function maxConcurrency(nodes: TraceNode[]): number {
  const points: Array<[number, number]> = [];
  for (const node of nodes) {
    if (!node.timing?.hasDuration || node.timing.end <= node.timing.start) continue;
    points.push([node.timing.start, 1], [node.timing.end, -1]);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of points) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function containerTiming(own: StepTiming | undefined, children: TraceNode[]): StepTiming | undefined {
  if (own?.hasDuration && !own.estimated) return own;
  const childTimings = children.map((child) => child.timing).filter((t): t is StepTiming => Boolean(t));
  if (childTimings.length === 0) return own;
  const start = Math.min(...childTimings.map((t) => t.start), own?.start ?? Number.MAX_SAFE_INTEGER);
  const end = Math.max(...childTimings.map((t) => t.end), own?.end ?? 0);
  return {
    start,
    end,
    hasDuration: end > start,
    estimated: childTimings.some((t) => t.estimated),
  };
}

/**
 * A flat run of model and tool calls the framework didn't group: each model
 * call opens a step and the calls after it belong to that step. Applied only
 * where the framework did no grouping of its own at that level.
 */
function inferSteps(nodes: TraceNode[]): TraceNode[] {
  const frameworkGroups = nodes.some((node) => node.children.length > 0 && node.category === 'span');
  // A summarization pass is a model call but not a step of the agent's own.
  const opensStep = (node: TraceNode) => node.category === 'model' && node.children.length === 0
    && node.event?.type?.toLowerCase() !== 'summarization';
  const modelCalls = nodes.filter(opensStep).length;
  if (frameworkGroups || modelCalls < 2) return nodes;

  const result: TraceNode[] = [];
  let current: TraceNode | undefined;
  let step = 0;
  for (const node of nodes) {
    if (opensStep(node)) {
      step += 1;
      current = {
        key: `inferred-${node.key}`,
        label: `Step ${step}`,
        category: 'span',
        children: [node],
        inferred: true,
        foldedLabels: [],
        parallel: 0,
      };
      result.push(current);
    } else if (current) {
      current.children.push(node);
    } else {
      result.push(node);
    }
  }
  for (const node of result) {
    if (!node.inferred) continue;
    node.timing = containerTiming(undefined, node.children);
    node.parallel = maxConcurrency(node.children);
  }
  return result;
}

export function buildTraceTree(
  events: readonly TraceEventInput[],
  timings: Map<string, StepTiming>,
): TraceNode[] {
  const structure = readStructure(events);

  const toNode = (event: TraceEventInput): TraceNode => {
    const kids = (structure.childrenOf.get(event.id) ?? []).map(toNode);
    kids.sort((a, b) => startOf(a) - startOf(b) || bySequence(a.event!, b.event!, structure.order));
    const children = inferSteps(kids);
    const node: TraceNode = {
      key: event.id,
      event,
      label: nodeLabel(event),
      category: stepCategory(event.type),
      children,
      inferred: false,
      foldedLabels: [],
      timing: children.length > 0 ? containerTiming(timings.get(event.id), children) : timings.get(event.id),
      parallel: maxConcurrency(children),
    };
    const human = eventHuman(event);
    if (human) {
      node.human = human;
      node.waiting = human.state === 'pending';
    }
    // A wrapper span with one grouped child and nothing of its own is
    // plumbing (graph → node, executor → chain): show it as one row.
    if (
      node.category === 'span'
      && children.length === 1
      && children[0].children.length > 0
      && !children[0].inferred
      && !hasOwnContent(event)
    ) {
      const child = children[0];
      return { ...child, foldedLabels: [node.label, ...child.foldedLabels] };
    }
    return node;
  };

  const roots = events.filter((event) => !structure.parentOf.has(event.id)).map(toNode);
  roots.sort((a, b) => startOf(a) - startOf(b) || bySequence(a.event!, b.event!, structure.order));
  return inferSteps(roots);
}

export function flattenTree(nodes: readonly TraceNode[], depth = 0): Array<{ node: TraceNode; depth: number }> {
  const rows: Array<{ node: TraceNode; depth: number }> = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    rows.push(...flattenTree(node.children, depth + 1));
  }
  return rows;
}

// ─── What a step did ───────────────────────────────────────────────────────

export interface StepOutcome {
  toolNames: string[];
  answered: boolean;
}

export function stepOutcome(event: TraceEventInput): StepOutcome | undefined {
  if (stepCategory(event.type) !== 'model') return undefined;
  if (event.responseToolNames || event.responseAnswered !== undefined) {
    return { toolNames: event.responseToolNames ?? [], answered: Boolean(event.responseAnswered) };
  }
  const derived = eventResponse(event.type, event.sections);
  if (derived) return derived;
  const finish = event.finishReason?.toLowerCase();
  if (finish === 'stop' || finish === 'end_turn') return { toolNames: [], answered: true };
  return undefined;
}

const HUMAN_OUTCOME: Record<HumanStep['state'], string> = {
  pending: 'waiting',
  approved: 'approved',
  rejected: 'rejected',
  answered: 'answered',
  cancelled: 'cancelled',
  expired: 'expired',
  error: 'failed',
};

/** "→ approved by ayse" / "→ waiting" for a person's step. */
export function humanOutcomeText(human: HumanStep): string {
  const by = human.by && human.state !== 'pending' ? ` by ${human.by}` : '';
  return `→ ${HUMAN_OUTCOME[human.state]}${by}`;
}

/** "→ search_topics" / "→ answer" for a model call; undefined when unknown. */
export function outcomeText(event: TraceEventInput): string | undefined {
  const outcome = stepOutcome(event);
  if (!outcome) {
    const finish = event.finishReason?.toLowerCase();
    return finish === 'tool_calls' || finish === 'tool_use' ? '→ tool call' : undefined;
  }
  if (outcome.toolNames.length > 0) return `→ ${outcome.toolNames.join(', ')}`;
  return outcome.answered ? '→ answer' : undefined;
}

// ─── Where the time went ───────────────────────────────────────────────────

/** `waiting`: time a person took to approve or answer — not the agent's time. */
export type BreakdownCategory = 'model' | 'tool' | 'retrieval' | 'waiting' | 'other';

export interface BreakdownRow {
  key: string;
  category: BreakdownCategory;
  name: string;
  actor?: string;
  calls: number;
  totalMs: number;
  maxMs: number;
}

export interface TimeBreakdown {
  /** Session wall-clock time. */
  wallMs: number;
  /** Wall-clock time covered by each category (overlaps counted once). */
  byCategory: Record<BreakdownCategory, number>;
  /** Wall-clock time no measured step covers: framework, network, queueing. */
  overheadMs: number;
  /** Plain sum of step durations — exceeds covered time when steps ran in parallel. */
  sumMs: number;
  /** Union of all measured steps. */
  busyMs: number;
  /** Model/tool/retrieval steps reported without any duration. */
  unknownCount: number;
  estimatedCount: number;
  rows: BreakdownRow[];
  slowest?: { node: TraceNode; ms: number };
  windowStart: number;
  windowEnd: number;
}

function breakdownCategory(category: StepCategory): BreakdownCategory {
  if (category === 'model' || category === 'tool' || category === 'retrieval') return category;
  if (category === 'human') return 'waiting';
  return 'other';
}

function unionMs(intervals: Array<[number, number]>): number {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const [s, e] of sorted) {
    if (Number.isNaN(curStart) || s > curEnd) {
      if (!Number.isNaN(curStart)) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else {
      curEnd = Math.max(curEnd, e);
    }
  }
  if (!Number.isNaN(curStart)) total += curEnd - curStart;
  return total;
}

function actorName(event: TraceEventInput): string | undefined {
  const actor = event.actor && typeof event.actor === 'object' ? event.actor as Record<string, unknown> : undefined;
  if (actor?.scope === 'agent' && typeof actor.name === 'string') return actor.name;
  return undefined;
}

export function computeBreakdown(
  nodes: readonly TraceNode[],
  session?: { startedAt?: string; durationMs?: number },
): TimeBreakdown | undefined {
  const leaves = flattenTree(nodes).map(({ node }) => node).filter((node) => node.children.length === 0 && node.event);
  const measured = leaves.filter((node) => node.timing?.hasDuration);
  if (measured.length === 0) return undefined;

  const allTimings = flattenTree(nodes).map(({ node }) => node.timing).filter((t): t is StepTiming => Boolean(t));
  let windowStart = Math.min(...allTimings.map((t) => t.start));
  let windowEnd = Math.max(...allTimings.map((t) => t.end));
  const sessionStart = parseTime(session?.startedAt);
  if (sessionStart !== undefined && sessionStart < windowStart && windowStart - sessionStart < 60_000) {
    windowStart = sessionStart;
  }
  const sessionDuration = validDuration(session?.durationMs);
  if (sessionDuration !== undefined && windowStart + sessionDuration > windowEnd) {
    windowEnd = windowStart + sessionDuration;
  }
  const wallMs = Math.max(0, windowEnd - windowStart);

  const intervals: Record<BreakdownCategory, Array<[number, number]>> = { model: [], tool: [], retrieval: [], waiting: [], other: [] };
  const rows = new Map<string, BreakdownRow>();
  const agents = new Set(leaves.map((node) => actorName(node.event!)).filter(Boolean));
  let sumMs = 0;
  let slowest: TimeBreakdown['slowest'];

  for (const node of measured) {
    const timing = node.timing!;
    const ms = timing.end - timing.start;
    const category = breakdownCategory(node.category);
    intervals[category].push([timing.start, timing.end]);
    sumMs += ms;
    // A person's wait is not a slow step of the agent's.
    if (category !== 'waiting' && (!slowest || ms > slowest.ms)) slowest = { node, ms };

    const actor = agents.size > 1 ? actorName(node.event!) : undefined;
    const key = `${category}|${node.label}|${actor ?? ''}`;
    const row = rows.get(key) ?? { key, category, name: node.label, actor, calls: 0, totalMs: 0, maxMs: 0 };
    row.calls += 1;
    row.totalMs += ms;
    row.maxMs = Math.max(row.maxMs, ms);
    rows.set(key, row);
  }

  const byCategory = {
    model: unionMs(intervals.model),
    tool: unionMs(intervals.tool),
    retrieval: unionMs(intervals.retrieval),
    waiting: unionMs(intervals.waiting),
    other: unionMs(intervals.other),
  };
  const busyMs = unionMs([...intervals.model, ...intervals.tool, ...intervals.retrieval, ...intervals.waiting, ...intervals.other]);

  return {
    wallMs,
    byCategory,
    overheadMs: Math.max(0, wallMs - busyMs),
    sumMs,
    busyMs,
    unknownCount: leaves.filter((node) => !node.timing?.hasDuration && node.category !== 'human' && breakdownCategory(node.category) !== 'other').length,
    estimatedCount: measured.filter((node) => node.timing?.estimated).length,
    rows: [...rows.values()].sort((a, b) => b.totalMs - a.totalMs),
    slowest,
    windowStart,
    windowEnd,
  };
}

// ─── Everything at once ────────────────────────────────────────────────────

export interface SessionModel {
  tree: TraceNode[];
  timings: ResolvedTimings;
  breakdown?: TimeBreakdown;
  legacyHandler: boolean;
  hasTiming: boolean;
  /** This session continues a turn an earlier session of the thread paused. */
  resumed: boolean;
}

/**
 * agent-sdk opens a new trace session for each invoke, and a turn that paused
 * for an approval, a question or a client tool is finished by a second invoke.
 * That one's first iteration runs the approved tools straight away: no model
 * call, because the call that requested them belongs to the paused session.
 */
function markResumedTurn(tree: TraceNode[]): boolean {
  const first = tree.find((node) => node.event);
  if (!first || first.event?.type?.toLowerCase() !== 'agent_iteration') return false;
  const leaves = first.children.filter((child) => child.children.length === 0);
  const resumed = leaves.some((leaf) => leaf.category === 'tool') && !leaves.some((leaf) => leaf.category === 'model');
  if (resumed) first.resumed = true;
  return resumed;
}

export function buildSessionModel(
  events: readonly TraceEventInput[],
  session?: { startedAt?: string; durationMs?: number },
): SessionModel {
  const legacyHandler = isLegacyHandlerSession(events);
  const steps = foldHumanSteps(events);
  const timings = resolveTimings(steps, session?.startedAt);
  const tree = buildTraceTree(steps, timings.timings);
  const breakdown = legacyHandler ? undefined : computeBreakdown(tree, session);
  const resumed = markResumedTurn(tree);
  return { tree, timings, breakdown, legacyHandler, hasTiming: Boolean(breakdown), resumed };
}
