/**
 * The `regex` policy family — operator-authored, span-capable, BOUNDED patterns.
 *
 * WHY THIS EXISTS WHEN `word_filter` ALREADY HAS A `regexes` LIST. Two reasons,
 * both structural rather than cosmetic:
 *
 *   1. SPANS. The word filter matches against a folded view of the text (NFKD,
 *      combining marks stripped, runs of single-character tokens joined), so its
 *      offsets do not map back to the raw string and its findings can only ever
 *      propose a `replace_value`. These rules run on the RAW text, which is why
 *      `regex` is in SPAN_CAPABLE.
 *   2. A DECLARED BOUND. Every rule states `maxMatchChars`, and that number is
 *      what sizes the streaming hold-back window: because no eligible pattern
 *      can match a string longer than the withheld tail, no match can begin
 *      before the write frontier and end after it. A rule with no stated bound
 *      makes the whole stream silently unenforceable at window boundaries,
 *      which is why `policyMaxMatchChars` returns 0 — the fail-safe answer — for
 *      any policy containing one, and why the save-time validator refuses to
 *      bind such a policy to `output.stream.delta`.
 *
 * REDOS POSTURE, stated honestly. Patterns here are tenant-authored and run on
 * caller-controlled text, so a catastrophically backtracking rule is a
 * self-inflicted denial of service. JavaScript gives a synchronous matcher no
 * way to interrupt itself, so there is no complete defence available in this
 * process; what there is:
 *   · the pattern SOURCE is capped (a 512-character source bounds how much
 *     nesting an author can express in one rule),
 *   · the scanned STRING is capped, so a pathological rule cannot be pointed at
 *     an arbitrarily large document,
 *   · the MATCH COUNT per rule is capped, which bounds the linear-but-huge case
 *     (a rule matching every character of a megabyte),
 *   · and every one of those caps produces a `skipped` entry that the adapter
 *     turns into a `degraded` verdict entry, so `failMode` decides what happens
 *     instead of the rule quietly not running.
 *   · and, since the load round, a WALL-CLOCK BUDGET per policy, enforced
 *     inside a V8 context because that is the only thing that can interrupt a
 *     regex — see `DEFAULT_REGEX_BUDGET_MS`.
 *
 * That last one is the bound that actually holds. The three caps above all
 * measure something a catastrophic pattern never reaches: measured, `(a+)+$`
 * against 29 characters held the event loop for 10.7 s with `maxMatchChars: 1`
 * set, and an unrelated tenant's request waited 45.4 s behind it. An earlier
 * version of this comment claimed the hole was "addressed at save time" — it
 * was not; `validateGuardrailHooks` accepted four classic catastrophic patterns
 * with zero errors, and a save-time lint remains worth adding as defence in
 * depth rather than as the bound.
 *
 * INVALID PATTERNS ARE SKIPPED, NEVER THROWN. A stored rule that does not
 * compile must not take down an evaluation that other policies are relying on.
 * But it is not swallowed either: the legacy word filter's `catch { continue }`
 * is exactly how a rule ends up dead for a year with a green UI.
 */

import vm from 'node:vm';

import { isMutating, LEGACY_FINDING_TYPE, toLegacyAction } from '../hooks/contract';
import type {
  PolicyFamily,
  GuardrailPolicy,
  HookId,
  HookScope,
  HookSubject,
  Mutation,
  RegexPolicyConfig,
  RegexRule,
  SafetyAction,
  SafetyFinding,
} from '../hooks/contract';
import { normalizeSeverity } from '../types';

// ── Compilation ─────────────────────────────────────────────────────────────

/** Longest pattern SOURCE a rule may declare. See the ReDoS note above. */
export const MAX_REGEX_SOURCE_CHARS = 512;

/** Longest string a rule is pointed at, per scanned segment. Far above any
 *  realistic prompt or tool result, so it bounds pathological work without
 *  firing in normal traffic — and when it does fire the caller is told. */
export const DEFAULT_MAX_REGEX_INPUT_CHARS = 262_144;

/** Matches kept per rule per string before the sweep gives up. */
export const DEFAULT_MAX_MATCHES_PER_RULE = 1_000;

