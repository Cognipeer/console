/**
 * Deterministic detector battery — the prescriptions engine's source of
 * truth. Every finding a report can contain is produced here, from evidence
 * that was measured (tracing overviews, usage_daily cost rollups), with the
 * threshold that fired spelled out in the evidence. Savings estimates are
 * conservative and only computed when the required prices are actually
 * known — a finding with `estMonthlySavingsUsd: null` is real but unpriceable.
 */

import type { IModelPricing } from '@/lib/database';
import { inferModelTier, normalizeModelName } from '@/lib/services/modelPriceCatalog/modelPriceCatalog';
import { detectRegimeShift, findOutliers } from './stats';
import type {
  Detector,
  DetectorInput,
  FindingSeverity,
  PrescriptionFinding,
} from './types';

// ── Thresholds (all tunable in one place) ──────────────────────────────────

/** Cache detectors need real volume before a rate is meaningful. */
const CACHE_MIN_INPUT_TOKENS = 1_000_000;
const CACHE_RATE_WARN = 0.4;
const CACHE_RATE_CRITICAL = 0.1;
/** Conservative attainable cache rate used for the savings estimate. */
const CACHE_TARGET_RATE = 0.5;

const CONTEXT_TOKENS_WARN = 20_000;
const CONTEXT_TOKENS_CRITICAL = 50_000;

const REPEAT_CALLS_MIN = 10;
const REPEAT_RATIO_WARN = 0.1;
const REPEAT_RATIO_CRITICAL = 0.3;

const RECURRING_ERROR_MIN = 10;
const RECURRING_ERROR_CRITICAL = 50;

const SESSION_ERROR_RATE_WARN = 0.05;
const SESSION_ERROR_RATE_CRITICAL = 0.15;

const TOOL_ERROR_RATE_MIN_CALLS = 20;
const TOOL_ERROR_RATE_WARN = 0.3;

const MENU_SIZE_WARN = 30;
const MENU_UNUSED_WARN = 10;

const TRAFFIC_OUTLIER_Z = 6;
const SPEND_OUTLIER_Z = 5;

const UNPRICED_SHARE_CRITICAL = 0.2;

const PREMIUM_TIER = 4;
const PREMIUM_SHARE_INFO = 0.7;
const PREMIUM_MIN_COST_USD = 50;

const ERROR_REQUEST_RATE_WARN = 0.05;

// ── Helpers ────────────────────────────────────────────────────────────────

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function pct(value: number): string {
  return `${round2(value * 100)}%`;
}

