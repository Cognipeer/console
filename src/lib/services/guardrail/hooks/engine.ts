/**
 * THE guardrail hook engine. One `HookCall` in, one `HookVerdict` out; every
 * enforcement point in the console goes through `runHook`.
 *
 * ── EXECUTION ORDER IS NORMATIVE ───────────────────────────────────────────
 * ONE order per hook, and every compatibility claim in this codebase rests on
 * it:
 *
 *   1. The DETERMINISTIC families — pii, secrets, word_filter, regex,
 *      tool_access, and any family this build has never heard of — run
 *      SEQUENTIALLY, in `policies` ARRAY ORDER. Sequential rather than
 *      parallel: they are cheap and local, the budget is re-checked before each
 *      one, and running them in order is what makes the findings list (and
 *      therefore the persisted message) the same on every run of the same
 *      input.
 *   2. "Enabled but no evaluation model" findings, in array order, BEFORE any
 *      LLM result. A family running inside the parallel batch below cannot put
 *      its own finding ahead of that batch, which is why the engine resolves
 *      `llmPolicyModelKey` itself in a pre-pass.
 *   3. The LLM and webhook families are STARTED TOGETHER and awaited with
 *      `Promise.all`, their findings appended in array order. They are the
 *      remote round trips, so they overlap; `Promise.all` preserves input
 *      order, which is what keeps that append deterministic too.
 *
 * `hooks.shortCircuit` (default true) is the one knob on top: a BLOCKING
 * finding from a SYNC policy stops the remaining work — no further
 * deterministic policy, no missing-model pre-pass, no model call. An ASYNC
 * policy never short-circuits, because it has by definition already let the
 * flow continue and so cannot be what stops it. Every legacy-lifted row and the
 * default tool guardrail set `shortCircuit: false` instead, to keep their whole
 * findings array for the audit trail and for the /v1/moderations category map.
 *
 * THE ORDER OF `findings` IS A USER-VISIBLE CONTRACT, not an implementation
 * detail: `logEvaluation` persists `findings[0]?.message` and both
 * `buildUserMessage` copies render from the head of the list. It is kept
 * deterministic BY CONSTRUCTION — phase by phase, and each phase walked in
 * declaration order — rather than by sorting at the end, because a sort would
 * move a missing-model finding out of its documented position ahead of the LLM
 * results and change what an end user is told.
 *
 * The split is not only about ordering. The deterministic findings are the
 * input to the `runIf` gate that decides whether a model call is worth making
 * at all, and the deterministic MUTATIONS are what the webhook family applies
 * to its outgoing body unless the policy sets `redactBeforeSend: false` — so a
 * credential the tenant configured a guardrail to redact is not, by default,
 * then shipped verbatim to a third-party classifier.
 *
 * ── TENANT SCOPE ───────────────────────────────────────────────────────────
 * The whole body runs inside `runWithTenantScope`, never a bare
 * `switchToTenant`: the latter is `enterWith` under the hood
 * (mongodb/base.ts:190-201), whose documented failure mode under concurrency is
 * cross-tenant data leakage — an incident this repo has already had — and hooks
 * are called from SDK, MCP and sandbox frames the console's request ALS does
 * not own. Everything the families do (`scanWithPolicy` and
 * `resolveCustomWordLists` both call `switchToTenant` themselves) is therefore
 * confined to this scope instead of racing the process-global tenant handle.
 *
 * ── MUTATIONS ARE APPLIED ONCE ─────────────────────────────────────────────
 * Families PROPOSE edits; nothing here applies them per policy. Every proposal
 * from every policy of every guardrail is collected, merged, and handed to
 * `applyMutations` in ONE pass over the ORIGINAL subject. Applying per policy
 * would invalidate every later span (each is an absolute offset into the string
 * as its detector saw it); applying per guardrail would mean two guardrails
 * each rewrote a copy of the same original and only one survived — a verdict
 * claiming a redaction it did not deliver.
 *
 * ── decision vs wouldBeDecision ────────────────────────────────────────────
 * `decision` is the EFFECTIVE outcome, already neutralised to 'allow' when the
 * guardrail is not in `enforce` mode, exactly as the enforcement plane this
 * replaces did (aegis/engine.ts:289). Callers therefore need no `enforced`
 * guard of their own, and must not add one — the ported interceptor and MCP
 * bridge have none, so a `decision` that meant "what the policies wanted" would
 * hard-403 every monitor-mode tenant the moment that plane was deleted.
 */

import { fireAndForget } from '@/lib/core/asyncTask';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type { GuardrailAction, GuardrailFailMode } from '@/lib/database';
import { recordUsageEvent, resolveUsageAttribution } from '@/lib/services/usage/usageEvents';

import {
  buildLlmErrorFinding,
  llmPolicyModelKey,
  missingModelMessage,
  runLlmPolicy,
} from '../families/llm';
import type { LlmPolicyConfig } from '../families/llm';
import { runPiiPolicy } from '../families/pii';
import { runRegexPolicy } from '../families/regex';
import { runSecretsPolicy } from '../families/secrets';
import { runToolAccessPolicy } from '../families/toolAccess';
import { runWebhookPolicy } from '../families/webhook';
import { runWordFilterPolicy } from '../families/wordFilter';
import { redactFindings } from '../piiDetector';
import { buildEvaluationErrorFinding } from '../types';
import type { GuardrailFinding } from '../types';

import {
  POLICY_VALID_HOOKS,
  DEFAULT_VERDICT_VISIBILITY,
  DEFERRED_PHASE_FAMILIES,
  GUARDRAIL_CONTRACT_VERSION,
  LEGACY_FINDING_TYPE,
  STREAM_ELIGIBLE_FAMILIES,
  allowVerdict,
  foldActions,
  mergeVerdicts,
  readPolicyList,
  toGuardrailMode,
  toLegacyAction,
} from './contract';
import type {
  PolicyFamily,
  GuardrailPolicy,
  HookBinding,
  HookSchedule,
  GuardrailHooksConfig,
  HookCall,
  HookId,
  HookScope,
  HookSubject,
  HookVerdict,
  IGuardrailV2,
  Mutation,
  RenderedBlockMessage,
  RegexPolicyConfig,
  SafetyAction,
  SafetyFinding,
  SideEffect,
  ToolAccessPolicyConfig,
} from './contract';
import { ensureHooks, ensureLiftedPiiPolicy } from './legacy';
import { BLOCK_REASON_FOR_FAMILY, resolveBlockMessage } from './messages';
import { applyMutations } from './mutations';
import { getCachedGuardrail, invalidateGuardrailCache } from './recordCache';

const logger = createLogger('guardrail-engine');

// `mergeVerdicts` is implemented in ./contract — it needs nothing but the action
// ladder and the verdict shape, and that file is the acyclic leaf of `hooks/`.
// It is re-exported here because the engine is where callers look for it, and
// because a second implementation would be a second place the fold rule drifts.
export { mergeVerdicts };

// ═══════════════════════════════════════════════════════════════════════════
// Dispatch tables
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Families that build their OWN `failMode` finding alongside a degraded entry.
 *
 * THIS TABLE EXISTS TO PREVENT A DOUBLE-APPLY. The deterministic adapters
 * document that "the ENGINE applies failMode" and return a bare entry; the LLM
 * and webhook adapters emit the finding themselves, because only they can tell
 * a timeout from a rejection from a missing model. Synthesising a second
 * finding for those would put a duplicate at the head of the findings list —
 * and the head is what the evaluation log persists as the row's `message`.
 */
const SELF_FAILMODE_FAMILIES: ReadonlySet<PolicyFamily> = new Set<PolicyFamily>([
  'moderation',
  'prompt_shield',
  'custom',
  'webhook',
]);

/**
 * Risk contribution per finding, carried over verbatim from the enforcement
 * plane (aegis/engine.ts:285) so a migrated policy's risk scores, alert
 * thresholds and dashboards keep meaning the same thing. `critical` is a flag
 * here rather than a fourth severity — widening `GuardrailFinding.severity`
 * would break the moderation API's `Record<severity, number>` and both
 * providers' severity aggregations — so it scores as the level it replaced.
 */