/**
 * WALL-CLOCK BUDGET FOR ONE POLICY'S ENTIRE SWEEP, and the only bound that
 * actually holds against catastrophic backtracking.
 *
 * The three bounds above all measure the WRONG THING for this failure. A load
 * measurement made the gap concrete: with `maxMatchChars: 1` (the strictest
 * value the catalog allows) the pattern `(a+)+$` against a 29-character input
 * held the event loop for 10.7 SECONDS, and an unrelated tenant's request on
 * the same process waited 45.4 s behind it. 29 characters is 0.011% of
 * `DEFAULT_MAX_REGEX_INPUT_CHARS`, so the input bound never came near firing;
 * `maxMatchChars` only ever produced a boolean AFTER a match returned; and
 * `DEFAULT_MAX_MATCHES_PER_RULE` counts successful matches, so an `exec` that
 * never returns never reaches it. For scale: the three rules this product
 * actually ships take p50 1.4 ms on a 262,144-character input — four orders of
 * magnitude under this budget, so it cannot fire in normal traffic.
 *
 * 50 ms mirrors `REGEX_MATCH_TIMEOUT_MS` in `services/models/dynamicRouting.ts`,
 * which solved this same problem for tenant-supplied routing patterns. The
 * budget is PER POLICY rather than per rule on purpose: per-rule, a policy with
 * forty rules would buy two seconds of stall one legal rule at a time.
 */
export const DEFAULT_REGEX_BUDGET_MS = 50;

/**
 * The flags an author may influence. `g` and `d` are added unconditionally
 * (the scanner iterates, and needs capture-group offsets); `y` is refused
 * because a sticky pattern only ever matches at `lastIndex`, which would turn a
 * document scan into a single anchored test — a rule that silently stops
 * finding anything after the first character; `v` is refused because it is
 * mutually exclusive with `u` and changes character-class semantics under an
 * author who almost certainly meant `u`.
 */
const AUTHOR_FLAGS = 'imsu';

interface CompiledRule {
  regex: RegExp;
  rule: RegexRule;
  index: number;
}

/**
 * Compiled patterns are cached because a streamed answer re-scans the same
 * rules once per hold-back window — seventeen windows for a 4K answer at the
 * default 256-character window — and `new RegExp` is the expensive part of a
 * rule that matches nothing. Failures are cached as `null` for the same reason:
 * a broken pattern would otherwise be recompiled and re-thrown every window.
 *
 * The cached objects carry `lastIndex`, which is safe here for the same reason
 * it is safe in the secrets scanner: every sweep resets it first and no sweep
 * can interleave with another, because none of this code awaits.
 */
const COMPILE_CACHE_LIMIT = 512;
const compileCache = new Map<string, RegExp | null>();

function cacheCompiled(key: string, value: RegExp | null): RegExp | null {
  // Insertion-ordered eviction. A precise LRU would need a touch on every read
  // and the working set here is a tenant's rule list, not a hot key space.
  if (compileCache.size >= COMPILE_CACHE_LIMIT) {
    const oldest = compileCache.keys().next();
    if (!oldest.done) compileCache.delete(oldest.value);
  }
  compileCache.set(key, value);
  return value;
}

/**
 * The flags this family will ACTUALLY compile with: the author's, narrowed to
 * `AUTHOR_FLAGS`, plus the two the scanner requires.
 *
 * Shared with `explainRegexRuleError` so a diagnostic describes the same
 * compilation the rule is going to get — a message produced from the author's
 * raw flags would blame, or exonerate, a flag the engine never passes.
 */
function engineFlags(requested: string | undefined): string {
  const wanted = new Set((requested ?? '').split(''));
  return `${[...AUTHOR_FLAGS].filter((flag) => wanted.has(flag)).join('')}gd`;
}

/**
 * Compile one rule, or return null when it cannot be compiled or its source is
 * over the cap. Exported because the save-time validator must reject exactly
 * what this refuses at runtime: a validator that compiles with the author's raw
 * flags accepts a rule that then behaves differently — or not at all — when the
 * engine sanitises them.
 */