function fmtInt(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** Scale a window figure to a 30-day month. */
function monthly(value: number, windowDays: number): number {
  return windowDays > 0 ? (value * 30) / windowDays : value;
}

/**
 * Cache savings are only estimated when BOTH the input and the cached price
 * are known — assuming a cached price would fabricate the estimate.
 */
function cacheSavingsUsd(
  inputTokens: number,
  cacheRate: number,
  pricing: IModelPricing | undefined,
  windowDays: number,
): number | null {
  if (!pricing) return null;
  const inputPer1M = pricing.inputTokenPer1M;
  const cachedPer1M = pricing.cachedTokenPer1M;
  if (typeof inputPer1M !== 'number' || typeof cachedPer1M !== 'number') return null;
  if (cacheRate >= CACHE_TARGET_RATE) return 0;
  const extraCachedTokens = inputTokens * (CACHE_TARGET_RATE - cacheRate);
  const windowSavings = (extraCachedTokens * (inputPer1M - cachedPer1M)) / 1_000_000;
  return round2(monthly(Math.max(0, windowSavings), windowDays));
}

/** Pricing of the model that dominates the subject's spend, when known. */
function dominantPricing(input: DetectorInput): IModelPricing | undefined {
  const dominantKey = input.agentCost?.models?.[0]?.modelKey;
  if (!dominantKey) return undefined;
  return input.observedModels?.entries.find((e) => e.modelKey === dominantKey)?.pricing;
}

function lintCheck(input: DetectorInput, id: string) {
  return input.overview?.analytics.insights?.promptProfile.lint?.checks.find((c) => c.id === id);
}

// ── Agent / model subject detectors ────────────────────────────────────────

const cacheHitLow: Detector = {
  key: 'cache-hit-low',
  subjects: ['agent', 'model'],
  run: (input) => {
    const totals = input.overview?.analytics.totals;
    if (!totals || totals.totalInputTokens < CACHE_MIN_INPUT_TOKENS) return [];
    const rate = totals.totalCachedInputTokens / totals.totalInputTokens;
    if (rate >= CACHE_RATE_WARN) return [];
    const severity: FindingSeverity = rate < CACHE_RATE_CRITICAL ? 'critical' : 'warn';
    const dynamicPrefix = lintCheck(input, 'dynamic-prefix');
    const causeKnown = dynamicPrefix && dynamicPrefix.status !== 'pass';
    const savings = cacheSavingsUsd(
      totals.totalInputTokens,
      rate,
      dominantPricing(input),
      input.windowDays,
    );
    return [{
      id: 'cache-hit-low',
      detector: 'cache-hit-low',
      category: 'cost',
      severity,
      title: 'Prompt cache barely used',
      summary: `Only ${pct(rate)} of input tokens hit the prompt cache (threshold: ${pct(CACHE_RATE_WARN)}). Cached tokens are billed at a fraction of the input price, so every uncached repeat of the prompt prefix is paid in full.${causeKnown ? ' A likely cause was found: the system prompt prefix contains per-request dynamic content, which invalidates the cache on every call.' : ''}`,
      evidence: [
        { label: 'Input tokens in window', value: fmtInt(totals.totalInputTokens) },
        { label: 'Cached input tokens', value: fmtInt(totals.totalCachedInputTokens) },
        { label: 'Cache hit rate', value: pct(rate) },
        ...(causeKnown ? [{ label: 'Prompt lint', value: dynamicPrefix!.detail }] : []),
      ],
      estMonthlySavingsUsd: savings,
      prescription: {
        action: causeKnown
          ? 'Move dynamic values (dates, IDs, timestamps) out of the prompt prefix — keep the static instruction block first so the provider cache can match it, then re-check this report.'
          : 'Make the prompt prefix stable across calls (static instruction block first, dynamic context last) and enable provider prompt caching if it is off.',
        ctaLabel: 'Open agent analysis',
        ctaHref: input.subject.name
          ? `/dashboard/tracing/agents/${encodeURIComponent(input.subject.name)}`
          : undefined,
      },
      status: 'open',
    }];
  },
};

const dynamicPrefix: Detector = {
  key: 'prompt-prefix-dynamic',
  subjects: ['agent', 'model'],
  run: (input) => {
    const check = lintCheck(input, 'dynamic-prefix');
    if (!check || check.status === 'pass') return [];
    return [{
      id: 'prompt-prefix-dynamic',
      detector: 'prompt-prefix-dynamic',
      category: 'cost',
      severity: check.status === 'fail' ? 'critical' : 'warn',
      title: 'Dynamic content in the prompt prefix (cache killer)',
      summary: 'The first part of the system prompt changes per request. Provider prompt caches match on the exact prefix, so any dynamic value there invalidates the cache for the entire prompt on every call.',
      evidence: [{ label: 'Prompt lint', value: check.detail }],
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Restructure the system prompt: static instructions first, per-request context (dates, user data, IDs) at the end.',
        ctaLabel: 'Open agent analysis',
        ctaHref: input.subject.name
          ? `/dashboard/tracing/agents/${encodeURIComponent(input.subject.name)}`
          : undefined,
      },
      status: 'open',
    }];
  },
};

const promptOversized: Detector = {
  key: 'system-prompt-oversized',
  subjects: ['agent', 'model'],
  run: (input) => {
    const lint = input.overview?.analytics.insights?.promptProfile.lint;
    const check = lint?.checks.find((c) => c.id === 'size');
    if (!lint || !check || check.status === 'pass') return [];
    return [{
      id: 'system-prompt-oversized',
      detector: 'system-prompt-oversized',
      category: 'cost',
      severity: check.status === 'fail' ? 'critical' : 'warn',
      title: 'System prompt over the size budget',
      summary: `The captured system prompt is ~${fmtInt(lint.estTokens)} tokens. It is resent on every model call, so its size multiplies directly into input-token spend.`,
      evidence: [
        { label: 'Estimated tokens', value: fmtInt(lint.estTokens) },
        { label: 'Characters', value: fmtInt(lint.chars) },
        { label: 'Lint verdict', value: check.detail },
      ],
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Trim the prompt: deduplicate repeated instructions, move reference material to retrieval/tools, and target the size budget. Re-run this report after the change to measure the delta.',
      },
      status: 'open',
    }];
  },
};