const SEVERITY_RISK: Readonly<Record<GuardrailFinding['severity'], number>> = {
  low: 5,
  medium: 15,
  high: 35,
};
const CRITICAL_RISK = 70;

/** Same cap and the same masking budget as `guardrailService.ts:199`. */
const LOGGED_INPUT_MAX_CHARS = 1500;

// ═══════════════════════════════════════════════════════════════════════════
// Contract guard
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The enforcement plane's one-line contract guard, carried over verbatim
 * (aegis/engine.ts:204). An ABSENT version is accepted — an in-process caller
 * that omits the field is making no claim about the wire shape — while a
 * PRESENT mismatch is refused rather than reinterpreted, because a caller
 * speaking a different contract is far more likely to be sending a differently
 * shaped subject than to be a harmless version skew.
 */
export function assertContractVersion(v: unknown): void {
  if (v !== undefined && v !== null && v !== GUARDRAIL_CONTRACT_VERSION) {
    throw new Error('unsupported-contract-version');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Record resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve a guardrail by key, PROJECT FIRST AND THEN TENANT-WIDE.
 *
 * The fallback is not a convenience: `findGuardrailByKey` with a project emits
 * `projectId = @projectId`, a predicate that EXCLUDES NULL, so a tenant-level
 * guardrail is invisible to every project-scoped caller. Without the second
 * lookup a workspace-wide guardrail referenced from a project simply reports
 * "not found" — and the legacy facade turns that into a thrown error and a
 * 404. This mirrors the precedent `resolveCustomWordLists` set for the same
 * reason (wordListService.ts).
 *
 * THE FALLBACK PASSES `null`, NOT `undefined`, and the difference is the whole
 * point: `undefined` means "no project clause" and answers with the first row
 * of ANY project, while keys are only unique per project. Project A binding
 * key `k` after its own row was deleted would then be evaluated against
 * project B's `k` — B's webhook receiving A's content, B's block messages, the
 * evaluation-log row written under B's projectId. `null` is the provider
 * contract's spelling for "the row no project owns", which is the only row a
 * fallback is entitled to.
 *
 * Both lookups are cached, misses included, so the fallback costs one extra
 * round trip per minute rather than one per request.
 */
export async function resolveGuardrail(
  tenantDbName: string,
  key: string,
  projectId?: string,
): Promise<IGuardrailV2 | null> {
  const scoped = await getCachedGuardrail(tenantDbName, key, projectId);
  if (scoped) return scoped;
  if (projectId === undefined) return null;
  return getCachedGuardrail(tenantDbName, key, null);
}

// ═══════════════════════════════════════════════════════════════════════════
// The default tool-safety guardrail
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pinned to this literal and NEVER routed through `generateUniqueSlugKey`,
 * which would silently produce 'tool-safety-default-1' on a collision — and a
 * default nobody can name by key is a default nothing binds to.
 */
export const DEFAULT_TOOL_GUARDRAIL_KEY = 'tool-safety-default';

/**
 * The side-effect classification of the sandbox toolbox, copied VERBATIM from
 * the enforcement plane's `BASELINE_SIDE_EFFECTS` (aegis/store.ts:46-52).
 *
 * Inlined rather than imported because that module lives in the enterprise
 * overlay and is being deleted — and because this table IS the reason the
 * default guardrail exists: without it every sandbox tool is unclassified, and
 * an unclassified tool resolves to `defaultSideEffect` ('read'), i.e. to no
 * finding at all.
 */
const BASELINE_SIDE_EFFECTS: Readonly<Record<string, SideEffect>> = {
  'sandbox.fs.list': 'read',
  'sandbox.fs.info': 'read',
  'sandbox.fs.read': 'read',
  'sandbox.fs.find': 'read',
  'sandbox.fs.write': 'write',
  'sandbox.fs.delete': 'destructive',
  'sandbox.fs.replace': 'write',
  'sandbox.fs.move': 'write',
  'sandbox.fs.permissions': 'write',
  'sandbox.fs.mkdir': 'write',
  'sandbox.git.status': 'read',
  'sandbox.git.branches': 'read',
  'sandbox.git.log': 'read',
  'sandbox.git.branch': 'write',
  'sandbox.git.branch.delete': 'write',
  'sandbox.git.checkout': 'write',
  'sandbox.git.add': 'write',
  'sandbox.git.commit': 'write',
  'sandbox.git.push': 'external',
  'sandbox.git.clone': 'external',
  'sandbox.git.pull': 'external',
  'sandbox.sessions': 'write',
  'sandbox.sessions.exec': 'external',
};

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

/**
 * A policy's timing, falling back to the hook's binding and then to sync.
 *
 * `GuardrailPolicyBase.schedule` is typed as REQUIRED, and every policy the
 * legacy lift produces has one — but the write path never enforced it, so an
 * authored `hooks` config posted to the API without a per-policy `schedule`
 * persists happily and then reaches here as `undefined`. Reading `.timing` off
 * it threw, which surfaced as a 500 on every evaluation of that guardrail:
 * a caller treating 5xx as retryable then fails closed, so an authored
 * tool-hook config blocked every tool call and blamed the transport.
 *
 * The fallback is not merely defensive — it is the right semantics. A policy's
 * schedule is an OVERRIDE of the hook's, exactly as `action` overrides the
 * record's, so a policy that declares none should inherit rather than invent
 * one. `plugins/guardrails.ts` now fills it in at write time as well; this
 * keeps already-persisted records working without a migration.
 */
export function policyTiming(
  policy: GuardrailPolicy,
  binding: HookBinding | undefined,
): HookSchedule['timing'] {
  return (policy.schedule ?? binding?.schedule ?? SYNC_BLOCK).timing;
}

/**
 * The three PII patterns the enforcement plane's DLP layer actually redacted
 * (aegis/engine.ts:17-21), reproduced as `regex` rules so the default protects
 * something the moment it is created, with no PII policy to provision first.
 *
 * Every rule declares `maxMatchChars`: an undeclared bound makes the whole
 * policy unbounded, and an unbounded policy can never be bound to a stream later
 * without silently breaking the hold-back guarantee.
 */
function dlpPiiRules(emailAction: SafetyAction): RegexPolicyConfig['rules'] {
  return [
    {
      id: 'iban-tr',
      label: 'Turkish IBAN',
      pattern: '\\bTR\\d{2}[0-9A-Z]{20}\\b',
      flags: 'g',
      category: 'iban',
      severity: 'medium',
      action: 'redact',
      maxMatchChars: 32,
    },
    {
      id: 'tckn',
      label: 'Turkish national id',
      pattern: '\\b[1-9]\\d{10}\\b',
      flags: 'g',
      category: 'tckn',
      severity: 'medium',
      action: 'redact',
      maxMatchChars: 16,
    },
    {
      id: 'email',
      label: 'Email address',
      pattern: '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b',
      flags: 'gi',
      category: 'email',
      // The enforcement plane scored a flag-only email 'low' and a redacted one
      // 'medium'; keeping that keeps migrated risk scores comparable.
      severity: emailAction === 'redact' ? 'medium' : 'low',
      action: emailAction,
      // 320 = RFC 5321's 64-character local part + '@' + a 255-character domain.
      maxMatchChars: 320,
    },
  ];
}

function defaultToolGuardrailHooks(): GuardrailHooksConfig {
  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    policies: [
      {
        id: 'tool-policy',
        family: 'tool_access',
        enabled: true,
        hooks: ['tool.pre', 'tool.post'],
        schedule: SYNC_BLOCK,
        label: 'Tool side effects',
        sideEffects: { ...BASELINE_SIDE_EFFECTS },
      },
      {
        // Vendor patterns only. The generic high-entropy heuristic is
        // deliberately OFF: it fires on any 32+ character base64 run, and this
        // guardrail sits in front of `sandbox.fs.write`, so enabling it would
        // redact ordinary file payloads and break the toolbox it exists to
        // protect. The enforcement plane's own secret pattern required a
        // `key:`/`token:` prefix and was likewise narrow.
        id: 'dlp-secrets',
        family: 'secrets',
        enabled: true,
        hooks: ['tool.pre', 'tool.post'],
        schedule: SYNC_BLOCK,
        action: 'redact',
        label: 'Credential redaction',
        known: true,
        genericHighEntropy: false,
      },
      {
        // Two policies rather than one ONLY because the behaviour being
        // reproduced is stage-dependent: the enforcement plane FLAGGED an email
        // in tool arguments and REDACTED one in a tool result
        // (`flagOnly = code === 'email_detected' && stage === 'tool.pre'`).
        id: 'dlp-pii-pre',
        family: 'regex',
        enabled: true,
        hooks: ['tool.pre'],
        schedule: SYNC_BLOCK,
        action: 'redact',
        label: 'Sensitive values in tool arguments',
        rules: dlpPiiRules('flag'),
      },
      {
        id: 'dlp-pii-post',
        family: 'regex',
        enabled: true,
        hooks: ['tool.post'],
        schedule: SYNC_BLOCK,
        action: 'redact',
        label: 'Sensitive values in tool results',
        rules: dlpPiiRules('redact'),
      },
    ],
    bindings: {
      'tool.pre': { enabled: true, schedule: SYNC_BLOCK },
      'tool.post': { enabled: true, schedule: SYNC_BLOCK },
    },
    stream: { enabled: false },
    // Every finding matters here: the audit trail for a denied tool call is the
    // only record of what the model tried to do.
    shortCircuit: false,
  };
}

/**
 * Materialise (once, idempotently) the tenant-level guardrail the sandbox
 * toolbox and the MCP gateway fall back to when no key is named.
 *
 * WITHOUT THIS, DELETING THE ENFORCEMENT PLANE SILENTLY DISARMS THE TOOLBOX.
 * Its call site (client-sandbox-toolbox.ts:72-79) passes NO shield id and
 * depended entirely on a lazily-created `default` shield existing
 * (aegis/store.ts:54-63: `mode:'enforce'`, `BASELINE_SIDE_EFFECTS`, DLP on).
 * All three properties are reproduced above.
 *
 * `action: 'block'` is REQUIRED, not a stylistic default. The enforcement plane
 * blocked on its five `severity: 'critical'` findings regardless of any
 * configured action; the community model routes that decision through the
 * guardrail's own action instead, so a default created with 'flag' or 'warn'
 * would evaluate everything and enforce nothing.
 */
export async function ensureDefaultToolGuardrail(
  tenantDbName: string,
  tenantId: string,
): Promise<IGuardrailV2> {
  // `null`: the TENANT-WIDE row only. With no project clause this lookup would
  // answer with a project-scoped guardrail that happens to carry the pinned key
  // — an operator naming one "Tool safety (default)" in project P (the service
  // now refuses that key, but rows written before it did exist) — and the
  // tenant-wide default would never be materialised: every unbound tool call
  // in the tenant would run against P's row, disabled or not.
  const existing = await getCachedGuardrail(tenantDbName, DEFAULT_TOOL_GUARDRAIL_KEY, null);
  if (existing) return withDefaultHooks(existing);

  try {
    const created = await runWithTenantScope(tenantDbName, (db) =>
      db.createGuardrail({
        tenantId,
        // Tenant-level on purpose: the toolbox and the MCP gateway have a
        // tenant and frequently no project, and `resolveGuardrail`'s project ->
        // tenant fallback is what makes this one row reachable from everywhere.
        projectId: undefined,
        key: DEFAULT_TOOL_GUARDRAIL_KEY,
        name: 'Tool safety (default)',
        description:
          'Built-in guardrail: enforced for tool calls that do not name a guardrail of their own (the sandbox toolbox, MCP servers with no binding).',
        type: 'preset',
        // Legacy column. Direction comes from the hook that fired, never from
        // `target`; it is written only because the column is NOT NULL.
        target: 'input',
        action: 'block',
        enabled: true,
        // Fail OPEN. A tool policy that blocks every call whenever an evaluator
        // hiccups takes the whole sandbox down with it, and the deterministic
        // policies that actually enforce this guardrail cannot fail that way.
        failMode: 'open',
        mode: 'enforce',
        // 1, not 0: this config is AUTHORED. A 0 would make `ensureHooks`
        // re-derive it from the (absent) legacy `policy` on every read, and the
        // guardrail would evaluate nothing.
        hooksVersion: 1,
        hooks: defaultToolGuardrailHooks(),
        metadata: { managed: 'guardrail-hook-plane', purpose: 'tool-safety-default' },
        createdBy: 'system',
      }),
    );
    invalidateGuardrailCache(tenantDbName, DEFAULT_TOOL_GUARDRAIL_KEY);
    return withDefaultHooks(created);
  } catch (error) {
    // Two concurrent tool calls on a cold tenant both reach the create. The
    // loser gets a duplicate-key error and must read the winner's row rather
    // than fail a tool call over a race it caused itself.
    invalidateGuardrailCache(tenantDbName, DEFAULT_TOOL_GUARDRAIL_KEY);
    const raced = await getCachedGuardrail(tenantDbName, DEFAULT_TOOL_GUARDRAIL_KEY, null);
    if (raced) return withDefaultHooks(raced);
    throw error;
  }
}

/**
 * Guarantees the returned record carries the default hooks even when the row
 * came back without them.
 *
 * Not defensive padding — this is the specific silent failure the migration
 * notes call out: the guardrail INSERT is a hand-maintained column list, so a
 * build whose SQLite mixin has not learned about `hooks`/`hooksVersion` writes
 * the row, returns it, and drops those two columns on the floor, while the same
 * config saves fine on Mongo. The result would be a default tool guardrail that
 * exists, looks configured and enforces nothing — exactly the disarm this
 * function exists to prevent — so the mismatch is logged loudly and the
 * in-memory config is used for the life of the process.
 */
function withDefaultHooks(record: IGuardrailV2): IGuardrailV2 {
  // Through `readPolicyList`, NOT `record.hooks.policies`. This row is created
  // once per tenant and then read forever, so most of them on disk predate the
  // `check` -> `policy` rename and store `hooks.checks`. Reading only the new
  // spelling here made a perfectly healthy row look empty, and the branch below
  // is not a no-op: it DISCARDS the operator's stored configuration for the life
  // of the process and forces `mode: 'enforce'` — so a default tool guardrail
  // someone had turned down to `monitor` silently started blocking tool calls
  // on upgrade, while logging a persistence bug that had not happened.
  const policies = readPolicyList(record.hooks);
  if ((record.hooksVersion ?? 0) >= 1 && policies?.length) return record;
  logger.error('Default tool guardrail persisted without its hook config', {
    guardrailKey: record.key,
    hooksVersion: record.hooksVersion ?? 0,
    policyCount: policies?.length ?? 0,
    hint: 'the guardrail INSERT/UPDATE column whitelist is missing hooks/hooksVersion',
  });
  return { ...record, hooks: defaultToolGuardrailHooks(), hooksVersion: 1, mode: 'enforce' };
}

// ═══════════════════════════════════════════════════════════════════════════
// runHook
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What every family adapter hands back.
 *
 * The two optional members are additive over the deterministic families' own
 * result type: `gated` (a `runIf` that was not met — a healthy guardrail saving
 * money, which must NOT be folded into `degraded`, an outage) and `riskScore`
 * (a webhook classifier's primary output, which has nowhere else to go).
 */
interface FamilyOutcome {
  findings: SafetyFinding[];
  mutations: Mutation[];
  degraded?: Array<{ policyId: string; family: PolicyFamily; reason: string }>;
  gated?: Array<{ policyId: string; family: PolicyFamily; reason: string }>;
  riskScore?: number;
  /**
   * ENGINE-INTERNAL, never set by a family: the dispatcher already built the
   * `failMode` finding for these degraded entries, so `collect` must not build
   * a second one. Set only by `dispatchPolicy`'s throw backstop, where the
   * family never got the chance to apply its own fail mode — and where relying
   * on SELF_FAILMODE_FAMILIES instead would silently produce NO finding at all
   * for a moderation or webhook policy that threw, i.e. a fail-closed guardrail
   * that passes content whenever its evaluator crashes.
   */
  failModeApplied?: boolean;
}

/** Everything a dispatch needs that is not the policy itself. Assembled once per
 *  guardrail so `dispatchPolicy` never reaches back into the record. */
interface RunContext<S extends HookSubject> {
  call: HookCall<S>;
  record: IGuardrailV2;
  /** `binding.failMode ?? record.failMode`; a policy's own still wins. */
  failMode: GuardrailFailMode | undefined;
  startedAt: number;
  /** Enabled `tool_access` policies, for the LLM families' `onSideEffect` gate. */
  toolAccess: ToolAccessPolicyConfig[];
}

export async function runHook<S extends HookSubject>(call: HookCall<S>): Promise<HookVerdict<S>> {
  assertContractVersion(call.contractVersion);

  const startedAt = Date.now();
  const { hook, scope, subject } = call;

  // Duplicate keys are a configuration accident (a project guardrail listed
  // twice, or the same key reaching a tool through two bindings) and would
  // otherwise double every finding and double-bill the evaluation.
  const keys = [...new Set(call.guardrailKeys.filter((key) => Boolean(key)))];
  if (keys.length === 0) {
    return allowVerdict<S>({ hook, traceId: scope.traceId, latencyMs: 0 });
  }

  return runWithTenantScope(scope.tenantDbName, async () => {
    // Guardrails are INDEPENDENT policies over the same subject, so they run
    // concurrently — `mergeVerdicts` folds latency with max() rather than a sum
    // for exactly this reason. `Promise.all` preserves input order, which is
    // what keeps the merged findings array deterministic.
    const verdicts = await Promise.all(
      keys.map((key) => evaluateGuardrailHook<S>(call, key, startedAt)),
    );

    const merged = mergeVerdicts<S>(hook, verdicts);

    // ── the ONE application pass ──
    // No individual verdict carries a rewritten subject, so this is reached by
    // the same path for one guardrail and for many. Every span in the list is
    // an absolute offset into the ORIGINAL subject, which is the only string
    // they are all valid against.
    if (merged.mutations.length > 0) {
      const outcome = applyMutations(subject, merged.mutations);
      if (outcome.applied.length > 0) {
        merged.subject = outcome.subject;
        merged.text = outcome.text;
      }
      if (outcome.skipped.length > 0) {
        // A proposal that did not land is logged rather than dropped. The
        // verdict keeps its findings (something WAS detected) but does not
        // claim a rewrite it could not deliver, so this log line is the only
        // place the gap is visible.
        logger.warn('Guardrail redactions could not be applied', {
          hook,
          traceId: scope.traceId,
          guardrailKeys: merged.guardrailKeys,
          skipped: outcome.skipped.map((entry) => ({
            op: entry.mutation.op,
            path: 'path' in entry.mutation ? entry.mutation.path : undefined,
            family: entry.mutation.family,
            reason: entry.reason,
          })),
        });
      }
    }

    merged.latencyMs = Date.now() - startedAt;
    return merged;
  });
}

/**
 * One guardrail, one hook.
 *
 * NEVER THROWS. An unresolvable record, a broken policy or a family that breaks
 * its own no-throw promise all degrade into a verdict: a hook that throws takes
 * the caller's request down with it, and the caller is a chat completion, a
 * tool call or an agent turn.
 */
async function evaluateGuardrailHook<S extends HookSubject>(
  call: HookCall<S>,
  key: string,
  startedAt: number,
): Promise<HookVerdict<S>> {
  const { hook, scope, subject } = call;
  const record = await resolveGuardrail(scope.tenantDbName, key, scope.projectId);

  if (!record) {
    // NOT a throw. The legacy facade does its own lookup and throws
    // `Guardrail with key "x" not found` (which plugins/guardrails.ts maps to a
    // 404), but the tool and MCP paths must not lose a call to a stale binding
    // — a deleted guardrail is a configuration problem, not a request error.
    logger.warn('Guardrail not found for hook', {
      hook,
      guardrailKey: key,
      traceId: scope.traceId,
    });
    return allowVerdict<S>({
      hook,
      traceId: scope.traceId,
      guardrailKeys: [key],
      guardrailKey: key,
      latencyMs: Date.now() - startedAt,
    });
  }

  const mode = toGuardrailMode(record.mode, record.enabled);
  const base = {
    hook,
    mode,
    guardrailKey: record.key,
    guardrailName: record.name,
    policyVersion: policyVersionOf(record),
    traceId: scope.traceId,
    startedAt,
  };

  if (mode === 'disabled') return vacuousVerdict<S>(base);

  // The lifted `pii` policy points at the deterministic key
  // `pii-migrated-<guardrailKey>` whether or not provisioning has succeeded, so
  // this has to run BEFORE `ensureHooks` for that policy to reference a PII
  // policy that exists. It is memoised (60s success / 5s failure) and returns
  // immediately when the record has no legacy PII policy, so the steady state
  // is free — and it is skipped entirely for an AUTHORED config, which has no
  // legacy columns to lift.
  // `readPolicyList`, so this gate asks the same question `ensureHooks` asks two
  // lines below (which normalises first). Reading only `hooks.policies` off the
  // raw record made every PRE-RENAME authored row — `hooks.checks` on disk —
  // look unauthored, and the false branch is a tenant WRITE: `ensureLiftedPiiPolicy`
  // creates a `pii-migrated-<key>` PII policy from the legacy `policy.pii` blob
  // that the downward projection keeps populated on every authored save. The
  // lifted key is then discarded (`ensureHooks` correctly takes its authored
  // branch), so the only trace was a phantom PII policy appearing in the
  // customer's list, plus a DB round trip on the hook path.
  const authored = (record.hooksVersion ?? 0) >= 1 && readPolicyList(record.hooks) !== undefined;
  const piiPolicyKey = authored
    ? undefined
    : ((await ensureLiftedPiiPolicy(scope.tenantDbName, record.tenantId, record).catch(
        () => null,
      )) ?? undefined);

  const { hooks } = ensureHooks(record, piiPolicyKey);

  // A hook runs IFF its binding is enabled AND an enabled policy names it. The
  // downward projection derives the legacy `target` column from that same rule
  // and the save-time validator rejects an enabled policy whose hook has no
  // enabled binding, so treating a MISSING binding as "run" here would make the
  // three disagree.
  const binding = hooks.bindings?.[hook];
  if (!binding?.enabled) return vacuousVerdict<S>(base);

  const runnable = hooks.policies.filter((policy) => isDispatchable(policy, hook, call.only));
  if (runnable.length === 0) return vacuousVerdict<S>(base);

  const ctx: RunContext<S> = {
    call,
    record,
    failMode: binding.failMode ?? record.failMode,
    startedAt,
    toolAccess: hooks.policies.filter(
      (policy): policy is ToolAccessPolicyConfig => policy.enabled && policy.family === 'tool_access',
    ),
  };

  const findings: SafetyFinding[] = [];
  const mutations: Mutation[] = [];
  const degraded: NonNullable<HookVerdict['degraded']> = [];
  const gated: Array<{ policyId: string; family: PolicyFamily; reason: string }> = [];
  let webhookRisk = 0;

  const collect = (policy: GuardrailPolicy, outcome: FamilyOutcome): void => {
    findings.push(...outcome.findings);
    mutations.push(...outcome.mutations);
    if (outcome.gated) gated.push(...outcome.gated);
    if (typeof outcome.riskScore === 'number') {
      webhookRisk = Math.max(webhookRisk, outcome.riskScore);
    }
    for (const entry of outcome.degraded ?? []) {
      degraded.push(entry);
      // The families that build their own failure finding are listed once, in
      // SELF_FAILMODE_FAMILIES; every other family gets it here, in place, so
      // "a policy that is enabled but cannot run must never be invisible" holds
      // for all nine and the finding lands where the policy ran.
      if (outcome.failModeApplied) continue;
      if (SELF_FAILMODE_FAMILIES.has(entry.family)) continue;
      findings.push(
        evaluationErrorFinding(ctx, policy, entry.family, entry.policyId, entry.reason),
      );
    }
  };

  // Default TRUE. `false` is what every legacy-lifted row and the default tool
  // guardrail carry, so that their whole findings array survives for the audit
  // trail and for the /v1/moderations category map.
  const shortCircuit = hooks.shortCircuit !== false;
  let stopped = false;

  // ── phase 1: the deterministic families, SEQUENTIALLY, in array order ──────
  for (const policy of runnable) {
    if (!runsInDeterministicPhase(policy)) continue;

    // RE-CHECKED PER POLICY, and a SPENT BUDGET DEGRADES THAT POLICY RATHER
    // THAN ENDING THE RUN: every policy the budget overtakes gets its own
    // `evaluation_error` finding, `failMode` decides what that finding means,
    // and the later phases still run and degrade the same way. Ending the run
    // here instead would convert a fail-CLOSED guardrail's blocking error
    // findings into silence for every policy after the first.
    if (exhausted(scope, startedAt)) {
      degraded.push({ policyId: policy.id, family: policy.family, reason: BUDGET_EXPIRED });
      findings.push(evaluationErrorFinding(ctx, policy, policy.family, policy.id, BUDGET_EXPIRED));
      continue;
    }

    collect(policy, await dispatchPolicy(ctx, policy));

    if (!shortCircuit) continue;
    // An ASYNC policy never short-circuits: it has by definition already let the
    // flow continue, so it cannot be what stops it.
    if (policyTiming(policy, binding) !== 'sync') continue;
    // Tested on the WHOLE findings list rather than on this policy's own
    // outcome, which is what the sequential engine has always done: a block
    // already raised stops the run at the next SYNC policy even when that policy
    // found nothing itself.
    if (!findings.some(isBlockingFinding)) continue;
    stopped = true;
    break;
  }

  // ── phase 2: "enabled but no evaluation model", BEFORE any LLM result ──────
  // A family running inside the parallel batch below cannot put its own finding
  // ahead of that batch, so the engine resolves `llmPolicyModelKey` itself here.
  // The list holds the policy OBJECTS, not their ids: ids are unique in any
  // config the save-time validator accepted, but a hand-edited row with two
  // policies sharing an id would otherwise dispatch the wrong one.
  const deferredPolicies: GuardrailPolicy[] = [];
  for (const policy of runnable) {
    // "Stops the remaining work" covers this pre-pass and the model calls too,
    // not merely the deterministic policy after the block.
    if (stopped) break;
    if (runsInDeterministicPhase(policy)) continue;
    // `webhook` dispatches unconditionally; only an LLM policy can be missing a
    // model.
    if (!isLlmPolicy(policy) || llmPolicyModelKey(policy, record.modelKey)) {
      deferredPolicies.push(policy);
      continue;
    }
    if (policy.family === 'custom' && policy.onMissingModel === 'skip') {
      // The preserved quirk: a custom guardrail with no model evaluates nothing
      // and passes today (guardrailService.ts:358). It is still DISPATCHED, so
      // the family records it as degraded rather than the policy vanishing
      // without trace.
      deferredPolicies.push(policy);
      continue;
    }
    const failMode = policyFailMode(policy, ctx.failMode);
    findings.push(
      buildLlmErrorFinding({
        family: policy.family,
        hook,
        policyId: policy.id,
        action: effectiveAction(policy, record.action),
        failMode,
        message: missingModelMessage(failMode),
      }),
    );
  }

  // ── phase 3: the remote round trips, started together ─────────────────────
  if (deferredPolicies.length > 0) {
    // Snapshotted ONCE, before any of them starts, so every policy in the batch
    // sees the same deterministic result — the `runIf` gate and
    // `redactBeforeSend` must not depend on which promise resolved first.
    //
    // THE BATCH IS HANDED THE DETERMINISTIC PHASE'S MUTATIONS, NOT A SUBJECT
    // REWRITTEN BY THEM, and the difference is load-bearing. Every span in a
    // finding is an ABSOLUTE offset into the ORIGINAL subject, and `runHook`
    // applies the merged mutations of every guardrail in ONE pass over that
    // original — so a policy that scanned rewritten text would report spans into
    // a string no other guardrail's spans are into, and the single pass would
    // then apply them at the wrong offsets. Corrupted redactions, silently.
    // What this phase actually needs is available without that: `webhook`
    // applies `priorMutations` to its own outgoing body (`redactBeforeSend`),
    // which is the case where "see the earlier phase's output" has real content.
    const priorFindings = findings.slice();
    const priorMutations = mutations.slice();

    // THE JUDGE FAMILIES ARE THE ONE EXCEPTION, and deliberately so. A
    // moderation / prompt-shield / custom policy returns a whole-text verdict
    // with NO spans, so the offset argument above does not apply to it — and
    // what it is handed goes to a THIRD-PARTY MODEL. `families/llm.ts` states
    // that it expects a subject the deterministic families' redactions have
    // already been applied to; without this a `secrets` policy that redacts a
    // credential from what the client sees still ships that credential,
    // verbatim, to the judge. Computed ONCE per hook run rather than per
    // policy: the whole batch is dispatched in the same tick from the same
    // snapshot. `webhook` keeps the original — its own `redactBeforeSend`
    // applies `priorMutations` to the outgoing body, and its `replace_value` /
    // `remove` paths must resolve against the subject `runHook` rewrites.
    const judgedSubject: S =
      priorMutations.length > 0 ? applyMutations(subject, priorMutations).subject : subject;

    // `undefined` marks a policy the budget overtook before it was started. The
    // check is per policy, exactly as in phase 1 — they are all dispatched in
    // the same tick, so in practice it either overtakes all of them or none.
    const tasks = deferredPolicies.map((policy) =>
      exhausted(scope, startedAt)
        ? undefined
        : dispatchPolicy(ctx, policy, priorFindings, priorMutations, judgedSubject),
    );
    const outcomes = await Promise.all(tasks);

    // COLLECTED BY DECLARATION INDEX, never by completion order — this loop is
    // the whole of the ordering guarantee for the parallel phase.
    for (let index = 0; index < deferredPolicies.length; index += 1) {
      const policy = deferredPolicies[index];
      if (!policy) continue;
      const outcome = outcomes[index];
      if (outcome === undefined) {
        degraded.push({ policyId: policy.id, family: policy.family, reason: BUDGET_EXPIRED });
        findings.push(evaluationErrorFinding(ctx, policy, policy.family, policy.id, BUDGET_EXPIRED));
        continue;
      }
      collect(policy, outcome);
    }

    // ── phase 4: re-validate tool ARGUMENTS the deferred phase rewrote ──────
    // `webhook` may answer with `replace_value` / `remove` on `/args/...`, and
    // `runHook` applies every mutation to the ORIGINAL subject — the one
    // `tool_access` validated in phase 1. Without this pass a webhook that
    // rewrites `args.url` to a host the allow-list never saw folds the decision
    // to `redact`, and the caller executes the tool against arguments no policy
    // inspected (`remove` on a required argument bypasses `argumentSchemas` the
    // same way). `tool_access` is cheap, pure and emits no mutations, so it is
    // simply run AGAIN over the rewritten arguments. Only a finding that BLOCKS
    // is kept: a non-blocking re-finding would duplicate phase 1's, and a block
    // is the one outcome that changes anything — it folds the decision to
    // 'block', which also drops the rewrite from the verdict. Confined to the
    // mutations this phase added: a phase-1 redaction of a secret inside an
    // argument is the deterministic families' own business and was already in
    // place when `tool_access` ran.
    const deferredMutations = mutations.slice(priorMutations.length);
    if (
      (subject.kind === 'tool_call' || subject.kind === 'tool_result') &&
      deferredMutations.some(rewritesToolArgs)
    ) {
      const rewritten = applyMutations(subject, mutations);
      if (rewritten.applied.some(rewritesToolArgs)) {
        const recheck: RunContext<S> = { ...ctx, call: { ...call, subject: rewritten.subject } };
        for (const policy of runnable) {
          if (policy.family !== 'tool_access') continue;
          const outcome = await dispatchPolicy(recheck, policy);
          collect(policy, {
            ...outcome,
            findings: outcome.findings.filter(isBlockingFinding),
            mutations: [],
          });
        }
      }
    }
  }

  // ── fold ──
  const wouldBeDecision = foldDecision(findings);
  const enforced = mode === 'enforce';
  const decision: SafetyAction = enforced ? wouldBeDecision : 'allow';
  const riskScore = Math.min(
    100,
    Math.max(
      webhookRisk,
      findings.reduce(
        (sum, finding) =>
          sum + (finding.critical ? CRITICAL_RISK : SEVERITY_RISK[finding.severity]),
        0,
      ),
    ),
  );
  const codes = [...new Set(findings.map((f) => f.code).filter((c): c is string => Boolean(c)))];

  // Redactions ride ONLY on an enforcing, non-blocking verdict:
  //   · not enforcing — a monitor-mode guardrail that rewrote the content would
  //     BE enforcing. `wouldBeDecision: 'redact'` is the dry-run signal instead,
  //     and dropping the proposals here is what keeps `verdict.mutations` equal
  //     to "the edits that were applied".
  //   · blocking — reproduces `redactable.length > 0 && !hasBlock`
  //     (guardrailService.ts:369): there is nothing to hand back when the
  //     request is being refused.
  const carryMutations = enforced && decision !== 'block';

  const verdict: HookVerdict<S> = {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook,
    mode,
    decision,
    wouldBeDecision,
    enforced,
    disabled: false,
    findings,
    mutations: carryMutations ? mutations : [],
    riskScore,
    codes,
    message:
      decision === 'block' ? renderBlock(findings, hooks, record, subject, scope, codes) : undefined,
    guardrailKeys: [record.key],
    guardrailKey: record.key,
    guardrailName: record.name,
    policyVersion: base.policyVersion,
    traceId: scope.traceId,
    latencyMs: Date.now() - startedAt,
    degraded: degraded.length > 0 ? degraded : undefined,
    // `cancelled` is deliberately not set: nothing here abandons a policy it
    // has started. `shortCircuit` decides what is never STARTED, which needs no
    // entry — see `HookVerdict.cancelled` for why the field stays anyway.
  };

  if (gated.length > 0) {
    // A gate that fired is a healthy guardrail saving a model call, so it is
    // deliberately NOT on the verdict — but "my judge never runs" still has to
    // be diagnosable somewhere.
    logger.debug('Guardrail policies gated by runIf', {
      hook,
      guardrailKey: record.key,
      traceId: scope.traceId,
      gated,
    });
  }

  if (!call.shadow && !call.skipLogging) {
    logHookEvaluation({ call, record, verdict, subject });
  }

  return verdict;
}

// ═══════════════════════════════════════════════════════════════════════════
// Dispatch
// ═══════════════════════════════════════════════════════════════════════════

function isDispatchable(policy: GuardrailPolicy, hook: HookId, only?: PolicyFamily[]): boolean {
  if (!policy.enabled) return false;
  if (!policy.hooks?.includes(hook)) return false;
  // An EMPTY `only` is read as "no filter", not as "run nothing": a caller that
  // built the list from a config and got nothing back would otherwise silently
  // disable every guardrail on the request, and a caller that genuinely wants
  // no evaluation simply does not call the hook.
  if (only && only.length > 0 && !only.includes(policy.family)) return false;
  // A stream window is scanned by the span-capable families only; everything
  // else adjudicates the same content in full on `output.pre`. This is a
  // routing rule rather than a failure, so nothing is recorded against the
  // policies it skips.
  if (hook === 'output.stream.delta' && !STREAM_ELIGIBLE_FAMILIES.has(policy.family)) return false;
  // THE SAME TABLE the save-time validator uses — there is no widened runtime
  // copy any more. It is ENFORCED here (rather than "dispatch whatever the
  // config names") because the alternative is worse than a skip: `word_filter`
  // answers a hook outside its set with a `degraded` entry, so a config that
  // bound it to `tool.pre` would apply `failMode` to EVERY tool call, and a
  // fail-closed tenant would lose its whole toolbox to a mistake the validator
  // already rejects. A policy skipped here still runs on its other bound hooks.
  const valid = POLICY_VALID_HOOKS[policy.family] as readonly HookId[] | undefined;
  // A family this build has never heard of — a row written by a newer console
  // against the same tenant database — has no entry here. It is dispatched
  // ANYWAY so `dispatchPolicy`'s default branch turns it into a degraded entry:
  // skipping would make an enabled policy invisible, and indexing blindly would
  // throw and take the whole hook (and therefore the request) down.
  if (!valid) return true;
  return valid.includes(hook);
}

const isLlmPolicy = (policy: GuardrailPolicy): policy is LlmPolicyConfig =>
  policy.family === 'moderation' || policy.family === 'prompt_shield' || policy.family === 'custom';

/**
 * Does this policy run in the FIRST phase?
 *
 * Asked as "is it NOT deferred" rather than as "is it deterministic", and the
 * asymmetry is deliberate: this has to be TOTAL over a `family` string this
 * build may never have heard of (a row written by a newer console against the
 * same tenant database), and such a policy has to run in phase 1 — the phase
 * whose dispatcher turns an unknown family into a degraded entry. Testing the
 * deterministic set instead would defer it to the model phase and change where
 * its degradation is reported.
 */
const runsInDeterministicPhase = (policy: GuardrailPolicy): boolean =>
  !DEFERRED_PHASE_FAMILIES.has(policy.family);

/**
 * THE ONE PLACE the family adapters' two calling conventions are reconciled.
 *
 * Five adapters (`pii`, `secrets`, `regex`, `tool_access`, `webhook`) take a
 * single input object; `word_filter` and the three LLM families are positional.
 * They were written concurrently against a contract that declares no family
 * signature at all, so the split is real and has to be absorbed somewhere —
 * here, rather than by editing seven files, so that hoisting a shared
 * `families/types.ts` later is a mechanical change with exactly one call site
 * to fix.
 */
async function dispatchPolicy<S extends HookSubject>(
  ctx: RunContext<S>,
  policy: GuardrailPolicy,
  /**
   * The deterministic phase's output. Both default to EMPTY because only the
   * deferred phase supplies them — the LLM families read `priorFindings` for
   * their `runIf` gate and `webhook` reads `priorMutations` for
   * `redactBeforeSend`, and both run after phase 1 has finished. A phase-1
   * policy would otherwise be handed a snapshot of itself.
   */
  priorFindings: readonly SafetyFinding[] = [],
  priorMutations: readonly Mutation[] = [],
  /**
   * The subject WITH `priorMutations` applied, for the judge families only —
   * see phase 3 for why they, and only they, are handed rewritten text.
   * Defaults to the original so a phase-1 dispatch is unchanged.
   */
  judgedSubject: S = ctx.call.subject,
): Promise<FamilyOutcome> {
  const { hook, subject, scope } = ctx.call;
  const action = effectiveAction(policy, ctx.record.action);
  const failMode = policyFailMode(policy, ctx.failMode);
  const remaining = remainingBudget(scope, ctx.startedAt);
  // Only the families that can BLOCK on time see the remaining budget; handing
  // the pure ones a mutated scope object would just churn allocations.
  const budgetScope: HookScope = remaining === undefined ? scope : { ...scope, budgetMs: remaining };

  try {
    switch (policy.family) {
      case 'pii':
        return await runPiiPolicy({ policy, subject, hook, scope, action });
      case 'secrets':
        return await runSecretsPolicy({ policy, subject, hook, scope, action });
      case 'regex':
        return await runRegexPolicy({ policy, subject, hook, scope, action });
      case 'tool_access':
        return await runToolAccessPolicy({ policy, subject, hook, scope, action });
      case 'word_filter':
        return await runWordFilterPolicy(subject, policy, { hook, scope, action });
      case 'moderation':
      case 'prompt_shield':
      case 'custom':
        // `judgedSubject`, not `subject`: the redacted text is what leaves the
        // process. The side-effect classification still reads the original —
        // it keys on tool NAMES, which no mutation touches.
        return await runLlmPolicy(judgedSubject, policy, {
          hook,
          scope: budgetScope,
          action,
          failMode,
          modelKey: ctx.record.modelKey,
          // The deterministic pass has finished by the time an LLM family is
          // dispatched, so this list is complete — it is the whole input to the
          // `onFinding` gate, and passing nothing would mean that gate never
          // fires and the policy silently never runs.
          priorFindings,
          sideEffect: classifySideEffect(subject, ctx.toolAccess),
          budgetMs: remaining,
        });
      case 'webhook':
        return await runWebhookPolicy({
          policy,
          subject,
          hook,
          scope: budgetScope,
          action,
          failMode,
          guardrailKey: ctx.record.key,
          // What the family applies to its outgoing body unless the policy opts
          // out with `redactBeforeSend: false`. It can only remove what an
          // earlier policy FOUND, which is why the normative order puts the
          // deterministic families first.
          priorMutations,
          shadow: ctx.call.shadow,
        });
      default: {
        // Unreachable while the union is exhaustive, but a stored row written by
        // a newer build can carry a family this one has never heard of, and a
        // policy that cannot run must be visible rather than silently absent.
        const unknown = policy as GuardrailPolicy;
        return {
          findings: [],
          mutations: [],
          degraded: [
            {
              policyId: unknown.id,
              family: unknown.family,
              reason: `Unknown policy family "${String(unknown.family)}"`,
            },
          ],
        };
      }
    }
  } catch (error) {
    // Every adapter documents that it never throws. This is the backstop for
    // the one that eventually does: a family that takes down the whole hook
    // would fail every request rather than one policy, so the throw becomes a
    // degraded entry and `failMode` decides.
    //
    // The finding is built HERE rather than left to `collect`, and
    // `failModeApplied` says so: a throw from a SELF_FAILMODE family (the LLM
    // judge, a webhook) skipped the code that would have built its own, so
    // deferring would leave a fail-CLOSED guardrail with a degraded entry and
    // no finding — i.e. passing content whenever its evaluator crashes.
    logger.error('Guardrail policy threw', {
      hook,
      policyId: policy.id,
      family: policy.family,
      error: error instanceof Error ? error.message : String(error),
    });
    const reason = `Policy failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      findings: [evaluationErrorFinding(ctx, policy, policy.family, policy.id, reason)],
      mutations: [],
      degraded: [{ policyId: policy.id, family: policy.family, reason }],
      failModeApplied: true,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Small resolvers
// ═══════════════════════════════════════════════════════════════════════════

const BUDGET_EXPIRED = 'Evaluation budget expired before this policy could run.';

/** Does this mutation touch the tool's ARGUMENTS (the `/args` root or below)?
 *  A rewrite there is what phase 4 re-validates with `tool_access`. */
function rewritesToolArgs(mutation: Mutation): boolean {
  return mutation.path === '/args' || mutation.path.startsWith('/args/');
}

/** `policy.action ?? record.action`. Families stamp what they are handed and
 *  never look at the record, so this is the only place the precedence lives. */
function effectiveAction(policy: GuardrailPolicy, recordAction: GuardrailAction): SafetyAction {
  return policy.action ?? recordAction;
}

/** Per-POLICY first, then the binding, then the record: one flaky moderation
 *  model must not fail a guardrail closed and take its PII pass down with it. */
function policyFailMode(
  policy: GuardrailPolicy,
  inherited: GuardrailFailMode | undefined,
): GuardrailFailMode | undefined {
  return policy.failMode ?? inherited;
}

/** Wall-clock left in the hook's budget, or undefined when it is unbounded.
 *  May be negative, which the LLM family reads as "already spent". */
function remainingBudget(scope: HookScope, startedAt: number): number | undefined {
  if (typeof scope.budgetMs !== 'number' || scope.budgetMs <= 0) return undefined;
  return scope.budgetMs - (Date.now() - startedAt);
}

/** True once the caller's budget is spent or the request was abandoned. */
function exhausted(scope: HookScope, startedAt: number): boolean {
  if (scope.signal?.aborted) return true;
  const remaining = remainingBudget(scope, startedAt);
  return remaining !== undefined && remaining <= 0;
}

/**
 * The house's "a policy could not run" finding, stamped up to a `SafetyFinding`.
 *
 * `family` and `policyId` come from the degraded ENTRY rather than the policy,
 * because `tool_access` reports sub-policies (a size cap, an SSRF probe) that
 * failed independently of one another.
 */
function evaluationErrorFinding<S extends HookSubject>(
  ctx: RunContext<S>,
  policy: GuardrailPolicy,
  family: PolicyFamily,
  policyId: string,
  reason: string,
): SafetyFinding {
  return {
    ...buildEvaluationErrorFinding({
      type: LEGACY_FINDING_TYPE[family],
      failMode: policyFailMode(policy, ctx.failMode),
      action: toLegacyAction(effectiveAction(policy, ctx.record.action)),
      message: reason,
    }),
    family,
    hook: ctx.call.hook,
    policyId,
    code: 'evaluation_error',
  };
}

const isBlockingFinding = (finding: SafetyFinding): boolean =>
  finding.block === true || finding.critical === true;

/**
 * max() over the action ladder, with two overrides that can only move the
 * result UP: a `critical` finding forces 'block' regardless of its own action
 * (that is what the flag means, since severity was deliberately not widened),
 * and so does a finding whose `block` is set. The two fields agree in every
 * family today; if one ever disagrees, the enforcing reading is the safe one.
 */
function foldDecision(findings: readonly SafetyFinding[]): SafetyAction {
  if (findings.some(isBlockingFinding)) return 'block';
  return foldActions(findings.map((finding) => finding.action));
}

/**
 * The tool's DECLARED side effect, or undefined when no enabled `tool_access`
 * policy classifies it.
 *
 * `undefined` must mean "unclassified", never "no side effect": an unknown tool
 * IS the risk signal the LLM judge was gated on
 * (`!shield.rules.sideEffects?.[name]`, aegis/engine.ts:253), so substituting
 * `defaultSideEffect` here would switch the judge off for exactly the calls it
 * was kept on for. Resolution mirrors `tool_access`'s own lookup — exact keys
 * beat globs, and among globs the one with the most literal text wins — so the
 * gate and the policy always agree on which classification applies.
 */
function classifySideEffect(
  subject: HookSubject,
  policies: readonly ToolAccessPolicyConfig[],
): SideEffect | undefined {
  if (subject.kind !== 'tool_call' && subject.kind !== 'tool_result') return undefined;
  if (policies.length === 0) return undefined;

  const names =
    subject.kind === 'tool_call' && subject.requestedName
      ? [subject.toolName, subject.requestedName]
      : [subject.toolName];

  for (const policy of policies) {
    const map = policy.sideEffects;
    if (!map) continue;
    for (const name of names) {
      const exact = map[name];
      if (exact !== undefined) return exact;
    }
    const globs = Object.keys(map)
      .filter((pattern) => pattern.includes('*'))
      .sort((a, b) => b.replace(/\*/g, '').length - a.replace(/\*/g, '').length);
    for (const pattern of globs) {
      const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
      if (names.some((name) => regex.test(name))) return map[pattern];
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The FROZEN wire field `policy_version` — see `HookVerdict.policyVersion`.
 *  Its `policy` is the guardrail configuration as a whole, not one
 *  `hooks.policies` entry. */
function policyVersionOf(record: IGuardrailV2): string {
  const stamped: unknown = record.updatedAt ?? record.createdAt;
  const iso =
    stamped instanceof Date
      ? stamped.toISOString()
      : typeof stamped === 'string'
        ? stamped
        : undefined;
  return iso ? `${record.key}@${iso}` : record.key;
}

/**
 * A verdict from a guardrail that exists but ran nothing — disabled, not bound
 * to this hook, or every policy filtered out by `only`.
 *
 * `disabled: true` is the load-bearing field: 'allow' here means "nothing was
 * checked", not "the content is safe", and the test panel has to tell those
 * apart. The real `mode` is reported (not `allowVerdict`'s hardcoded
 * 'disabled') so a monitor-mode guardrail that merely is not bound to this hook
 * does not read as switched off.
 */
function vacuousVerdict<S extends HookSubject>(base: {
  hook: HookId;
  mode: HookVerdict['mode'];
  guardrailKey: string;
  guardrailName: string;
  policyVersion: string;
  traceId: string;
  startedAt: number;
}): HookVerdict<S> {
  return {
    ...allowVerdict<S>({
      hook: base.hook,
      traceId: base.traceId,
      guardrailKeys: [base.guardrailKey],
      guardrailKey: base.guardrailKey,
      guardrailName: base.guardrailName,
      latencyMs: Date.now() - base.startedAt,
    }),
    mode: base.mode,
    policyVersion: base.policyVersion,
  };
}

/**
 * The end-user-facing block message.
 *
 * The reason class comes from the family of the finding that actually blocked,
 * EXCEPT when that finding is the "could not evaluate" one: telling a tenant
 * "your message looks like an injection attempt" because a moderation model was
 * down would be telling them something false. `unavailable` is the honest class
 * there, and it is the one reason class with no family of its own.
 */
/**
 * The BLOCKING POLICY'S OWN wording — the top layer of `resolveBlockMessage`'s
 * stack, and the only one that can distinguish two policies which share a
 * reason class.
 *
 * WHY IT IS A NAMED FUNCTION. It was missing entirely: `renderBlock` resolved a
 * message from the reason class alone, so `regex` and `webhook` policies (both
 * reason class 'custom') always produced the SAME body no matter what an
 * operator wrote on one of them. The drawer meanwhile displayed "This policy
 * overrides it" and offered a Reset button, so the operator had a written
 * confirmation of something that never happened at runtime — the failure was
 * invisible from every screen that could have reported it.
 *
 * THE EMPTY-ID GUARD IS LOAD-BEARING. `policyId` is optional on a finding, and
 * `find((p) => p.id === undefined)` matches the first policy that also lacks an
 * id — handing the block a completely unrelated policy's message. An absent id
 * means "no policy owns this", so it must resolve to no message at all.
 *
 * A blank message is left for `resolveBlockMessageTemplate` to skip, so that
 * "clear the box to go back to the inherited wording" keeps working here too.
 */
export function policyOwnMessage(
  hooks: GuardrailHooksConfig,
  policyId: string | undefined,
): string | undefined {
  if (!policyId) return undefined;
  return (hooks.policies ?? []).find((policy) => policy.id === policyId)?.message;
}

function renderBlock(
  findings: readonly SafetyFinding[],
  hooks: GuardrailHooksConfig,
  record: IGuardrailV2,
  subject: HookSubject,
  scope: HookScope,
  codes: readonly string[],
): RenderedBlockMessage {
  const blocking = findings.find(isBlockingFinding) ?? findings[0];
  const reasonClass = !blocking
    ? 'custom'
    : blocking.category === 'evaluation_error'
      ? 'unavailable'
      : BLOCK_REASON_FOR_FAMILY[blocking.family];

  const categories = [...new Set(findings.map((f) => f.category).filter(Boolean))];
  return resolveBlockMessage({
    reasonClass,
    settings: hooks.blockedMessage,
    policyId: blocking?.policyId,
    policyMessage: policyOwnMessage(hooks, blocking?.policyId),
    traceId: scope.traceId,
    useVerdictStatusCodes:
      hooks.visibility?.useVerdictStatusCodes ?? DEFAULT_VERDICT_VISIBILITY.useVerdictStatusCodes,
    vars: {
      guardrailName: record.name,
      guardrailKey: record.key,
      categories: categories.join(', '),
      codes: codes.join(', '),
      toolName:
        subject.kind === 'tool_call' || subject.kind === 'tool_result'
          ? subject.toolName
          : undefined,
      requestId: scope.requestId,
      traceId: scope.traceId,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Masks detected values before the evaluated text is persisted, so an
 * evaluation log never stores the very data the guardrail exists to protect.
 * Byte-identical to `guardrailService.ts:205-210`, which this replaces: the
 * facade delegates to `runHook` now, so keeping a second logger there would
 * write two rows per evaluation.
 */
function maskTextForLogging(text: string, findings: readonly GuardrailFinding[]): string {
  const masked = redactFindings(
    text,
    findings.filter((finding) => finding.value),
  );
  return masked.length > LOGGED_INPUT_MAX_CHARS
    ? `${masked.slice(0, LOGGED_INPUT_MAX_CHARS)}…`
    : masked;
}

/**
 * THE evaluation-log write, and the only one in the hook plane.
 *
 * It is the existing path MOVED, not reimplemented: same masking, same
 * `fireAndForget`, same `recordUsageEvent`, same `findings[0].message`
 * projection — plus the three new columns (`hook`, `decision`, `riskScore`).
 * `target` now carries the HOOK ID, which is strictly more informative than the
 * two legacy phases (a blocked tool call and a redacted response were both
 * 'output' under the old vocabulary), while `action` and `passed` keep their
 * legacy projections so every existing aggregation keeps bucketing.
 *
 * USAGE ACCOUNTING. One event per evaluated guardrail per hook call, EXCEPT on
 * `output.stream.delta`, which emits none: a 4K streamed answer is ~17 windows
 * at the default hold-back, and billing that as 17 evaluations would inflate
 * every guardrail usage figure in the fleet by an order of magnitude overnight.
 * Those windows fold into the terminal `output.pre` audit the stream gate runs,
 * which is exactly one event — the same count today's post-hoc audit produces.
 *
 * Attribution is resolved SYNCHRONOUSLY, before the fire-and-forget task, so the
 * request's AsyncLocalStorage scope is still in place; `fireAndForget` then
 * reopens a snapshot of it for the write itself.
 */
function logHookEvaluation<S extends HookSubject>(params: {
  call: HookCall<S>;
  record: IGuardrailV2;
  verdict: HookVerdict<S>;
  subject: S;
}): void {
  const { call, record, verdict, subject } = params;
  const { hook, scope } = call;
  const tenantDbName = scope.tenantDbName;

  const attribution =
    hook === 'output.stream.delta'
      ? resolveUsageAttribution()
      : recordUsageEvent({
          tenantDbName,
          tenantId: record.tenantId,
          projectId: record.projectId,
          service: 'guardrails',
          refKey: record.key,
          status: 'success',
          latencyMs: verdict.latencyMs,
        });

  // Legacy semantics, preserved: `passed` answers "did a blocking finding
  // exist", NOT "was the request blocked". In monitor mode the two diverge on
  // purpose, which is why `decision` is its own column.
  const passed = !verdict.findings.some((finding) => finding.block);

  fireAndForget('guardrail-eval-log', async () => {
    // A fresh tenant scope: the runHook scope has usually exited by the time
    // this runs, and `switchToTenant` in a detached task is the cross-tenant
    // race in its purest form.
    await runWithTenantScope(tenantDbName, (db) =>
      db.createGuardrailEvaluationLog({
        userId: attribution.userId,
        apiTokenId: attribution.apiTokenId,
        actorType: attribution.actorType,
        tenantId: record.tenantId,
        projectId: record.projectId,
        guardrailId: typeof record._id === 'string' ? record._id : (record._id?.toString() ?? ''),
        guardrailKey: record.key,
        guardrailName: record.name,
        guardrailType: record.type,
        target: hook,
        action: record.action,
        passed,
        findings: verdict.findings.map((finding) => ({
          ...finding,
          // Never persist raw PII/banned values; keep a hint of the shape only.
          value: finding.value
            ? `${finding.value.slice(0, 2)}…(${finding.value.length} chars)`
            : undefined,
        })),
        inputText: maskTextForLogging(subject.text, verdict.findings),
        latencyMs: verdict.latencyMs,
        source: scope.source,
        requestId: scope.requestId,
        message: passed ? null : (verdict.findings[0]?.message ?? null),
        hook,
        decision: verdict.decision,
        riskScore: verdict.riskScore,
      }),
    );
  });
}
