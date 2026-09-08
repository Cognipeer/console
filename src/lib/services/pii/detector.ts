/**
 * PII detector core.
 *
 * Pure functions — no I/O, no DB access. Given a text and a (built-in + custom)
 * pattern set, return an array of findings, applying:
 *   - regex matching with global semantics
 *   - optional value validation (Luhn, TC kimlik checksum, phone length, …)
 *   - overlap resolution: when two patterns match overlapping ranges, prefer
 *     the higher-severity finding; ties broken by longer match
 *   - replacement string generation via the category's mask strategy
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

import type { PiiLanguage, IPiiCustomPattern, PiiDetectionConfig } from '@/lib/database';
// The regex family's interruptible sweep — a V8 context with a timeout, the
// only thing that can stop a backtracking regex. Custom patterns are
// tenant-authored and run on caller-controlled text, so they get exactly the
// bounds the `regex` family's rules get, from the same implementation.
import {
  DEFAULT_MAX_MATCHES_PER_RULE,
  DEFAULT_MAX_REGEX_INPUT_CHARS,
  DEFAULT_REGEX_BUDGET_MS,
  MAX_REGEX_SOURCE_CHARS,
  execRuleBounded,
} from '@/lib/services/guardrail/families/regex';
import type { PiiFinding, PiiVault } from './types';
import {
  PII_CATEGORIES,
  PII_CATEGORIES_BY_ID,
  filterCategoriesByLanguages,
  categoryLabel,
  type PiiCategoryDefinition,
  type PiiMaskStrategy,
  type PiiSeverity,
} from './categories';
// PII v2 — L2 (dictionary) and L3 (NER) passes, and the confidence
// primitives `detectAsync` uses to fuse their output with L1 (this file's
// regex sweep). `detect()` itself stays untouched control-flow-wise; see
// that function's own comment for exactly what v2 adds to it.
import { CONTEXT_WORDS } from './contextWords';
import { findContextWord, applyContextBoost, noisyOr, type Candidate } from './confidence';
// `scanCustomPhrases` (tenant custom phrase lists via Aho-Corasick) is
// implemented and unit-tested in `dictionary.ts` but not yet wired into
// `DetectorConfig` — see the plan's Faz 1 note on tenant dictionaries.
import { scanDictionary } from './dictionary';
import { runNer, type NerDegradedNote } from './ner';
import { getConfig } from '@/lib/core/config';

const SEVERITY_WEIGHT: Record<PiiSeverity, number> = { low: 1, medium: 2, high: 3 };

// ── Custom-pattern bounds ─────────────────────────────────────────────────

/** Longest custom pattern SOURCE accepted. Same cap as a `regex` family rule:
 *  512 characters bounds how much nesting one pattern can express. */
export const MAX_CUSTOM_PATTERN_SOURCE_CHARS = MAX_REGEX_SOURCE_CHARS;

/**
 * A custom pattern that did not run, or did not run to completion, during one
 * `detect()` call. Surfaced through `withCustomPatternBudget` so the guardrail
 * family can report the policy as degraded instead of silently passing.
 */
export interface CustomPatternSkip {
  patternId: string;
  categoryId: string;
  reason: string;
}

interface CustomPatternReport {
  skipped: CustomPatternSkip[];
  budgetMs: number;
  /** Remaining execution budget shared by every `detect()` call under the report. */
  remainingBudgetMs: number;
}

/**
 * `detect()` is synchronous and is reached through `scanWithPolicy`, which
 * builds the detector config itself — there is no parameter to thread a report
 * through. The report therefore travels on the async context: a caller wraps
 * its scan in `withCustomPatternBudget` and every `detect()` under it, however
 * deep, records into the same report and spends the same budget. Concurrent
 * requests each get their own store, so nothing leaks between them.
 */
const reportStore = new AsyncLocalStorage<CustomPatternReport>();

/**
 * Run `fn` with ONE custom-pattern budget shared by every `detect()` call it
 * makes, and collect what those calls could not finish.
 *
 * Shared, not per call, on purpose: the PII family scans the whole subject
 * once and then every segment whose normalised form differs, so a per-call
 * budget would let a forty-segment tool result buy forty stalls.
 */