const contextBloat: Detector = {
  key: 'context-bloat',
  subjects: ['agent', 'model'],
  run: (input) => {
    const avg = input.overview?.analytics.insights?.perCall.avgInputTokensPerAiCall;
    if (typeof avg !== 'number' || avg < CONTEXT_TOKENS_WARN) return [];
    return [{
      id: 'context-bloat',
      detector: 'context-bloat',
      category: 'cost',
      severity: avg >= CONTEXT_TOKENS_CRITICAL ? 'critical' : 'warn',
      title: 'Very large context per model call',
      summary: `Each AI call carries ~${fmtInt(avg)} input tokens on average (threshold: ${fmtInt(CONTEXT_TOKENS_WARN)}). Long-running sessions that accumulate history without compaction grow superlinearly — the last calls of a session cost several times the first.`,
      evidence: [
        { label: 'Avg input tokens / AI call', value: fmtInt(avg) },
        { label: 'Sampled sessions', value: fmtInt(input.overview?.analytics.insights?.sampledSessions ?? 0) },
      ],
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Add history compaction/summarization to the agent loop, cap tool-output size before it re-enters the context, and drop resolved tool results from later turns.',
      },
      status: 'open',
    }];
  },
};

const repeatedToolCalls: Detector = {
  key: 'repeated-tool-calls',
  subjects: ['agent', 'model'],
  run: (input) => {
    const waste = input.overview?.analytics.insights?.waste.repeatedToolCalls;
    if (!waste || waste.callsAnalyzed === 0 || waste.wastedCalls < REPEAT_CALLS_MIN) return [];
    const ratio = waste.wastedCalls / waste.callsAnalyzed;
    if (ratio < REPEAT_RATIO_WARN) return [];
    const top = waste.topOffenders.slice(0, 3);
    return [{
      id: 'repeated-tool-calls',
      detector: 'repeated-tool-calls',
      category: 'performance',
      severity: ratio >= REPEAT_RATIO_CRITICAL ? 'critical' : 'warn',
      title: 'Identical tool calls repeated inside sessions',
      summary: `${fmtInt(waste.wastedCalls)} of ${fmtInt(waste.callsAnalyzed)} analysed tool calls (${pct(ratio)}) repeat an earlier call with identical arguments in the same session — pure latency and token waste.`,
      evidence: top.map((o) => ({
        label: o.tool,
        value: `${fmtInt(o.totalWasted)} wasted calls across ${fmtInt(o.sessionsAffected)} sessions (max ${fmtInt(o.maxRepeatsInOneSession)}× in one session), args: ${o.argsPreview}`,
      })),
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Cache these tool results inside the session (memoize on tool + arguments) or state in the tool description that results stay valid for the session.',
      },
      status: 'open',
    }];
  },
};

const recurringErrors: Detector = {
  key: 'recurring-errors',
  subjects: ['agent', 'model'],
  run: (input) => {
    const patterns = input.overview?.analytics.insights?.errorPatterns ?? [];
    const top = patterns.filter((p) => p.count >= RECURRING_ERROR_MIN).slice(0, 3);
    if (top.length === 0) return [];
    const worst = top[0];
    return [{
      id: 'recurring-errors',
      detector: 'recurring-errors',
      category: 'reliability',
      severity: worst.count >= RECURRING_ERROR_CRITICAL ? 'critical' : 'warn',
      title: 'The same error keeps recurring',
      summary: `The top error signature occurred ${fmtInt(worst.count)} times in the window (last seen ${worst.lastSeen ?? 'unknown'}). A repeating identical signature is a deterministic bug — usually a config or parameter issue — not transient noise.`,
      evidence: top.map((p) => ({
        label: `${fmtInt(p.count)}×`,
        value: p.message,
      })),
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Fix the top signature first: identical repeating errors are usually a broken parameter, revoked credential, or unsupported model option. Every retry of a doomed call is paid twice — once in tokens, once in latency.',
        ctaLabel: 'Open agent sessions',
        ctaHref: input.subject.name
          ? `/dashboard/tracing/agents/${encodeURIComponent(input.subject.name)}`
          : undefined,
      },
      status: 'open',
    }];
  },
};