export function compileRegexRule(
  rule: RegexRule,
  maxSourceChars = MAX_REGEX_SOURCE_CHARS,
): RegExp | null {
  const source = rule.pattern ?? '';
  if (!source || source.length > maxSourceChars) return null;

  const flags = engineFlags(rule.flags);

  const key = `${flags}\u0000${source}`;
  const cached = compileCache.get(key);
  if (cached !== undefined) return cached;

  try {
    return cacheCompiled(key, new RegExp(source, flags));
  } catch {
    return cacheCompiled(key, null);
  }
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

/**
 * Constructs other regex dialects have and JavaScript does not.
 *
 * Each entry is a HINT appended to the engine's own error, never a verdict of
 * its own: the table is consulted only for a pattern that has ALREADY failed to
 * compile, so a false positive costs a misleading second sentence rather than a
 * rejected rule. Ordered most-specific first for the same reason.
 */
const UNSUPPORTED_CONSTRUCTS: ReadonlyArray<{
  readonly find: RegExp;
  readonly explain: (match: RegExpExecArray) => string;
}> = [
  {
    // `(?i)`, `(?im)`, `(?i:…)`, `(?im-sx:…)`. Not `(?:`, `(?=`, `(?!`, `(?<=`,
    // `(?<!` or a named group `(?<name>…)`: none of those start with a run of
    // flag letters closed by `)` or `:`.
    find: /\(\?([a-zA-Z]+(?:-[a-zA-Z]+)?)[:)]/,
    explain: (match) =>
      `JavaScript has no inline flags — "(?${match[1]})" is parsed as a group, not a mode switch. ${inlineFlagAdvice(match[1])}`,
  },
  {
    find: /\(\?P[<=']/,
    explain: () => 'JavaScript spells a named group "(?<name>…)", without the "P".',
  },
  {
    find: /\(\?>/,
    explain: () =>
      'JavaScript has no atomic groups "(?>…)" — use a non-capturing group "(?:…)".',
  },
  {
    // `a++`, `a*+`, `a?+`, `a{2,}+`. The lookbehind keeps an ESCAPED quantifier
    // (`\*+`, a literal star repeated) out of it.
    find: /(?<!\\)[*+?}]\+/,
    explain: () =>
      'JavaScript has no possessive quantifiers ("a++", "a*+") — use the plain quantifier.',
  },
  {
    find: /\[\[:[a-z]+:\]\]/,
    explain: () =>
      'JavaScript has no POSIX classes ("[[:alpha:]]") — write the class out ("[A-Za-z]"), or use "\\p{Alpha}" with the "u" flag.',
  },
  {
    find: /\\K/,
    explain: () =>
      'JavaScript has no "\\K" — keep the prefix out of the match with a lookbehind "(?<=…)", or capture the part to redact and set the rule\'s captureGroup.',
  },
  {
    find: /\\[AzZ]/,
    explain: () =>
      'JavaScript has no "\\A" / "\\z" / "\\Z" anchors — use "^" and "$", with the "m" flag for per-line anchors.',
  },
];

/** Where the flags in an inline group should have gone instead. `(?im-sx:…)`
 *  only ever ENABLES what precedes the dash; the disabling half has no field to
 *  move to, so it is not offered as advice. */
function inlineFlagAdvice(letters: string): string {
  const enabled = [...new Set((letters.split('-')[0] ?? '').split(''))];
  const supported = enabled.filter((flag) => AUTHOR_FLAGS.includes(flag));
  const unsupported = enabled.filter((flag) => !AUTHOR_FLAGS.includes(flag));

  const advice: string[] = [];
  if (supported.length > 0) {
    advice.push(`Put "${supported.join('')}" in the rule's "flags" field instead.`);
  }
  if (unsupported.length > 0) {
    advice.push(
      `"${unsupported.join('')}" has no JavaScript equivalent — a rule's flags field takes only ${[...AUTHOR_FLAGS].join(', ')}.`,
    );
  }
  return advice.join(' ');
}

/** The engine's own words for why a source/flags pair will not compile, or null
 *  when it does. Deliberately outside the compile cache: this runs on a failure
 *  path, and caching a diagnostic would only make the cache evict live rules. */
function compileError(source: string, flags: string): string | null {
  try {
    new RegExp(source, flags);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Why a rule cannot run, phrased so its author can act on it — or null when it
 * can. The caller supplies the subject ("Regex rule \"card\": ...").
 *
 * "…is not a valid pattern" is true and useless. The most common way to write
 * an uncompilable rule is an INLINE FLAG — `(?i)secret`, which PCRE, Python, Go
 * and Java all accept — and "not valid" sends its author looking at their
 * brackets. So the engine's own message is always included (V8's is specific:
 * `Invalid regular expression: /(?i)secret/gd: Invalid group`) and, when the
 * source carries a construct JavaScript does not have, the sentence says what
 * to write instead.
 *
 * It answers for the compilation the SCANNER performs (`engineFlags`) and,
 * separately, for the flags as the author wrote them — those differ, and a rule
 * whose pattern is fine and whose `flags` field is not would otherwise be
 * reported as a broken pattern, sending its author to rewrite the one part that
 * was already correct.
 *
 * The empty and over-long cases are here too, so this answers the whole of what
 * `compileRegexRule` refuses: a save-time validator built on it rejects exactly
 * what the runtime will skip, which is the contract stated on that function.
 */
export function explainRegexRuleError(
  rule: Pick<RegexRule, 'pattern' | 'flags'>,
  maxSourceChars = MAX_REGEX_SOURCE_CHARS,
): string | null {
  const source = rule.pattern ?? '';
  if (source === '') return 'pattern is empty, so the rule can never fire';
  if (source.length > maxSourceChars) {
    return `pattern source is ${source.length} characters, over the ${maxSourceChars} character limit`;
  }

  const engineError = compileError(source, engineFlags(rule.flags));
  const authorError = compileError(source, rule.flags ?? '');
  if (!engineError && !authorError) return null;

  // The PATTERN compiles and only the author's flag string does not — say so,
  // by name. Reporting this as a bad pattern is how an author ends up rewriting
  // a pattern that was never the problem.
  if (!engineError && authorError) {
    const rejected = [...new Set((rule.flags ?? '').split(''))].filter(
      (flag) => !AUTHOR_FLAGS.includes(flag),
    );
    return rejected.length > 0
      ? `flags "${rejected.join('')}" are not supported — a rule may set only ${[...AUTHOR_FLAGS].join(', ')} ("g" and "d" are added by the engine): ${authorError}`
      : `flags "${rule.flags}" are not valid JavaScript regex flags: ${authorError}`;
  }

  const message = engineError ?? (authorError as string);
  const construct = UNSUPPORTED_CONSTRUCTS.find((entry) => entry.find.test(source));
  if (!construct) return `pattern does not compile: ${message}`;

  // `find` is stateless (no `g`), so re-running it for the match is safe.
  const match = construct.find.exec(source) as RegExpExecArray;
  return `pattern does not compile: ${message}. ${construct.explain(match)}`;
}

// ── The pure scanner ────────────────────────────────────────────────────────

export interface RegexMatch {
  ruleId: string;
  /**
   * Position in the rule list handed to the scanner. The adapter resolves the
   * rule by INDEX, never by id: `RegexRule.id` is author-supplied and nothing
   * enforces that it is unique within a policy, and two rules sharing one id
   * would otherwise attribute the first rule's matches to the second's
   * category, severity and action.
   */
  ruleIndex: number;
  /** Offsets of the REDACTED region — the capture group when the rule names
   *  one, the whole match otherwise. `end` is exclusive. */
  start: number;
  end: number;
  value: string;
  /** Offsets of the whole match, which is what the hold-back has to cover. */
  matchStart: number;
  matchEnd: number;
  /**
   * The whole match is longer than the rule declared it could be. The rule
   * still fired — dropping a real detection because its author mis-measured
   * would be the worse failure — but on a stream it means the hold-back window
   * was sized from a number that is wrong, so some matches WILL be missed at
   * window boundaries. The adapter surfaces it as a distinct finding code.
   */
  overDeclaredBound: boolean;
}

export interface RegexScanOutcome {
  matches: RegexMatch[];
  /** A rule that did not run, or did not run to completion. `ruleId` is absent
   *  when the whole scan was refused. Never silently dropped. */
  skipped: Array<{ ruleId?: string; reason: string }>;
}

export interface ScanRegexOptions {
  maxInputChars?: number;
  maxSourceChars?: number;
  maxMatchesPerRule?: number;
  /**
   * Wall-clock budget for THIS call's whole rule list. Defaults to
   * `DEFAULT_REGEX_BUDGET_MS`. The family passes the remainder of a
   * policy-wide budget so a multi-segment subject cannot buy one budget per
   * segment — a forty-segment tool result would otherwise be forty times the
   * stall this bound exists to prevent.
   */
  budgetMs?: number;
}

/**
 * Extract the region a rule wants redacted. When `captureGroup` names a group
 * that participated in the match, that group's own offsets are used — which is
 * the whole point of the field: `Bearer (\S+)` should redact the token and
 * leave the word "Bearer" so the log stays readable.
 *
 * When the group did NOT participate (an alternation took the other branch),
 * the whole match is used rather than nothing. A match happened and the
 * operator asked for a redaction: redacting more than asked is safe, redacting
 * nothing while reporting a finding is the verdict-without-enforcement failure
 * the contract forbids.
 */
function redactionRegion(
  match: RawMatch,
  captureGroup: number | undefined,
): { start: number; end: number; value: string } {
  const whole = { start: match.index, end: match.index + match.whole.length, value: match.whole };
  if (captureGroup === undefined || captureGroup <= 0) return whole;

  const group = match.groupValue;
  // `groupBounds` is populated because `compileRegexRule` always adds the `d` flag.
  const bounds = match.groupBounds;
  if (typeof group !== 'string' || !bounds) return whole;
  return { start: bounds[0], end: bounds[1], value: group };
}

// ── The bounded sweep ───────────────────────────────────────────────────────
/**
 * One match, flattened out of the `RegExpExecArray` it came from.
 *
 * The sweep runs inside a V8 context (see `execRuleBounded`), so what crosses
 * back is a plain object rather than a live exec array — a match array carries
 * a reference to the regex's realm, and reaching into `.indices` from outside
 * is exactly the kind of cross-realm access that stops working when the inner
 * script is interrupted mid-iteration.
 */
export interface RawMatch {
  index: number;
  whole: string;
  groupValue: string | undefined;
  groupBounds: [number, number] | undefined;
}

/**
 * The sweep, as source, run once per rule inside `SWEEP_CONTEXT`.
 *
 * It has to live inside the context rather than out here because
 * `vm.runInContext`'s `timeout` can only interrupt code the VM is running.
 * Handing it a callback compiled out here would put the backtracking back on
 * the uninterruptible side of the boundary, which is the whole bug.
 *
 * The zero-length-match guard is carried in verbatim from the loop this
 * replaced: a pattern like `\b|x` leaves `lastIndex` where it was, so without
 * the manual advance the sweep spins forever — and now it would spin until the
 * budget killed it, turning an author's harmless typo into a degraded verdict.
 */
const SWEEP_SOURCE = `(() => {
  const out = [];
  const g = __captureGroup;
  __regex.lastIndex = 0;
  let m;
  while ((m = __regex.exec(__text)) !== null) {
    if (m[0].length === 0) { __regex.lastIndex += 1; continue; }
    const bounds = g > 0 && m.indices ? m.indices[g] : undefined;
    out.push({
      index: m.index,
      whole: m[0],
      groupValue: g > 0 ? m[g] : undefined,
      groupBounds: bounds ? [bounds[0], bounds[1]] : undefined,
    });
    if (out.length >= __maxMatches) return { matches: out, hitCap: true };
  }
  return { matches: out, hitCap: false };
})()`;

/**
 * ONE context for the whole process, created on first use.
 *
 * Creating a context costs ~0.7 ms, which is nothing per request and a great
 * deal on the streaming path: a 4K response is ~896 adjudication windows, so a
 * per-sweep context would add ~600 ms of pure setup to a single answer. The
 * context is a bare object with no globals, and every input is written onto it
 * immediately before the run, so nothing an operator's pattern could stash
 * survives to the next sweep in any way that matters.
 */
let sweepContext: vm.Context | undefined;
let sweepScript: vm.Script | undefined;

function sweep(): { context: vm.Context; script: vm.Script } {
  if (!sweepContext) sweepContext = vm.createContext(Object.create(null) as object);
  if (!sweepScript) sweepScript = new vm.Script(SWEEP_SOURCE);
  return { context: sweepContext, script: sweepScript };
}

/**
 * Run one rule to exhaustion, or until `timeoutMs` runs out.
 *
 * `timedOut` is NOT an error and not an empty result: the matches found before
 * the budget expired are dropped, because a partial sweep would report a
 * finding count that depends on machine speed — and a guardrail whose verdict
 * moves with load is worse than one that says plainly it could not finish. The
 * caller turns `timedOut` into a `skipped` entry, which the adapter already
 * routes to `degraded`, which the engine already routes to `failMode`. So an
 * operator running fail-closed still blocks; one running fail-open still gets
 * the finding in the log. Nothing new had to be invented for that path.
 *
 * EXPORTED so the other two tenant-regex paths — `word_filter.regexes` and the
 * PII service's `customPatterns` — run under the same interruptible sweep
 * instead of a bare `exec` on the main thread. The regex handed in MUST carry
 * the `g` flag: the sweep advances by `lastIndex`, and a non-global pattern
 * would return its first match `maxMatches` times.
 */
export function execRuleBounded(
  regex: RegExp,
  text: string,
  captureGroup: number | undefined,
  maxMatches: number,
  timeoutMs: number,
): { matches: RawMatch[]; hitCap: boolean; timedOut: boolean } {
  const { context, script } = sweep();
  const ctx = context as Record<string, unknown>;
  ctx.__regex = regex;
  ctx.__text = text;
  ctx.__captureGroup = captureGroup && captureGroup > 0 ? captureGroup : 0;
  ctx.__maxMatches = maxMatches;

  try {
    const result = script.runInContext(context, { timeout: Math.max(1, Math.ceil(timeoutMs)) }) as {
      matches: RawMatch[];
      hitCap: boolean;
    };
    return { matches: result.matches, hitCap: result.hitCap, timedOut: false };
  } catch {
    // A timeout throws; so would an out-of-memory inside the sweep. Both mean
    // the same thing to the caller — this rule did not produce an answer — and
    // both leave the context poisoned enough that reusing it is not worth the
    // saved millisecond.
    sweepContext = undefined;
    return { matches: [], hitCap: false, timedOut: true };
  } finally {
    // Drop the references either way: `__text` can be a quarter-megabyte
    // string and the context outlives the call.
    ctx.__regex = undefined;
    ctx.__text = undefined;
  }
}

/**
 * Run a rule list over one string. Pure and synchronous; the only state it
 * touches is the compile cache.
 */
export function scanRegexRules(
  text: string,
  rules: readonly RegexRule[],
  options: ScanRegexOptions = {},
): RegexScanOutcome {
  const matches: RegexMatch[] = [];
  const skipped: RegexScanOutcome['skipped'] = [];
  if (!text || rules.length === 0) return { matches, skipped };

  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_REGEX_INPUT_CHARS;
  if (text.length > maxInputChars) {
    skipped.push({ reason: `input of ${text.length} characters is over the ${maxInputChars} scan limit` });
    return { matches, skipped };
  }
  const maxMatches = options.maxMatchesPerRule ?? DEFAULT_MAX_MATCHES_PER_RULE;
  const maxSourceChars = options.maxSourceChars ?? MAX_REGEX_SOURCE_CHARS;

  const compiled: CompiledRule[] = [];
  rules.forEach((rule, index) => {
    const regex = compileRegexRule(rule, maxSourceChars);
    if (!regex) {
      skipped.push({
        ruleId: rule.id || rule.label,
        // WHY, not just THAT: this reason is what the adapter turns into a
        // `degraded` entry, and it is the only thing an operator watching a
        // guardrail fail closed has to go on. `explainRegexRuleError` answers
        // for every case `compileRegexRule` refuses, so the fallback is
        // unreachable — kept only so a future refusal cannot silence this.
        reason: explainRegexRuleError(rule, maxSourceChars) ?? 'pattern does not compile',
      });
      return;
    }
    compiled.push({ regex, rule, index });
  });

  // ONE budget for the whole rule list, spent down as the rules run. Per-rule
  // budgets would multiply: forty legal rules would buy forty times the stall.
  const budgetMs = options.budgetMs ?? DEFAULT_REGEX_BUDGET_MS;
  const startedAt = Date.now();

  for (const { regex, rule, index } of compiled) {
    const declared = Number(rule.maxMatchChars);
    const bound = Number.isFinite(declared) && declared > 0 ? declared : 0;

    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      // A rule that never got to run reports the same way one that timed out
      // does, because the operator's question is the same in both cases: this
      // rule did not answer, so the verdict is incomplete.
      skipped.push({
        ruleId: rule.id || rule.label,
        reason: `not run: the ${budgetMs}ms scan budget was spent by earlier rules`,
      });
      continue;
    }

    const swept = execRuleBounded(regex, text, rule.captureGroup, maxMatches, remaining);

    if (swept.timedOut) {
      // Named as an authoring problem rather than a system fault, because it
      // is one: the pattern is doing exponential work on ordinary input, and
      // the operator is the only person who can change it.
      skipped.push({
        ruleId: rule.id || rule.label,
        reason:
          `pattern did not finish within the ${budgetMs}ms scan budget on ${text.length} characters — ` +
          'it backtracks catastrophically and must be rewritten (nested quantifiers such as (a+)+ are the usual cause)',
      });
      continue;
    }

    for (const match of swept.matches) {
      const region = redactionRegion(match, rule.captureGroup);
      matches.push({
        ruleId: rule.id,
        ruleIndex: index,
        start: region.start,
        end: region.end,
        value: region.value,
        matchStart: match.index,
        matchEnd: match.index + match.whole.length,
        overDeclaredBound: bound > 0 && match.whole.length > bound,
      });
    }

    if (swept.hitCap) {
      skipped.push({
        ruleId: rule.id || rule.label,
        reason: `stopped after ${maxMatches} matches`,
      });
    }
  }

  return { matches, skipped };
}

// ── The family adapter ──────────────────────────────────────────────────────

/**
 * The shape every family adapter conforms to. DECLARED HERE AND IN EVERY OTHER
 * `families/*` MODULE, identically and on purpose: `hooks/contract.ts` is the
 * leaf of the hook plane and describes the call/verdict boundary, not the
 * per-policy one, and nothing may be added to it from here. TypeScript's
 * structural typing makes these interchangeable with the sibling declarations;
 * they all collapse into a shared `families/types.ts` the moment one exists.
 *
 * `action` is the EFFECTIVE action the engine already resolved for this policy
 * (`policy.action ?? record.action`). Families stamp it onto their findings
 * because `GuardrailFinding.action` is a required field — they never choose it,
 * and they never look at the record. The engine folds the decision. A rule's
 * own `action` narrows it, which is config the operator authored on the rule,
 * not a decision this file makes.
 *
 * `scope` is unused by this family and by `secrets`: both are pure, and that is
 * the property the AI App Gateway depends on. It is present so all seven
 * adapters take one argument of one shape.
 */
export interface FamilyRunInput<C extends GuardrailPolicy = GuardrailPolicy> {
  policy: C;
  subject: HookSubject;
  hook: HookId;
  scope: HookScope;
  action: SafetyAction;
}

/** A policy that could not run. `failMode` is applied by the ENGINE, not here. */
export interface FamilyDegradation {
  policyId: string;
  family: PolicyFamily;
  reason: string;
}

export interface FamilyRunResult {
  findings: SafetyFinding[];
  mutations: Mutation[];
  degraded?: FamilyDegradation[];
}

const CODE_MATCH = 'regex_match';
/** The rule fired, but its declared bound is wrong — see RegexMatch. A separate
 *  code rather than a degraded entry: the policy ran, and failing the request
 *  over a mis-declared bound would punish the tenant for a config error that
 *  cost them detection, not enforcement. */
const CODE_MATCH_UNBOUNDED = 'regex_match_unbounded';

export async function runRegexPolicy(
  input: FamilyRunInput<RegexPolicyConfig>,
): Promise<FamilyRunResult> {
  const { policy, subject } = input;
  const findings: SafetyFinding[] = [];
  const mutations: Mutation[] = [];
  if (!policy.enabled) return { findings, mutations };

  const rules = policy.rules ?? [];
  if (rules.length === 0) return { findings, mutations };

  // Idempotent: when the engine has already resolved the effective action this
  // is a no-op, and when a caller passes the record's action it still honours
  // the per-policy override. Either way the family decides nothing.
  const policyAction: SafetyAction = policy.action ?? input.action;

  // A broken rule is broken for every segment, so the reasons are deduplicated:
  // one useless rule on a forty-segment tool result would otherwise produce
  // forty identical degraded entries and forty `failMode` applications.
  const degradedReasons = new Set<string>();

  // ONE budget for the policy, not one per segment. A forty-segment tool result
  // would otherwise be entitled to forty budgets, and the bound would hold for
  // a chat message while doing nothing at all on the path that carries the most
  // attacker-shaped text.
  const policyStartedAt = Date.now();

  for (const segment of subject.segments) {
    const remaining = DEFAULT_REGEX_BUDGET_MS - (Date.now() - policyStartedAt);
    if (remaining <= 0) {
      degradedReasons.add(
        `the ${DEFAULT_REGEX_BUDGET_MS}ms scan budget was spent before every segment could be scanned`,
      );
      break;
    }
    const outcome = scanRegexRules(segment.text, rules, { budgetMs: remaining });
    for (const entry of outcome.skipped) {
      degradedReasons.add(entry.ruleId ? `rule "${entry.ruleId}": ${entry.reason}` : entry.reason);
    }

    // One FINDING per (rule, matched value) in this segment, one MUTATION per
    // occurrence — the same split the secrets family makes, and for the same
    // reason: the log stays proportional to what an operator has to read, while
    // the redaction stays complete.
    const reported = new Set<string>();
    for (const match of outcome.matches) {
      const rule = rules[match.ruleIndex];
      if (!rule) continue;

      const effective: SafetyAction = rule.action ?? policyAction;
      const action = toLegacyAction(effective);

      // PROPOSED only when this rule's effective action is mutating.
      // `HookVerdict.mutations` has no third state between "proposed" and "will
      // be applied", so a rule acting at `flag` that contributed an edit would
      // have it applied the moment the verdict merged with a redacting one.
      if (isMutating(effective)) {
        mutations.push({
          op: 'replace_span',
          path: segment.path,
          start: match.start,
          end: match.end,
          replacement: `[REDACTED:${rule.category}]`,
          family: 'regex',
          policyId: policy.id,
          category: rule.category,
        });
      }

      const dedupKey = `${match.ruleIndex}\u0000${match.value}`;
      if (reported.has(dedupKey)) continue;
      reported.add(dedupKey);
      findings.push({
        type: LEGACY_FINDING_TYPE.regex,
        category: rule.category,
        // Coerced through the shared normaliser: `severity` is typed here but
        // arrives from stored JSON, and the fail-safe default is 'high'.
        severity: normalizeSeverity(rule.severity),
        message: `Content matches the "${rule.label || rule.id}" pattern`,
        action,
        block: action === 'block',
        // Truncated to a two-character hint by `logEvaluation` before it is
        // persisted; it is here so that masking of the stored sample works.
        value: match.value,
        family: 'regex',
        hook: input.hook,
        policyId: policy.id,
        code: match.overDeclaredBound ? CODE_MATCH_UNBOUNDED : CODE_MATCH,
        path: segment.path,
        span: { start: match.start, end: match.end },
      });
    }
  }

  const degraded = [...degradedReasons].map((reason) => ({
    policyId: policy.id,
    family: 'regex' as PolicyFamily,
    reason,
  }));

  return degraded.length > 0 ? { findings, mutations, degraded } : { findings, mutations };
}