export async function withCustomPatternBudget<T>(
  fn: () => Promise<T>,
  budgetMs = DEFAULT_REGEX_BUDGET_MS,
): Promise<{ result: T; skipped: CustomPatternSkip[] }> {
  const report: CustomPatternReport = { skipped: [], budgetMs, remainingBudgetMs: budgetMs };
  const result = await reportStore.run(report, fn);
  return { result, skipped: report.skipped };
}

function customFlags(p: Pick<IPiiCustomPattern, 'flags'>): string {
  return (p.flags ?? '').includes('g') ? (p.flags ?? 'g') : `${p.flags ?? ''}g`;
}

/**
 * Why a custom pattern will be refused at runtime, or null when it will run.
 * Exported for the save path: a pattern rejected here is a pattern `detect()`
 * skips, so a validator built on it rejects exactly what the scan would drop.
 */
export function explainCustomPatternError(
  p: Pick<IPiiCustomPattern, 'pattern' | 'flags'>,
): string | null {
  if (!p.pattern || typeof p.pattern !== 'string') return 'pattern is empty, so it can never fire';
  if (p.pattern.length > MAX_CUSTOM_PATTERN_SOURCE_CHARS) {
    return `pattern source is ${p.pattern.length} characters, over the ${MAX_CUSTOM_PATTERN_SOURCE_CHARS} character limit`;
  }
  try {
    new RegExp(p.pattern, customFlags(p));
    return null;
  } catch (error) {
    return `pattern does not compile: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Configuration consumed by `detect()`. */
export interface DetectorConfig {
  /** Categories enabled: { [categoryId]: true|false }. If omitted, the
   *  `defaultEnabled` flag from the catalog is used. */
  categories?: Record<string, boolean>;
  /** Tenant-defined custom patterns. */
  customPatterns?: IPiiCustomPattern[];
  /** Restrict to these languages. ['global'] always included. */
  languages?: PiiLanguage[];
  /** Locale for labels & messages. */
  locale?: PiiLanguage;
  /**
   * PII v2 — opt-in dictionary/NER layers, only consulted by `detectAsync`.
   * `detect()` (sync) never reads this field: a policy with no `detection`
   * (or `mode: 'pattern'`) behaves byte-for-byte like pre-v2.
   */
  detection?: PiiDetectionConfig;
}

interface CompiledPattern {
  source: 'builtin' | 'custom';
  categoryId: string;
  severity: PiiSeverity;
  regex: RegExp;
  validate?: (value: string) => boolean;
  label: string;
  mask: PiiMaskStrategy;
  /** This category/pattern's own confidence before any context boost — see `categories.ts`'s `PiiCategoryDefinition.baseScore` doc. */
  baseScore: number;
  /** The tenant pattern this came from — present on `source: 'custom'` only,
   *  so a skip can name it. */
  custom?: IPiiCustomPattern;
}

/** Custom patterns have no author-supplied base confidence — approximate one from the severity the tenant picked, the same way a built-in category's baseScore roughly tracks its severity. */
function defaultBaseScoreForSeverity(severity: PiiSeverity): number {
  return severity === 'high' ? 0.7 : severity === 'medium' ? 0.55 : 0.4;
}

function compileBuiltin(
  cat: PiiCategoryDefinition & { pattern: RegExp },
  locale: PiiLanguage,
): CompiledPattern {
  const flags = cat.pattern.flags.includes('g') ? cat.pattern.flags : `${cat.pattern.flags}g`;
  return {
    source: 'builtin',
    categoryId: cat.id,
    severity: cat.severity,
    regex: new RegExp(cat.pattern.source, flags),
    validate: cat.validate,
    label: categoryLabel(cat, locale),
    mask: cat.mask,
    baseScore: cat.baseScore,
  };
}

function compileCustom(
  p: IPiiCustomPattern,
  locale: PiiLanguage,
): CompiledPattern | null {
  if (!p.enabled) return null;
  if (!p.pattern || typeof p.pattern !== 'string') return null;
  // The source cap is enforced HERE, at compile, so that the save path can
  // reject the same pattern by calling `explainCustomPatternError` and the
  // scan refuses it even when a row was written past the validator.
  if (p.pattern.length > MAX_CUSTOM_PATTERN_SOURCE_CHARS) return null;
  let regex: RegExp;
  try {
    regex = new RegExp(p.pattern, customFlags(p));
  } catch {
    return null;
  }
  const severity = p.severity ?? 'medium';
  return {
    source: 'custom',
    categoryId: p.categoryId,
    severity,
    regex,
    label: p.labels?.[locale] ?? p.label,
    mask: { kind: 'fixed', replacement: `[REDACTED_${p.categoryId.toUpperCase()}]` },
    baseScore: defaultBaseScoreForSeverity(severity),
    custom: p,
  };
}

function customAppliesToLanguages(
  p: IPiiCustomPattern,
  langs: PiiLanguage[] | undefined,
): boolean {
  if (!p.languages || p.languages.length === 0) return true; // global
  if (!langs || langs.length === 0) return true;
  return p.languages.some((l) => langs.includes(l));
}

function pickActiveBuiltins(
  config: DetectorConfig,
): PiiCategoryDefinition[] {
  const langFiltered = filterCategoriesByLanguages(config.languages);
  if (!config.categories) {
    return langFiltered.filter((c) => c.defaultEnabled);
  }
  return langFiltered.filter((c) => config.categories?.[c.id] === true);
}

function buildReplacement(value: string, mask: PiiMaskStrategy, categoryId: string): string {
  switch (mask.kind) {
    case 'fixed':
      return mask.replacement;
    case 'keep-edges': {
      const fill = mask.fillChar ?? '*';
      if (value.length <= mask.head + mask.tail) return fill.repeat(value.length);
      const head = value.slice(0, mask.head);
      const tail = mask.tail > 0 ? value.slice(-mask.tail) : '';
      const middle = fill.repeat(Math.max(0, value.length - mask.head - mask.tail));
      return `${head}${middle}${tail}`;
    }
    case 'keep-last': {
      const fill = mask.fillChar ?? '*';
      if (value.length <= mask.tail) return fill.repeat(value.length);
      const tail = value.slice(-mask.tail);
      const middle = fill.repeat(value.length - mask.tail);
      return `${middle}${tail}`;
    }
    case 'keep-domain': {
      const at = value.indexOf('@');
      if (at <= 0) return `[REDACTED_${categoryId.toUpperCase()}]`;
      const local = value.slice(0, at);
      const domain = value.slice(at);
      const masked = local.length <= 1 ? '*' : `${local[0]}${'*'.repeat(Math.max(1, local.length - 1))}`;
      return `${masked}${domain}`;
    }
  }
}

function redactReplacement(categoryId: string): string {
  return `[REDACTED_${categoryId.toUpperCase()}]`;
}

/** Stable-sort findings: lower start first, longer-match wins ties. */
function sortFindings(findings: PiiFinding[]): PiiFinding[] {
  return findings.slice().sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return (b.end - b.start) - (a.end - a.start);
  });
}

/**
 * Drop overlapping findings: when two ranges overlap, keep the one with the
 * higher severity; break ties by length, then by source (builtin > custom).
 */
function resolveOverlaps(findings: PiiFinding[]): PiiFinding[] {
  if (findings.length <= 1) return findings;
  const sorted = sortFindings(findings);
  const out: PiiFinding[] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (!last || f.start >= last.end) {
      out.push(f);
      continue;
    }
    const scoreA = SEVERITY_WEIGHT[last.severity] * 1000 + (last.end - last.start);
    const scoreB = SEVERITY_WEIGHT[f.severity] * 1000 + (f.end - f.start);
    if (scoreB > scoreA) {
      out[out.length - 1] = f;
    }
  }
  return out;
}

/**
 * Detect PII findings in `text` given the supplied config.
 *
 * `actionMode` controls the `replacement` field on each finding:
 *   - 'detect' or undefined → still computes a default replacement (mask preview)
 *   - 'redact' → replacement is a tag like [REDACTED_EMAIL]
 *   - 'mask' → replacement is the partial mask (j***@gmail.com)
 *
 * Use `applyReplacements(text, findings)` to materialize the output.
 */
export function detect(
  text: string,
  config: DetectorConfig = {},
  actionMode: 'detect' | 'redact' | 'mask' | 'block' | 'tokenize' = 'detect',
): PiiFinding[] {
  if (!text) return [];

  const locale: PiiLanguage = config.locale ?? 'en';
  const builtins: CompiledPattern[] = [];
  const customs: CompiledPattern[] = [];
  const report = reportStore.getStore();
  const skip = (p: IPiiCustomPattern, reason: string): void => {
    report?.skipped.push({ patternId: p.id, categoryId: p.categoryId, reason });
  };

  // Built-ins. Categories with no `pattern` (PII v2's `person`/`organization`/
  // `location` — see categories.ts's file header) are dictionary/NER-only and
  // skipped here; `detectAsync` raises them through `scanDictionary`/`runNer`.
  for (const cat of pickActiveBuiltins(config)) {
    if (!cat.pattern) continue;
    builtins.push(compileBuiltin(cat as PiiCategoryDefinition & { pattern: RegExp }, locale));
  }

  // Custom patterns
  for (const p of config.customPatterns ?? []) {
    if (!p.enabled) continue;
    if (!customAppliesToLanguages(p, config.languages)) continue;
    const c = compileCustom(p, locale);
    if (c) {
      customs.push(c);
    } else {
      skip(p, explainCustomPatternError(p) ?? 'pattern does not compile');
    }
  }

  // PII v2: context boost is on by default, off only if a policy explicitly
  // says so. It only ever RAISES `confidence` — a new, additive field — so
  // this has zero effect on which findings `detect()` returns.
  const contextBoostEnabled = config.detection?.contextBoost !== false;

  const raw: PiiFinding[] = [];
  const push = (c: CompiledPattern, value: string, start: number): void => {
    if (c.validate && !c.validate(value)) return;
    const end = start + value.length;
    const replacement = actionMode === 'redact'
      ? redactReplacement(c.categoryId)
      : buildReplacement(value, c.mask, c.categoryId);
    const contextWord = contextBoostEnabled ? findContextWord(text, start, end, CONTEXT_WORDS[c.categoryId]) : null;
    const confidence = applyContextBoost(c.baseScore, !!contextWord);
    const evidence: string[] = [];
    if (c.validate) evidence.push('checksum/format validated');
    if (contextWord) evidence.push(`context word "${contextWord}"`);
    raw.push({
      category: c.categoryId,
      source: c.source,
      severity: c.severity,
      value,
      start,
      end,
      label: c.label,
      message: formatMessage(c.label, locale),
      action: actionMode,
      block: actionMode === 'block',
      replacement,
      confidence,
      detector: 'pattern',
      evidence,
    });
  };

  // Built-in patterns are vetted, fixed and anchored; they sweep on the main
  // thread as they always have.
  for (const c of builtins) {
    c.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = c.regex.exec(text)) !== null) {
      if (m[0].length === 0) {
        // safety against zero-width matches looping forever
        c.regex.lastIndex += 1;
        continue;
      }
      push(c, m[0], m.index);
    }
  }

  // Custom patterns are tenant-authored, so they sweep under the regex family's
  // bound: one execution budget for the whole list (shared across every
  // `detect()` call under a `withCustomPatternBudget`), an input cap, a match
  // cap, and a V8 timeout that can actually interrupt `(a+)+$`. A pattern that
  // cannot finish is dropped and reported — a partial sweep would make the
  // verdict depend on machine speed.
  if (customs.length > 0) {
    if (text.length > DEFAULT_MAX_REGEX_INPUT_CHARS) {
      for (const c of customs) {
        if (c.custom) skip(c.custom, `input of ${text.length} characters is over the ${DEFAULT_MAX_REGEX_INPUT_CHARS} scan limit`);
      }
    } else {
      const budgetMs = report?.budgetMs ?? DEFAULT_REGEX_BUDGET_MS;
      let remainingBudgetMs = report?.remainingBudgetMs ?? budgetMs;
      for (const c of customs) {
        if (remainingBudgetMs <= 0) {
          if (c.custom) skip(c.custom, `not run: the ${budgetMs}ms scan budget was spent by earlier patterns`);
          continue;
        }
        const startedAt = performance.now();
        const swept = execRuleBounded(c.regex, text, undefined, DEFAULT_MAX_MATCHES_PER_RULE, remainingBudgetMs);
        remainingBudgetMs = Math.max(0, remainingBudgetMs - (performance.now() - startedAt));
        if (report) report.remainingBudgetMs = remainingBudgetMs;
        if (swept.timedOut) {
          if (c.custom) {
            skip(
              c.custom,
              `pattern did not finish within the ${budgetMs}ms scan budget on ${text.length} characters — ` +
                'it backtracks catastrophically and must be rewritten (nested quantifiers such as (a+)+ are the usual cause)',
            );
          }
          continue;
        }
        for (const m of swept.matches) push(c, m.whole, m.index);
        if (swept.hitCap && c.custom) {
          skip(c.custom, `stopped after ${DEFAULT_MAX_MATCHES_PER_RULE} matches`);
        }
      }
    }
  }

  const resolved = resolveOverlaps(raw);
  const minConfidence = config.detection?.minConfidence;
  if (!minConfidence || minConfidence <= 0) return resolved; // legacy behaviour: no filtering
  return resolved.filter((f) => (f.confidence ?? 1) >= minConfidence);
}

// ── PII v2 — the L1+L2+L3 fusion entry point ────────────────────────────────

export interface DetectAsyncResult {
  findings: PiiFinding[];
  /** Human-readable notes about anything that didn't run as requested (NER model unavailable, a window timed out, input clipped). Never throws for these unless `detection.ner.failMode === 'closed'`. */
  degraded: string[];
}

function findingToCandidate(f: PiiFinding): Candidate {
  return {
    category: f.category,
    start: f.start,
    end: f.end,
    value: f.value,
    baseScore: f.confidence ?? 0.5,
    detector: 'pattern',
    severity: f.severity,
    label: f.label,
    evidence: f.evidence ?? [],
  };
}

function candidateToFinding(c: Candidate, locale: PiiLanguage, actionMode: 'detect' | 'redact' | 'mask' | 'block' | 'tokenize'): PiiFinding {
  const catDef = PII_CATEGORIES_BY_ID[c.category];
  const mask: PiiMaskStrategy = catDef?.mask ?? { kind: 'fixed', replacement: `[REDACTED_${c.category.toUpperCase()}]` };
  const replacement = actionMode === 'redact' ? redactReplacement(c.category) : buildReplacement(c.value, mask, c.category);
  return {
    category: c.category,
    // Dictionary/NER findings are catalog detections, not tenant customPatterns —
    // 'builtin' is the correct `source` for them the same way it is for a
    // built-in regex category.
    source: 'builtin',
    severity: c.severity,
    value: c.value,
    start: c.start,
    end: c.end,
    label: c.label,
    message: formatMessage(c.label, locale),
    action: actionMode,
    block: actionMode === 'block',
    replacement,
    confidence: Math.round(c.baseScore * 1000) / 1000,
    detector: c.detector,
    evidence: c.evidence,
  };
}

/**
 * Merge every layer's candidates into a final set:
 *   1. SAME-CATEGORY overlaps (multiple detectors independently flagging the
 *      same thing) combine via noisy-OR — two weak-but-independent 0.4
 *      signals compound to ~0.64, clearing a threshold neither alone would.
 *   2. Remaining CROSS-CATEGORY overlaps resolve by highest confidence
 *      (ties: severity, then span length) — the confidence-aware analogue
 *      of `resolveOverlaps` above, used only on this fused path so the pure
 *      pattern path (`detect()`) keeps its original severity-only ordering.
 *   3. `minConfidence` is applied last, once, on the fused score.
 */
export function fuseCandidates(text: string, candidates: Candidate[], minConfidence: number): Candidate[] {
  if (candidates.length === 0) return [];

  const byCategory = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byCategory.get(c.category);
    if (list) list.push(c);
    else byCategory.set(c.category, [c]);
  }

  const merged: Candidate[] = [];
  for (const list of byCategory.values()) {
    const sorted = list.slice().sort((a, b) => (a.start !== b.start ? a.start - b.start : (b.end - b.start) - (a.end - a.start)));
    for (const c of sorted) {
      const last = merged[merged.length - 1];
      if (last && last.category === c.category && c.start < last.end) {
        last.baseScore = noisyOr([last.baseScore, c.baseScore]);
        last.start = Math.min(last.start, c.start);
        last.end = Math.max(last.end, c.end);
        last.value = text.slice(last.start, last.end);
        last.evidence = [...last.evidence, ...c.evidence];
        continue;
      }
      merged.push({ ...c });
    }
  }
  merged.sort((a, b) => a.start - b.start);

  const resolved: Candidate[] = [];
  for (const c of merged) {
    const last = resolved[resolved.length - 1];
    if (last && c.start < last.end) {
      // A span that fully CONTAINS the other is usually the more complete,
      // more useful finding — e.g. `address_tr`'s whole "Kızılay Mahallesi
      // Atatürk Caddesi No:12" vs. a NER `location` hit on just "Kızılay"
      // inside it. Plain confidence comparison used to let the short,
      // often very-high-score NER span silently replace (not merge with —
      // they're different categories, so step 1's noisy-OR never runs)
      // the longer structural match, throwing away the address's street/
      // number half. Prefer the container UNLESS the contained span is
      // substantially (30%+) more confident, which suggests the long span
      // is the spurious one instead (e.g. an overreaching regex match).
      const lastContainsC = last.start <= c.start && last.end >= c.end;
      const cContainsLast = c.start <= last.start && c.end >= last.end;
      if (lastContainsC && last.end - last.start > c.end - c.start) {
        if (c.baseScore > last.baseScore * 1.3) resolved[resolved.length - 1] = c;
        continue;
      }
      if (cContainsLast && c.end - c.start > last.end - last.start) {
        if (last.baseScore <= c.baseScore * 1.3) resolved[resolved.length - 1] = c;
        continue;
      }
      const scoreLast = last.baseScore * 1000 + SEVERITY_WEIGHT[last.severity] * 10;
      const scoreC = c.baseScore * 1000 + SEVERITY_WEIGHT[c.severity] * 10;
      if (scoreC > scoreLast) resolved[resolved.length - 1] = c;
      continue;
    }
    resolved.push(c);
  }

  return resolved.filter((c) => c.baseScore >= minConfidence);
}

/**
 * The opt-in async detection pipeline: runs `detect()` (L1, regex) as
 * always, and — only when `config.detection.mode` asks for it — also runs
 * the L2 dictionary pass and/or the L3 NER pass, fusing all of it into one
 * finding list via `fuseCandidates`.
 *
 * `mode: 'pattern'` (the default) takes a fast path that is EXACTLY
 * `detect()`'s own output: no dictionary scan, no NER, no fusion pass, and
 * therefore no behaviour or performance change over calling `detect()`
 * directly. This is what makes the mode='pattern' arm of the load test a
 * fair baseline rather than a slightly-different code path.
 */
export async function detectAsync(
  text: string,
  config: DetectorConfig = {},
  actionMode: 'detect' | 'redact' | 'mask' | 'block' | 'tokenize' = 'detect',
): Promise<DetectAsyncResult> {
  const mode = config.detection?.mode ?? 'pattern';
  if (mode === 'pattern' || !text) {
    return { findings: detect(text, config, actionMode), degraded: [] };
  }

  const locale: PiiLanguage = config.locale ?? 'en';
  const minConfidence = config.detection?.minConfidence ?? 0;
  const contextBoostEnabled = config.detection?.contextBoost !== false;
  const degraded: string[] = [];

  // Run the pattern layer WITHOUT its own minConfidence filter — a weak
  // pattern hit (e.g. a context-less `tr_vkn`) must still reach fusion so it
  // can be rescued by noisy-OR agreement with a dictionary/NER candidate on
  // the same span, instead of being dropped before fusion ever sees it.
  const patternFindings = detect(text, { ...config, detection: { ...config.detection, minConfidence: 0 } }, actionMode);
  const candidates: Candidate[] = patternFindings.map(findingToCandidate);

  const boost = (c: Candidate): Candidate => {
    if (!contextBoostEnabled) return c;
    const contextWord = findContextWord(text, c.start, c.end, CONTEXT_WORDS[c.category]);
    if (!contextWord) return c;
    return { ...c, baseScore: applyContextBoost(c.baseScore, true), evidence: [...c.evidence, `context word "${contextWord}"`] };
  };

  if (mode === 'pattern+dictionary' || mode === 'pattern+dictionary+ner') {
    for (const c of scanDictionary(text, config.languages)) candidates.push(boost(c));
  }

  if (mode === 'pattern+dictionary+ner') {
    const appConfig = getConfig();
    const nerModelPath = appConfig.pii.nerModelPath;
    const nerOpts = config.detection?.ner ?? {};
    if (!nerModelPath) {
      degraded.push('detection.mode requested NER but PII_NER_MODEL_PATH is not configured — ran pattern+dictionary only');
    } else {
      const nerResult = await runNer(text, {
        nerModelPath,
        models: nerOpts.models,
        maxChars: nerOpts.maxChars,
        timeoutMs: nerOpts.timeoutMs,
        maxConcurrent: appConfig.pii.nerMaxConcurrent,
        failMode: nerOpts.failMode,
      });
      for (const c of nerResult.candidates) candidates.push(boost(c));
      for (const note of nerResult.degraded as NerDegradedNote[]) {
        degraded.push(`ner[${note.modelId}] @${note.windowOffset}: ${note.reason}`);
      }
      if (!nerResult.modelsAvailable) degraded.push('no requested NER model could be loaded from PII_NER_MODEL_PATH');
    }
  }

  const fused = fuseCandidates(text, candidates, minConfidence);
  const findings = fused.map((c) => candidateToFinding(c, locale, actionMode)).sort((a, b) => a.start - b.start);
  return { findings, degraded };
}

const MESSAGE_TEMPLATES: Partial<Record<PiiLanguage, (label: string) => string>> = {
  en: (l) => `${l} detected`,
  tr: (l) => `${l} tespit edildi`,
  de: (l) => `${l} erkannt`,
  fr: (l) => `${l} détecté`,
  es: (l) => `${l} detectado`,
  it: (l) => `${l} rilevato`,
  pt: (l) => `${l} detectado`,
};

function formatMessage(label: string, locale: PiiLanguage): string {
  const fmt = MESSAGE_TEMPLATES[locale] ?? MESSAGE_TEMPLATES.en!;
  return fmt(label);
}

/**
 * Apply the findings' `replacement` field to the original text in a single
 * left-to-right pass. Findings must not overlap (use the output of `detect()`).
 */
export function applyReplacements(text: string, findings: PiiFinding[]): string {
  if (findings.length === 0) return text;
  const sorted = findings.slice().sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const f of sorted) {
    if (f.start < cursor) continue; // safety
    out += text.slice(cursor, f.start);
    out += f.replacement;
    cursor = f.end;
  }
  out += text.slice(cursor);
  return out;
}

// ── Tokenization (reversible masking) ──────────────────────────────────────

/** Token prefix derived from a category id, e.g. 'tr_phone' → 'TR_PHONE'. */
function tokenPrefix(categoryId: string): string {
  const cleaned = categoryId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'PII';
}

/**
 * Replace each finding with a unique, reversible token (e.g. `[EMAIL_1]`) and
 * build a vault mapping token → original value. Deterministic within a call:
 * identical (category, value) pairs map to the same token and share one vault
 * entry, so a phone number that appears twice yields a single `[PHONE_1]`.
 *
 * The returned `findings` carry the assigned token in their `replacement`
 * field; `outputText` is the tokenized text. Pair with `detokenize()` to
 * restore the original values (e.g. after an LLM round-trip).
 */
export function tokenize(
  text: string,
  findings: PiiFinding[],
): { outputText: string; vault: PiiVault; findings: PiiFinding[] } {
  const sorted = findings.slice().sort((a, b) => a.start - b.start);
  const tokenByKey = new Map<string, string>();
  const counters = new Map<string, number>();
  const vault: PiiVault = {};
  const tokenized: PiiFinding[] = [];

  for (const f of sorted) {
    const key = `${f.category} ${f.value}`;
    let token = tokenByKey.get(key);
    if (!token) {
      const prefix = tokenPrefix(f.category);
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      token = `[${prefix}_${n}]`;
      tokenByKey.set(key, token);
      vault[token] = { value: f.value, category: f.category };
    }
    tokenized.push({ ...f, action: 'tokenize', block: false, replacement: token });
  }

  return { outputText: applyReplacements(text, tokenized), vault, findings: tokenized };
}

/**
 * Restore original values in `text` by replacing each vault token with its
 * stored value. Tokens are replaced longest-first to avoid prefix collisions
 * (e.g. `[PHONE_1]` vs `[PHONE_12]`). Unknown tokens are left untouched, so a
 * model that drops or rewrites a token simply leaves that token in place.
 */
export function detokenize(text: string, vault: PiiVault | undefined | null): string {
  if (!text || !vault) return text;
  const tokens = Object.keys(vault).sort((a, b) => b.length - a.length);
  let out = text;
  for (const token of tokens) {
    if (!token) continue;
    out = out.split(token).join(vault[token].value);
  }
  return out;
}

/** Convenience: enumerate built-in catalog ids (used by API). */
export function builtinCategoryIds(): string[] {
  return PII_CATEGORIES.map((c) => c.id);
}

export { PII_CATEGORIES, PII_CATEGORIES_BY_ID };