const sessionErrorRate: Detector = {
  key: 'session-error-rate',
  subjects: ['agent', 'model'],
  run: (input) => {
    const overview = input.overview;
    if (!overview) return [];
    const total = overview.analytics.totals.sessionsCount;
    if (total < 20) return [];
    const errors = overview.analytics.statuses.find((s) => s.status === 'error')?.count ?? 0;
    const rate = errors / total;
    if (rate < SESSION_ERROR_RATE_WARN) return [];
    return [{
      id: 'session-error-rate',
      detector: 'session-error-rate',
      category: 'reliability',
      severity: rate >= SESSION_ERROR_RATE_CRITICAL ? 'critical' : 'warn',
      title: 'Elevated session error rate',
      summary: `${pct(rate)} of sessions ended in error (${fmtInt(errors)} of ${fmtInt(total)}). Note that retries hide failures: the event-level error volume can be far higher than the session-level rate suggests.`,
      evidence: [
        { label: 'Error sessions', value: fmtInt(errors) },
        { label: 'Total sessions', value: fmtInt(total) },
        { label: 'Rate', value: pct(rate) },
      ],
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Cross-check the recurring-error finding for the dominant signature; add an event-level error alert so retry storms cannot mask failures.',
      },
      status: 'open',
    }];
  },
};

const toolErrorHotspot: Detector = {
  key: 'tool-error-hotspot',
  subjects: ['agent', 'model'],
  run: (input) => {
    const items = input.overview?.analytics.tools.items ?? [];
    const hot = items
      .filter((t) => t.totalCalls >= TOOL_ERROR_RATE_MIN_CALLS && t.errorRate >= TOOL_ERROR_RATE_WARN)
      .slice(0, 3);
    if (hot.length === 0) return [];
    return [{
      id: 'tool-error-hotspot',
      detector: 'tool-error-hotspot',
      category: 'reliability',
      severity: hot.some((t) => t.errorRate >= 0.7) ? 'critical' : 'warn',
      title: 'Tools failing at a high rate',
      summary: `${hot.length === 1 ? 'One tool is' : `${hot.length} tools are`} associated with error sessions at ≥${pct(TOOL_ERROR_RATE_WARN)}. Consistently failing tools usually mean broken auth or a dead integration — the agent pays tokens attempting them anyway.`,
      evidence: hot.map((t) => ({
        label: t.toolName,
        value: `${pct(t.errorRate)} error rate over ${fmtInt(t.totalCalls)} sessions`,
      })),
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Re-authenticate or fix the failing integrations; if a tool is intentionally retired, remove it from the agent tool menu so calls stop being attempted.',
      },
      status: 'open',
    }];
  },
};

const menuBloat: Detector = {
  key: 'tool-menu-bloat',
  subjects: ['agent', 'model'],
  run: (input) => {
    const insights = input.overview?.analytics.insights;
    if (!insights?.toolMenu.available) return [];
    const { avgMenuSize, distinctTools } = insights.toolMenu;
    const usedTools = input.overview?.analytics.tools.items.length ?? 0;
    const unused = Math.max(0, distinctTools - usedTools);
    const menuTooBig = typeof avgMenuSize === 'number' && avgMenuSize >= MENU_SIZE_WARN;
    const manyUnused = unused >= MENU_UNUSED_WARN;
    if (!menuTooBig && !manyUnused) return [];
    return [{
      id: 'tool-menu-bloat',
      detector: 'tool-menu-bloat',
      category: 'cost',
      severity: 'warn',
      title: 'Tool menu larger than the agent uses',
      summary: `The agent is offered ${fmtInt(distinctTools)} distinct tools${typeof avgMenuSize === 'number' ? ` (~${avgMenuSize} per call)` : ''} but the window's sessions used ${fmtInt(usedTools)}. Every tool definition is serialized into every model call — unused tools are pure input-token overhead and degrade tool selection.`,
      evidence: [
        { label: 'Distinct tools offered', value: fmtInt(distinctTools) },
        { label: 'Tools actually used', value: fmtInt(usedTools) },
        { label: 'Unused', value: fmtInt(unused) },
        ...(typeof avgMenuSize === 'number' ? [{ label: 'Avg menu size per call', value: String(avgMenuSize) }] : []),
      ],
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Prune tools that this workload never calls, or split the agent so each variant carries only the tools its task needs.',
      },
      status: 'open',
    }];
  },
};

const trafficAnomaly: Detector = {
  key: 'traffic-anomaly',
  subjects: ['agent', 'model'],
  run: (input) => {
    const daily = input.overview?.analytics.daily ?? [];
    const outliers = findOutliers(daily.map((d) => d.sessionsCount), { threshold: TRAFFIC_OUTLIER_Z });
    if (outliers.length === 0) return [];
    const top = outliers.sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 3);
    return [{
      id: 'traffic-anomaly',
      detector: 'traffic-anomaly',
      category: 'hygiene',
      severity: 'warn',
      title: 'Abnormal traffic spike days',
      summary: `${top.length} day(s) in the window deviate massively from this subject's own baseline — a pattern typical of runaway automation or a load loop rather than organic use.`,
      evidence: top.map((o) => ({
        label: daily[o.index]?.date ?? `day ${o.index}`,
        value: `${fmtInt(o.value)} sessions (robust z=${round2(o.z)})`,
      })),
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Identify the caller behind the spike days (machine traffic is usually one client); add a spend/session alert at roughly 2× the daily baseline.',
      },
      status: 'open',
    }];
  },
};

// ── Workspace subject detectors ────────────────────────────────────────────

const spendAnomaly: Detector = {
  key: 'spend-anomaly',
  subjects: ['workspace'],
  run: (input) => {
    const series = input.costReport?.series ?? [];
    const outliers = findOutliers(series.map((b) => b.costUsd), { threshold: SPEND_OUTLIER_Z });
    if (outliers.length === 0) return [];
    const top = outliers.sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 3);
    return [{
      id: 'spend-anomaly',
      detector: 'spend-anomaly',
      category: 'cost',
      severity: 'warn',
      title: 'Anomalous spend days',
      summary: `${top.length} day(s) sit far outside the workspace's own daily-spend baseline.`,
      evidence: top.map((o) => ({
        label: series[o.index]?.bucket ?? `day ${o.index}`,
        value: `$${round2(o.value)} (robust z=${round2(o.z)})`,
      })),
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Attribute the spike days to an agent/model in Cost → Agents, then set a daily spend alert near 2× the baseline median.',
        ctaLabel: 'Open cost by agent',
        ctaHref: '/dashboard/cost/agents',
      },
      status: 'open',
    }];
  },
};

const spendRegimeShift: Detector = {
  key: 'spend-regime-shift',
  subjects: ['workspace'],
  run: (input) => {
    const series = input.costReport?.series ?? [];
    const shift = detectRegimeShift(series.map((b) => b.costUsd));
    if (!shift) return [];
    return [{
      id: 'spend-regime-shift',
      detector: 'spend-regime-shift',
      category: 'cost',
      severity: shift.direction === 'up' ? 'warn' : 'info',
      title: shift.direction === 'up' ? 'Spend has shifted to a higher level' : 'Spend has dropped to a lower level',
      summary: `The last 7 days' median daily spend ($${round2(shift.recentMedian)}) is ${shift.ratio === Number.POSITIVE_INFINITY ? 'far' : `${round2(shift.ratio)}×`} ${shift.direction === 'up' ? 'above' : 'below'} the prior two weeks' median ($${round2(shift.priorMedian)}). A sustained level change means something structural changed — model, traffic source, or a new workload.`,
      evidence: [
        { label: 'Recent 7-day median', value: `$${round2(shift.recentMedian)}/day` },
        { label: 'Prior 14-day median', value: `$${round2(shift.priorMedian)}/day` },
      ],
      estMonthlySavingsUsd: null,
      prescription: {
        action: shift.direction === 'up'
          ? 'Identify what changed (new agent, model switch, traffic source) in Cost → Agents and confirm it is intentional.'
          : 'Confirm the drop is intentional (e.g. a completed migration) — if not, a workload may have silently stopped.',
      },
      status: 'open',
    }];
  },
};

const unpricedUsage: Detector = {
  key: 'unpriced-usage',
  subjects: ['workspace'],
  run: (input) => {
    const observed = input.observedModels;
    if (!observed || observed.totals.unpricedTokens <= 0) return [];
    const share = observed.totals.totalTokens > 0
      ? observed.totals.unpricedTokens / observed.totals.totalTokens
      : 0;
    return [{
      id: 'unpriced-usage',
      detector: 'unpriced-usage',
      category: 'hygiene',
      severity: share >= UNPRICED_SHARE_CRITICAL ? 'critical' : 'warn',
      title: 'Token usage with no price attached',
      summary: `${fmtInt(observed.totals.unpricedTokens)} tokens (${pct(share)} of the window) were recorded against ${fmtInt(observed.totals.unpricedModels)} unpriced model(s). This spend is invisible in every cost report — the blind spot grows with usage.`,
      evidence: observed.entries
        .filter((e) => e.status === 'unpriced')
        .slice(0, 5)
        .map((e) => ({ label: e.modelKey, value: `${fmtInt(e.totalTokens)} tokens` })),
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Assign reference prices from the catalog (Cost → Pricing → Fill from catalog), then reprice to backfill history.',
        ctaLabel: 'Open pricing',
        ctaHref: '/dashboard/cost/pricing',
      },
      status: 'open',
    }];
  },
};

const duplicateModelKeys: Detector = {
  key: 'duplicate-model-keys',
  subjects: ['workspace'],
  run: (input) => {
    const entries = input.observedModels?.entries ?? [];
    const groups = new Map<string, string[]>();
    for (const entry of entries) {
      const norm = normalizeModelName(entry.modelKey);
      if (!norm) continue;
      const list = groups.get(norm) ?? [];
      list.push(entry.modelKey);
      groups.set(norm, list);
    }
    const dupes = [...groups.entries()].filter(([, keys]) => new Set(keys).size > 1).slice(0, 3);
    if (dupes.length === 0) return [];
    return [{
      id: 'duplicate-model-keys',
      detector: 'duplicate-model-keys',
      category: 'hygiene',
      severity: 'warn',
      title: 'Same model recorded under multiple keys',
      summary: 'The same underlying model appears under different usage keys (e.g. a hub entry and a raw traced name). Split keys fragment cost attribution and make optimisation evidence (like parity results) match the wrong records.',
      evidence: dupes.map(([norm, keys]) => ({
        label: norm,
        value: [...new Set(keys)].join('  ·  '),
      })),
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Unify the keys: fix the tracer to emit the canonical model name, or map the raw name to the hub model in pricing.',
        ctaLabel: 'Open pricing',
        ctaHref: '/dashboard/cost/pricing',
      },
      status: 'open',
    }];
  },
};

const premiumTierConcentration: Detector = {
  key: 'premium-tier-concentration',
  subjects: ['workspace'],
  run: (input) => {
    const entries = input.observedModels?.entries ?? [];
    const totalCost = entries.reduce((sum, e) => sum + e.costUsd, 0);
    if (totalCost < PREMIUM_MIN_COST_USD) return [];
    const premiumCost = entries
      .filter((e) => inferModelTier(e.modelName || e.modelKey) >= PREMIUM_TIER)
      .reduce((sum, e) => sum + e.costUsd, 0);
    const share = premiumCost / totalCost;
    if (share < PREMIUM_SHARE_INFO) return [];
    return [{
      id: 'premium-tier-concentration',
      detector: 'premium-tier-concentration',
      category: 'cost',
      severity: 'info',
      title: 'Spend concentrated on premium-tier models',
      summary: `${pct(share)} of priced spend runs on top-tier models. That may be exactly right — but it makes this workspace the best candidate for evidence-based downshift tests. Never switch on price alone: run a parity test first (small models can fail badly on tool-driven workloads).`,
      evidence: [
        { label: 'Premium-tier spend', value: `$${round2(premiumCost)}` },
        { label: 'Total priced spend', value: `$${round2(totalCost)}` },
      ],
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Generate model recommendations and validate any candidate with a parity/matrix run before routing traffic to it.',
        ctaLabel: 'Open recommendations',
        ctaHref: '/dashboard/cost/recommendations',
      },
      status: 'open',
    }];
  },
};

const errorRequestRate: Detector = {
  key: 'error-request-rate',
  subjects: ['workspace'],
  run: (input) => {
    const series = input.costReport?.series ?? [];
    const requests = series.reduce((sum, b) => sum + b.requests, 0);
    const errors = series.reduce((sum, b) => sum + b.errors, 0);
    if (requests < 100 || errors === 0) return [];
    const rate = errors / requests;
    if (rate < ERROR_REQUEST_RATE_WARN) return [];
    return [{
      id: 'error-request-rate',
      detector: 'error-request-rate',
      category: 'reliability',
      severity: rate >= 0.15 ? 'critical' : 'warn',
      title: 'High request error rate across the workspace',
      summary: `${pct(rate)} of ${fmtInt(requests)} model requests errored. Failed requests still consume tokens and latency; a persistent rate at this level usually traces back to one broken agent or model config.`,
      evidence: [
        { label: 'Requests', value: fmtInt(requests) },
        { label: 'Errors', value: fmtInt(errors) },
        { label: 'Rate', value: pct(rate) },
      ],
      estMonthlySavingsUsd: null,
      prescription: {
        action: 'Generate per-agent reports to localize the source — the recurring-error detector will name the exact signature.',
      },
      status: 'open',
    }];
  },
};

const workspaceCacheOpportunity: Detector = {
  key: 'workspace-cache-opportunity',
  subjects: ['workspace'],
  run: (input) => {
    const entries = (input.observedModels?.entries ?? [])
      .filter((e) => e.inputTokens >= CACHE_MIN_INPUT_TOKENS)
      .map((e) => {
        const rate = e.cachedInputTokens / e.inputTokens;
        return {
          entry: e,
          rate,
          savings: cacheSavingsUsd(e.inputTokens, rate, e.pricing, input.windowDays),
        };
      })
      .filter((x) => x.rate < CACHE_RATE_WARN)
      .sort((a, b) => (b.savings ?? 0) - (a.savings ?? 0))
      .slice(0, 3);
    if (entries.length === 0) return [];
    const totalSavings = entries.reduce<number | null>(
      (sum, x) => (x.savings === null ? sum : (sum ?? 0) + x.savings),
      null,
    );
    return [{
      id: 'workspace-cache-opportunity',
      detector: 'workspace-cache-opportunity',
      category: 'cost',
      severity: 'warn',
      title: 'Models with heavy input volume and low cache hit',
      summary: 'These models carry the largest uncached input volume in the workspace — the highest-leverage cache targets. Per-agent reports pinpoint the prompt-level cause for each.',
      evidence: entries.map((x) => ({
        label: x.entry.modelKey,
        value: `${fmtInt(x.entry.inputTokens)} input tokens at ${pct(x.rate)} cache hit${x.savings !== null ? ` → ~$${x.savings}/mo opportunity` : ''}`,
      })),
      estMonthlySavingsUsd: totalSavings !== null ? round2(totalSavings) : null,
      prescription: {
        action: 'Generate agent-level reports for the agents driving these models; the cache-hit and prompt-prefix detectors there give the exact fix.',
      },
      status: 'open',
    }];
  },
};

// ── Registry + runner ──────────────────────────────────────────────────────

export const DETECTORS: Detector[] = [
  // agent / model
  cacheHitLow,
  dynamicPrefix,
  promptOversized,
  contextBloat,
  repeatedToolCalls,
  recurringErrors,
  sessionErrorRate,
  toolErrorHotspot,
  menuBloat,
  trafficAnomaly,
  // workspace
  spendAnomaly,
  spendRegimeShift,
  unpricedUsage,
  duplicateModelKeys,
  premiumTierConcentration,
  errorRequestRate,
  workspaceCacheOpportunity,
];

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, warn: 1, info: 2 };

/**
 * Run every detector applicable to the subject and return findings ordered
 * by severity, then by estimated savings. A single throwing detector must
 * not sink the report — it is skipped (the engine's contract is "best
 * effort over whatever evidence exists").
 */
export function runDetectors(input: DetectorInput): PrescriptionFinding[] {
  const findings: PrescriptionFinding[] = [];
  for (const detector of DETECTORS) {
    if (!detector.subjects.includes(input.subject.kind)) continue;
    try {
      findings.push(...detector.run(input));
    } catch {
      // Defensive: evidence shapes vary across tracer versions.
    }
  }
  return findings.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return (b.estMonthlySavingsUsd ?? 0) - (a.estMonthlySavingsUsd ?? 0);
  });
}
