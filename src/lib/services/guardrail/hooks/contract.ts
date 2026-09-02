/**
 * The guardrail hook plane's contract — types, constants and the pure helpers
 * that need nothing but them.
 *
 * DEPENDENCY RULE: this file is the LEAF of `hooks/`. It imports the narrow
 * type path `@/lib/database/provider/types.domain` and never the
 * `@/lib/database` barrel (which constructs providers and registers shutdown
 * handlers the moment it is loaded), and it never touches
 * `@cognipeer/agent-sdk`. Every other file in `hooks/` imports this one; none
 * of them is imported back. That is why `applyMutations` lives in
 * `./mutations` and `renderBlockMessage` / `DEFAULT_BLOCK_MESSAGES` live in
 * `./messages` even though the contract describes all three — putting the
 * implementations here would make the three files mutually dependent, and a
 * cycle whose members hold module-level `const` tables is a
 * "cannot access X before initialization" waiting for a different import order.
 *
 * The PERSISTED shapes (policies, bindings, stream/message/visibility settings,
 * the whole `GuardrailHooksConfig` blob) are declared once in `types.domain`
 * because `IGuardrail.hooks` has to name them. This file re-exports them under
 * the short names the hook plane uses and never redeclares them: `hooks` is
 * both written (a `Partial<IGuardrail>` on save) and read (the engine's config),
 * so two independent descriptions would break assignment in one direction or
 * the other the first time they drifted.
 */

import type {
  GuardrailAction,
  GuardrailFailMode,
  GuardrailTarget,
  IGuardrail,
  // ── persisted shapes, aliased to the hook plane's short names ──
  GuardrailBlockedMessageSettings as BlockedMessageSettings,
  GuardrailBlockReasonClass as BlockReasonClass,
  GuardrailPolicy,
  GuardrailPolicyBase as PolicyBase,
  GuardrailPolicyFamily as PolicyFamily,
  GuardrailContractVersion,
  GuardrailCustomPolicyConfig as CustomPolicyConfig,
  GuardrailHookBinding as HookBinding,
  GuardrailHookId as HookId,
  GuardrailHookSchedule as HookSchedule,
  GuardrailHooksConfig,
  GuardrailJsonSchemaLite as JsonSchemaLite,
  GuardrailMode,
  GuardrailModerationPolicyConfig as ModerationPolicyConfig,
  GuardrailPiiPolicyConfig as PiiPolicyConfig,
  GuardrailPromptShieldPolicyConfig as PromptShieldPolicyConfig,
  GuardrailRegexPolicyConfig as RegexPolicyConfig,
  GuardrailRegexRule as RegexRule,
  GuardrailSafetyAction as SafetyAction,
  GuardrailSecretsPolicyConfig as SecretsPolicyConfig,
  GuardrailSideEffect as SideEffect,
  GuardrailStreamSettings as StreamGuardSettings,
  GuardrailToolAccessPolicyConfig as ToolAccessPolicyConfig,
  GuardrailVerdictVisibility as VerdictVisibility,
  GuardrailWebhookPolicyConfig as WebhookPolicyConfig,
  GuardrailWordFilterPolicyConfig as WordFilterPolicyConfig,
} from '@/lib/database/provider/types.domain';
import type { GuardrailFinding } from '../types';

// The persisted shapes are part of this module's public surface: every other
// file in the hook plane imports them from here, so `types.domain` stays an
// implementation detail of persistence rather than something the engine, the
// families and the API plugins all have to know about.
export type {
  BlockedMessageSettings,
  BlockReasonClass,
  PolicyBase,
  PolicyFamily,
  CustomPolicyConfig,
  GuardrailPolicy,
  GuardrailContractVersion,
  // Re-exported because `failMode` is now a per-POLICY field, so every family
  // adapter names this type; making them reach past this module for it would
  // be the one import that still points at the persistence layer.
  GuardrailFailMode,
  GuardrailHooksConfig,
  GuardrailMode,
  HookBinding,
  HookId,
  HookSchedule,
  JsonSchemaLite,
  ModerationPolicyConfig,
  PiiPolicyConfig,
  PromptShieldPolicyConfig,
  RegexPolicyConfig,
  RegexRule,
  SafetyAction,
  SecretsPolicyConfig,
  SideEffect,
  StreamGuardSettings,
  ToolAccessPolicyConfig,
  VerdictVisibility,
  WebhookPolicyConfig,
  WordFilterPolicyConfig,
};

/**
 * Bumped ONLY on a breaking change to HookCall/HookVerdict. A single scalar,
 * not a two-sided range: the one-line guard (`if (v && v !== VERSION) throw`)
 * the enforcement plane shipped was sufficient for a year, and a negotiable
 * range buys nothing while there is exactly one remote enforcement point.
 */
export const GUARDRAIL_CONTRACT_VERSION: GuardrailContractVersion = 2;

// ── 1. Hooks ────────────────────────────────────────────────────────────────

/**
 * Which subject shape each hook carries. Declared before HOOK_IDS on purpose:
 * it is keyed by the `HookId` union itself, so `HOOK_IDS` can be derived from
 * its keys and the list of hooks can never fall behind the union. (A hook id
 * missing from a hand-maintained list is a hook that silently never runs.)
 * `SubjectKind` is declared further down — types hoist, values do not.
 */
export const HOOK_SUBJECT_KIND: Readonly<Record<HookId, SubjectKind>> = {
  'prompt.pre': 'text',
  'input.pre': 'text',
  'output.pre': 'text',
  'output.stream.delta': 'stream_delta',
  'tool.pre': 'tool_call',
  'tool.post': 'tool_result',
};

/**
 * The six hook ids, in PIPELINE order, which is also UI order: the user turn
 * that starts a run, then every model call, then the answer, then each streamed
 * window, then each tool call and its result.
 *
 * `prompt.pre` is the one hook the console itself never emits, and that is
 * deliberate rather than a gap. A remote enforcement point emits it — an SDK's
 * `userPromptSubmit` seam POSTing to
 * `/api/client/v1/guardrails/hooks/evaluate` — because only the thing running
 * the loop knows which model call is the first of a turn. The gateway sees a
 * message list, not a run, so an emitter here would have to GUESS, and a wrong
 * guess bills a tenant for a once-per-run policy on every request. The hook
 * exists so that the rule "check what the human typed" is expressible at all;
 * conflating it with `input.pre` is what made it inexpressible before.
 *
 * `retrieval.post` is still absent for the older reason: it would cost a
 * subject type, a valid-hooks column and a config screen for a policy nothing
 * can currently trigger. Adding it later is additive and invalidates no
 * persisted record, because `HookId` is a string union — which is exactly how
 * `prompt.pre` was added.
 *
 * There is no separate `output.stream.final`: the post-hoc audit of a streamed
 * answer IS `output.pre` with `{ timing: 'async', onFail: 'log' }`.
 */
export const HOOK_IDS: readonly HookId[] = Object.keys(HOOK_SUBJECT_KIND) as HookId[];

export type HookSurface =
  | 'gateway'
  | 'agent'
  | 'mcp'
  | 'sandbox'
  | 'appgw'
  | 'api'
  | 'dashboard'
  | 'redteam';

/** Every hook can block today. Kept as a set so a future advisory-only hook is
 *  a one-line change rather than a search for implicit assumptions. */
export const BLOCKING_HOOKS: ReadonlySet<HookId> = new Set<HookId>(HOOK_IDS);

/**
 * For UI grouping and the legacy `target` projection only — it NEVER gates
 * policy. Direction at runtime comes from which hook fired, not from the
 * record's `target` column, which is why a legacy record lifts onto both
 * `input.pre` and `output.pre` regardless of what that column says.
 */
export function hookDirection(hook: HookId): GuardrailTarget {
  return hook === 'prompt.pre' || hook === 'input.pre' || hook === 'tool.pre'
    ? 'input'
    : 'output';
}

// ── 2. Subject ──────────────────────────────────────────────────────────────

/**
 * One scannable string, addressed by an RFC-6901 JSON Pointer into the subject
 * (`/text`, `/args/url`, `/result/0/body`). Pointers are what let a finding
 * name a PLACE instead of a value, and what lets a rewrite hit that place
 * instead of every occurrence of the matched string in the document.
 */
export interface SubjectSegment {
  path: string;
  text: string;
  role?: 'system' | 'user' | 'assistant' | 'tool' | string;
}

interface SubjectCommon {
  /**
   * Segments joined by '\n', in segment order. THE ONLY derivation of `text`,
   * and the reason every policy family that only knows how to scan a flat string
   * runs unmodified at `tool.pre` and `tool.post`.
   */
  text: string;
  segments: SubjectSegment[];
}

export type HookSubject =
  | (SubjectCommon & { kind: 'text' })
  | (SubjectCommon & {
      kind: 'tool_call';
      /**
       * Canonical policy name: `${serverKey}/${tool}` for MCP, `sandbox.fs.read`
       * for the toolbox. MUST be derived from the ROUTE PATTERN with params
       * stripped — a concrete URL leaks `:sid` values into policy and makes
       * `sideEffects` entries like `sandbox.sessions.exec` never match.
       */
      toolName: string;
      /** The name the model used, before MCP rename resolution. */
      requestedName?: string;
      args: Record<string, unknown>;
      /** `mcp:<serverKey>` | `sandbox:<instanceId>` | `agent:<agentKey>`. */
      providerRef: string;
      sandboxAvailable?: boolean;
    })
  | (SubjectCommon & {
      kind: 'tool_result';
      toolName: string;
      args: Record<string, unknown>;
      result: unknown;
      providerRef: string;
    })
  | (SubjectCommon & {
      kind: 'stream_delta';
      /** This window's newly-arrived text. Informational; policies read `text`. */
      delta: string;
      /**
       * The full accumulated channel text. Spans are ABSOLUTE into this.
       *
       * INVARIANT: a stream_delta subject carries exactly ONE segment, covering
       * the whole buffer, so `text === buffer`. `applyMutations` relies on it to
       * write a redaction back into `buffer` — the string the gate actually
       * emits from — rather than only into the flattened `text`.
       */
      buffer: string;
      /** Absolute offset already written to the client. */
      releasedTo: number;
      seq: number;
      final: boolean;
    });

export type SubjectKind = HookSubject['kind'];

// ── 2a. JSON Pointer (RFC 6901) ─────────────────────────────────────────────

/** `~` -> `~0` and `/` -> `~1`, in that order. Escaping `/` first would leave a
 *  fresh `~` behind for the second pass to escape again, and a literal `/`
 *  would come back as `~1`. */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** The inverse, and likewise order-sensitive: `~01` must decode to `~1`, not `/`. */
export function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Depth at which the leaf walk stops descending. Pinned to the tool_access
 * `maxArgDepth` default so the two agree: arguments nested deeper than this are
 * rejected outright by that policy, which is what stops the cap from being an
 * evasion primitive ("hide the secret 40 levels down"). With tool_access off,
 * deeply nested content is genuinely unscanned — a documented limitation, and
 * the alternative is an unbounded recursion a caller controls.
 */
const MAX_WALK_DEPTH = 32;

/**
 * Only arrays and plain objects are descended into, and — critically — only
 * they are cloned by `applyMutations`. Anything else (a Date, a Buffer, a class
 * instance) is an opaque leaf: it is never scanned, so it is never rewritten,
 * so a rewrite can never mutate an object the caller still holds a reference
 * to. Tool arguments and MCP results are JSON, so this costs nothing real.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Recursive string-leaf walk producing one segment per non-empty string, in
 * document order, each addressed by its pointer.
 *
 * Numbers and booleans are NOT stringified: a span into a rendering that does
 * not exist in the source cannot be written back, and the detectors that would
 * benefit (a credit-card number sent as a JSON number) would produce findings
 * no mutation could act on. Empty strings are skipped — they carry nothing to
 * detect and would only contribute blank lines to the flattened `text`.
 *
 * The `seen` set is a PATH guard, not a visited set: it is released on the way
 * back up, so a shared node reachable by two paths is reported under both while
 * a genuine cycle still terminates.
 */
export function walkStringLeaves(value: unknown, basePath: string): SubjectSegment[] {
  const out: SubjectSegment[] = [];
  const seen = new Set<object>();

  const visit = (node: unknown, path: string, depth: number): void => {
    if (typeof node === 'string') {
      if (node.length > 0) out.push({ path, text: node });
      return;
    }
    if (depth >= MAX_WALK_DEPTH) return;
    if (Array.isArray(node)) {
      if (seen.has(node)) return;
      seen.add(node);
      for (let i = 0; i < node.length; i += 1) visit(node[i], `${path}/${i}`, depth + 1);
      seen.delete(node);
      return;
    }
    if (!isPlainRecord(node)) return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const [key, child] of Object.entries(node)) {
      visit(child, `${path}/${escapePointerToken(key)}`, depth + 1);
    }
    seen.delete(node);
  };

  visit(value, basePath, 0);
  return out;
}

/** The one derivation of a subject's flattened `text`. Every builder and
 *  `applyMutations` go through it so the invariant cannot drift. */
export function joinSegments(segments: readonly SubjectSegment[]): string {
  return segments.map((segment) => segment.text).join('\n');
}

export function textSubject(text: string, path = '/text'): HookSubject & { kind: 'text' } {
  return { kind: 'text', text, segments: [{ path, text }] };
}

/**
 * `toolName` and `providerRef` are deliberately NOT segments. They are policy
 * identifiers, not content: a PII match on a tool name is a false positive that
 * no rewrite could act on anyway, since renaming the tool mid-call would change
 * which tool runs.
 */
export function toolCallSubject(input: {
  toolName: string;
  requestedName?: string;
  args: Record<string, unknown>;
  providerRef: string;
  sandboxAvailable?: boolean;
}): HookSubject & { kind: 'tool_call' } {
  const segments = walkStringLeaves(input.args, '/args');
  return {
    kind: 'tool_call',
    text: joinSegments(segments),
    segments,
    toolName: input.toolName,
    requestedName: input.requestedName,
    args: input.args,
    providerRef: input.providerRef,
    sandboxAvailable: input.sandboxAvailable,
  };
}

/**
 * Segments cover the RESULT only. The arguments ride along on the subject so a
 * tool_access policy can still see them, but scanning them again at `tool.post`
 * would double-report every finding `tool.pre` already raised — and the second
 * copy would land in the same evaluation log with the same category.
 */
export function toolResultSubject(input: {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  providerRef: string;
}): HookSubject & { kind: 'tool_result' } {
  const segments = walkStringLeaves(input.result, '/result');
  return {
    kind: 'tool_result',
    text: joinSegments(segments),
    segments,
    toolName: input.toolName,
    args: input.args,
    result: input.result,
    providerRef: input.providerRef,
  };
}

// ── 3. Actions ──────────────────────────────────────────────────────────────
/**
 * `SafetyAction` is `'allow' | GuardrailAction`, i.e. exactly
 * `'allow' | 'block' | 'warn' | 'flag' | 'redact'` — the whole compatibility
 * story in one line, since `toLegacyAction` is then total and loses only
 * 'allow'. The rungs that are NOT here and why:
 *   · mask / tokenize — they live per-category on the PII policy, where they
 *     already are. Promoting them to this ladder would make `mask < redact` and
 *     silently escalate a masking guardrail the moment it merged with a
 *     redacting one.
 *   · sandbox — its one consumer passes a pass-through adapter, so today every
 *     side-effect finding that resolves to it simply runs the tool.
 *   · require_approval — no store and no UI. `GuardrailEnforcementError.code`
 *     keeps the member so the toolbox's `code === 'approval_required' ? 202 :
 *     403` still compiles; nothing emits it.
 */

/** Strict ladder. Merging N verdicts is max(), which is associative and
 *  therefore order-independent — the property that lets policies run in any
 *  order and guardrails merge in any order. */
export const SAFETY_ACTION_RANK: Readonly<Record<SafetyAction, number>> = {
  allow: 0,
  flag: 1,
  warn: 2,
  redact: 3,
  block: 4,
};

export function foldActions(actions: readonly SafetyAction[]): SafetyAction {
  return actions.reduce<SafetyAction>(
    (a, b) => (SAFETY_ACTION_RANK[b] > SAFETY_ACTION_RANK[a] ? b : a),
    'allow',
  );
}

/** Total. 'allow' has no legacy spelling, and 'flag' is its non-enforcing
 *  equivalent — the legacy column has always meant "what to do when a finding
 *  exists", and an 'allow' verdict produced no finding to record. */
export function toLegacyAction(a: SafetyAction): GuardrailAction {
  return a === 'allow' ? 'flag' : a;
}

export const isBlocking = (a: SafetyAction): boolean => a === 'block';
export const isMutating = (a: SafetyAction): boolean => a === 'redact';

// ── 4. Policy families ───────────────────────────────────────────────────────
/**
 * NINE families. `regex` survives as its own family despite `word_filter`
 * already carrying a `regexes` list, because the stream gate needs span-capable
 * patterns with a DECLARED `maxMatchChars` and word_filter can provide neither:
 * its character folding is NFKD-normalising (so length-changing, so its offsets
 * do not map back) and it joins runs of single-character tokens, so its match
 * length in raw characters is unbounded.
 *
 * `json_schema` and `size_limit` are fields on `tool_access` rather than
 * families, `rate_limit` is absent because a per-process counter enforces N x
 * the limit across N replicas and resets on every deploy, and `plugin` is
 * absent because `webhook` IS the extension point.
 */

/**
 * Every finding persists a LEGACY `type` drawn from the original five-value
 * union, which is what keeps the `findings.type` aggregations on both providers
 * counting and what keeps the AI App Gateway's PII-dimension filter seeing
 * secrets — today secrets ARE `type: 'pii'`, because the secret patterns live
 * inside the PII detector.
 */
export const LEGACY_FINDING_TYPE: Readonly<Record<PolicyFamily, GuardrailFinding['type']>> = {
  pii: 'pii',
  secrets: 'pii', // deliberate: preserves the gateway's PII-dimension filter
  word_filter: 'word_filter',
  regex: 'word_filter',
  moderation: 'moderation',
  prompt_shield: 'prompt_shield',
  custom: 'custom',
  tool_access: 'custom',
  webhook: 'custom',
};

/** Derived from the map above so the list cannot fall behind the union — the
 *  same reason HOOK_IDS is derived from HOOK_SUBJECT_KIND. */
export const POLICY_FAMILIES: readonly PolicyFamily[] = Object.keys(
  LEGACY_FINDING_TYPE,
) as PolicyFamily[];

// ── 4b. The `check` -> `policy` spelling bridge ─────────────────────────────

/**
 * Pre-rename family names, mapped onto their current spelling.
 *
 * `tool_policy` became `tool_access` because "a tool_policy policy" is exactly
 * the redundancy this rename exists to remove: the family name should say what
 * it inspects, not repeat the word for the unit.
 */
export const LEGACY_POLICY_FAMILY: Readonly<Record<string, PolicyFamily>> = {
  tool_policy: 'tool_access',
};

/**
 * The stored policy array, under EITHER spelling; `undefined` when neither is a
 * usable array, which every caller already reads as "no authored config".
 *
 * `policies` wins when both are present: a row written by this build is
 * authoritative over a stale key an older client round-tripped back.
 */
export function readPolicyList(hooks: unknown): unknown[] | undefined {
  if (hooks === null || typeof hooks !== 'object') return undefined;
  const source = hooks as { policies?: unknown; checks?: unknown };
  if (Array.isArray(source.policies)) return source.policies;
  if (Array.isArray(source.checks)) return source.checks;
  return undefined;
}

/**
 * READ-PATH NORMALISER for a persisted (or received) hook config, and the ONE
 * implementation of the rename's compatibility rule.
 *
 * WHY IT EXISTS. Before this rename the persisted blob spelled its policy list
 * `hooks.checks`, the tool gate `family: 'tool_policy'`, and the PII policy's
 * reference `policyKey`. Every guardrail authored before it still carries those
 * names on disk. Read through code that only knows `hooks.policies`, such a row
 * has NO policies — `ensureHooks` then treats it as unauthored and lifts the
 * legacy columns instead, so an operator's whole configuration silently stops
 * running while the UI keeps saying it saved. That is the failure this function
 * exists to make impossible.
 *
 * It is NOT a migration. Nothing is rewritten on disk: a row is re-spelled the
 * next time someone saves it, and works unchanged until then. The write path
 * emits only the new names, so the old ones can only ever arrive, never leave.
 *
 * IT ALSO DROPS THE WITHDRAWN LANE FIELDS — `policy.layer` and
 * `hooks.layerSettings` — for exactly the same reason and by exactly the same
 * route. They were persisted inside this blob while the policy-lane model
 * existed, so stored rows carry them; a policy declares WHERE it runs with
 * `hooks` and there is nothing left to read them. Dropping them HERE rather
 * than in the engine covers both directions at once: `ensureHooks` runs a
 * stored row through this before the engine ever sees it, and
 * `readHooksField` runs the request body through it before the store does — so
 * a PATCH that round-trips a GET response cannot write them back, which is the
 * same trap `hooks.checks` set.
 *
 * NON-MUTATING, and it returns the SAME object when nothing needed changing.
 * Both matter: records come out of a shared TTL cache that is frozen outside
 * production, and this runs on the read path of every hook call.
 *
 * Deliberately generic and shape-preserving rather than
 * `(unknown) => GuardrailHooksConfig | undefined`: the callers hand it a
 * `GuardrailHooksConfig | undefined` off a record, or a `Record<string,
 * unknown>` off a request body, and each wants its own type back.
 */
export function normalizeHooksConfig<T>(hooks: T): T {
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return hooks;
  const source = hooks as Record<string, unknown>;
  const list = readPolicyList(source);
  if (list === undefined) return hooks;

  // A config that stored the array under `checks` — or one carrying a
  // withdrawn `layerSettings` — has to be rebuilt whatever its entries look
  // like: the key itself is the thing being re-spelled or removed.
  let changed = !Array.isArray(source.policies) || source.layerSettings !== undefined;

  const policies = list.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const policy = entry as Record<string, unknown>;
    const family =
      typeof policy.family === 'string' ? LEGACY_POLICY_FAMILY[policy.family] : undefined;
    // `policyKey` -> `piiPolicyKey`, on the pii family only. The new name says
    // WHAT it points at (an `IPiiPolicy`, a separate tenant asset this policy
    // references) instead of reading as if a policy carried its own key.
    const legacyPiiKey =
      (family ?? policy.family) === 'pii' && typeof policy.policyKey === 'string';
    const laneField = policy.layer !== undefined;
    if (family === undefined && !legacyPiiKey && !laneField) return entry;

    changed = true;
    const next: Record<string, unknown> = { ...policy };
    if (family !== undefined) next.family = family;
    if (legacyPiiKey) {
      if (next.piiPolicyKey === undefined) next.piiPolicyKey = policy.policyKey;
      delete next.policyKey;
    }
    if (laneField) delete next.layer;
    return next;
  });

  if (!changed) return hooks;
  const next: Record<string, unknown> = { ...source, policies };
  delete next.checks;
  delete next.layerSettings;
  return next as T;
}

/**
 * The policy id on a finding / mutation / degraded entry read off the wire.
 *
 * Emitted as `policyId`; `checkId` is what every build before the rename sent,
 * and what persisted evaluation-log rows still carry. Those rows are NOT
 * migrated — they are an append-only audit trail — so a reader that wants an id
 * has to accept both spellings forever.
 */
export function readPolicyId(entry: Record<string, unknown>): string {
  if (typeof entry.policyId === 'string') return entry.policyId;
  if (typeof entry.checkId === 'string') return entry.checkId;
  return '';
}

/** A family name off the wire, with the pre-rename spellings accepted. */
export function readPolicyFamily(value: unknown): PolicyFamily | undefined {
  if (typeof value !== 'string') return undefined;
  const renamed = LEGACY_POLICY_FAMILY[value];
  if (renamed !== undefined) return renamed;
  return (POLICY_FAMILIES as readonly string[]).includes(value)
    ? (value as PolicyFamily)
    : undefined;
}

// ── 5. Findings + mutations ─────────────────────────────────────────────────

/**
 * PURELY ADDITIVE over `GuardrailFinding`: `type`, `category`, `severity`,
 * `message`, `action`, `block` and `value` keep their exact names AND types, so
 * a `SafetyFinding[]` is assignable wherever a `GuardrailFinding[]` is today.
 *
 * `severity` is NOT widened with 'critical'. The consumers that would break are
 * real: the moderation API indexes a `Record<GuardrailFinding['severity'],
 * number>` by it, `normalizeSeverity` coerces anything unrecognised to 'high'
 * anyway, the persisted evaluation-log element type names the same three, and
 * both providers bucket findings by it. Criticality rides on the additive
 * `critical` flag instead, and a critical finding forces decision 'block'
 * regardless of its own `action`.
 */
export interface SafetyFinding extends GuardrailFinding {
  family: PolicyFamily;
  hook: HookId;
  /** The `GuardrailPolicy.id` that produced it. */
  policyId: string;
  /** Machine code, e.g. 'tool_not_allowed', 'egress_domain_denied',
   *  'path_denied', 'secret_detected', 'evaluation_error'. Append-only. */
  code?: string;
  /** Folded out of `severity` for compatibility — see above. */
  critical?: boolean;
  /** Pointer into the subject. Present when the detector knows where. */
  path?: string;
  /** Absolute offsets INSIDE the string at `path`. Present ONLY for
   *  span-capable detectors — see SPAN_CAPABLE. */
  span?: { start: number; end: number };
  confidence?: number;
}

/**
 * WHICH FAMILIES PRODUCE SPANS. This is a contract, not an aspiration:
 *   pii (policy path)    YES — the PII service's findings already carry offsets
 *   pii (obfuscation)    NO  — that pass scans an NFKC-normalised, zero-width-
 *                              stripped, de-obfuscated string of a DIFFERENT
 *                              LENGTH, so its offsets do not map back
 *   secrets              YES — patterns run on the raw text
 *   regex                YES — patterns run on the raw text
 *   word_filter          NO  — folding is length-changing and joins
 *                              non-contiguous tokens
 *   moderation / prompt_shield / custom / webhook   NO — whole-text verdicts
 *   tool_access          path only, no span
 *
 * A span-less finding that wants a rewrite emits `replace_value`, which is
 * scoped to ONE segment — unlike the legacy redaction, which rewrote every
 * occurrence of the matched value across the whole document.
 */
export const SPAN_CAPABLE: ReadonlySet<PolicyFamily> = new Set<PolicyFamily>([
  'pii',
  'secrets',
  'regex',
]);

export type Mutation =
  /** THE primary redaction op. Absolute offsets into the string at `path`. */
  | {
      op: 'replace_span';
      path: string;
      start: number;
      end: number;
      replacement: string;
      family: PolicyFamily;
      policyId: string;
      category?: string;
    }
  /** For span-less detectors. Replaces every occurrence of `value` WITHIN THE
   *  SEGMENT AT `path` — never across the whole document. */
  | {
      op: 'replace_value';
      path: string;
      value: string;
      replacement: string;
      family: PolicyFamily;
      policyId: string;
      category?: string;
    }
  /** Delete the property at `path` (a tool argument, a result field). */
  | { op: 'remove'; path: string; family: PolicyFamily; policyId: string };

/** Overlap tie-break: secrets beats pii beats regex beats word_filter. A
 *  credential mis-detected as an email must still be redacted as a credential,
 *  because the two labels carry different operator instructions. */
export const FAMILY_PRECEDENCE: Readonly<Record<PolicyFamily, number>> = {
  secrets: 100,
  pii: 90,
  regex: 80,
  word_filter: 70,
  tool_access: 60,
  moderation: 50,
  prompt_shield: 50,
  custom: 40,
  webhook: 30,
};

export interface MutationOutcome<S extends HookSubject = HookSubject> {
  subject: S;
  text: string;
  applied: Mutation[];
  /** Never silently dropped: a mutation whose path or span no longer resolves
   *  is returned here with a reason, so the log shows the redaction that did
   *  not happen instead of a verdict claiming one that did. */
  skipped: Array<{ mutation: Mutation; reason: string }>;
}

// `applyMutations` is implemented in ./mutations — see the dependency rule at
// the top of this file. Import it from there:
//     import { applyMutations } from './mutations';

// ── 6. Scheduling ───────────────────────────────────────────────────────────
/**
 * `HookSchedule` is ONE field, not an independent `timing?` plus `onFail?`, so
 * `{ timing: 'async', onFail: 'block' }` is UNREPRESENTABLE rather than merely
 * rejected by a validator — an async policy has by definition already let the
 * flow continue, so it cannot block. Two optionals would leak the illegal pair
 * into every level at once (policy, binding, webhook).
 *
 * The SCREENS said the illegal pair out loud anyway, as two selects with a
 * greyed-out cell. `GuardrailEnforcement` in 6a is the one control that
 * replaces them; the stored field below is untouched by it.
 */

/** Read-time normaliser: 'simulate' (the enforcement plane's word) and 'off'
 *  (the MCP binding's word) both fold into the canonical three. */
export function toGuardrailMode(v: unknown, enabled: boolean): GuardrailMode {
  if (!enabled) return 'disabled';
  if (v === 'monitor' || v === 'simulate') return 'monitor';
  if (v === 'disabled' || v === 'off') return 'disabled';
  return 'enforce';
}

// ── 6a. The three-value enforcement control ─────────────────────────────────

/**
 * ONE control where the screens showed two, and the reason the pair had to go:
 * `timing` x `onFail` reads as four combinations and the type has only THREE.
 * An async policy has by definition already let the flow continue, so
 * `{ timing: 'async', onFail: 'block' }` is not a setting an operator was
 * refused — it is a setting that cannot exist. Two selects advertised it
 * anyway, and the screens spent their copy explaining why the fourth cell was
 * greyed out.
 *
 * PRESENTATION ONLY — NOTHING HERE IS PERSISTED OR TRANSMITTED. The stored and
 * wire field is still `schedule: GuardrailHookSchedule`, on the policy and on
 * the binding, unchanged. These two functions are the whole mapping:
 *
 *   SCREEN VALUE        STORED `schedule`                     WHAT HAPPENS
 *   'block'             { timing: 'sync',  onFail: 'block' }  waits; a finding stops the request
 *   'observe'           { timing: 'sync',  onFail: 'log'  }   waits; a finding is recorded only
 *   'observe_no_wait'   { timing: 'async', onFail: 'log'  }   does not wait; recorded after the fact
 *
 * The vocabulary is deliberately the guardrail-level one at a smaller scope:
 * a guardrail in `mode: 'monitor'` is every one of its policies set to observe,
 * and the two are one idea rather than two features. `onFail` is not a word an
 * operator ever needs again, and neither is `timing`.
 */
export type GuardrailEnforcement = 'block' | 'observe' | 'observe_no_wait';

/** The three, in the order a control should offer them: strongest first.
 *  `as const satisfies` so a value added to the union without being added here
 *  is a compile error, the same way `POLICY_FIELD_KINDS` is pinned. */
export const GUARDRAIL_ENFORCEMENTS = [
  'block',
  'observe',
  'observe_no_wait',
] as const satisfies readonly GuardrailEnforcement[];

/**
 * A stored `schedule` as the one control sees it. TOTAL, including over shapes
 * the type says cannot exist — this runs on rows a hand-written PATCH wrote and
 * on the `schedule: {}` an older client round-trips.
 *
 * IT AGREES WITH THE ENGINE ON EVERY MALFORMED SHAPE, which is the whole point
 * of it being here rather than in a component:
 *   · no schedule at all, or `{}`      -> 'block'. `policyTiming` (hooks/engine)
 *     falls back to `SYNC_BLOCK`, and `/hooks/evaluate` projects
 *     `onFail: schedule?.onFail ?? 'block'`. The screen must say what the engine
 *     will do, and the engine blocks.
 *   · `{ timing: 'async' }` with no onFail -> 'observe_no_wait'. Async has only
 *     one legal onFail, so there is nothing else it could mean.
 *   · `{ timing: 'async', onFail: 'block' }` — the pair the type forbids and a
 *     hand-written row can still contain -> 'observe_no_wait'. TIMING WINS,
 *     because timing is what the engine acts on: the response has already gone,
 *     so this row logs whatever its `onFail` claims. A control that showed
 *     'block' here would be promising enforcement the engine does not deliver.
 */
export function toEnforcement(schedule: HookSchedule | undefined | null): GuardrailEnforcement {
  if (schedule?.timing === 'async') return 'observe_no_wait';
  return schedule?.onFail === 'log' ? 'observe' : 'block';
}

/**
 * The inverse, and the ONLY writer the screens need. A FRESH object every call:
 * a schedule is stored on both the binding and every policy bound to it, and
 * `setHookSchedule` copies one value onto many policies — a shared constant
 * there means one later edit silently rewrites all of them.
 */
export function fromEnforcement(value: GuardrailEnforcement): HookSchedule {
  switch (value) {
    case 'observe_no_wait':
      return { timing: 'async', onFail: 'log' };
    case 'observe':
      return { timing: 'sync', onFail: 'log' };
    case 'block':
    default:
      // `default` is unreachable through the type and deliberately present: this
      // reads a value off a form, and an unrecognised one must fail towards
      // enforcement rather than towards silently logging.
      return { timing: 'sync', onFail: 'block' };
  }
}

// ── 6b. Mode as one control ─────────────────────────────────────────────────

/**
 * `mode` and `enabled` are two columns describing ONE decision — `toGuardrailMode`
 * opens with `if (!enabled) return 'disabled'`, so the pair has exactly the
 * three states `GuardrailMode` already names. Persisting 'disabled' beside
 * `enabled: true` (or 'enforce' beside `enabled: false`) is not a state, it is a
 * disagreement, and the guardrail that comes out of it reads as on while
 * evaluating nothing.
 *
 * BOTH COLUMNS STAY. `enabled` is what an older console binary on the same
 * tenant database filters on and what `IGuardrail` has always required; `mode`
 * is what the verdict header publishes. What changes is that a human sets ONE
 * thing and these two functions are the only place the pair is assembled.
 */
export interface GuardrailModeFields {
  mode: GuardrailMode;
  enabled: boolean;
}

/**
 * The WRITE half: one mode in, both stored fields out, coherent by construction.
 * `enabled` is simply `mode !== 'disabled'`, which is exactly the fold
 * `toGuardrailMode` applies on the way back in.
 */
export function writeGuardrailMode(mode: GuardrailMode): GuardrailModeFields {
  return { mode, enabled: mode !== 'disabled' };
}

/**
 * The READ half, and deliberately a two-line wrapper over `toGuardrailMode`
 * rather than a second opinion: the aliases ('simulate', 'off') and the
 * `enabled` fold live in one function, and this one only says which two
 * properties to hand it.
 *
 * A missing `enabled` is read as ON. `IGuardrail.enabled` is required, so that
 * case is a PARTIAL — a form patch, a PATCH body naming only `mode` — where the
 * absent property means "leave it alone", never "turn it off".
 */
export function readGuardrailMode(record: { mode?: unknown; enabled?: boolean }): GuardrailMode {
  return toGuardrailMode(record.mode, record.enabled !== false);
}

/**
 * PAUSE / RESUME — the guardrails list's per-row switch, which is a different
 * control from the detail page's three-value Mode and needs a different write.
 *
 * THE BUG THIS REPLACES. The row used to send `{ enabled: !enabled }` alone.
 * Both provider mixins skip an absent field (`if (data.mode !== undefined)`),
 * so `mode` kept whatever it already said, and resuming a guardrail that had
 * been set to Off produced `{ mode: 'disabled', enabled: true }` — the one
 * pairing `toGuardrailMode` resolves AGAINST the switch. The list drew it as a
 * green "Active" row; the evaluator skipped it entirely.
 *
 * WHY THE TWO DIRECTIONS ARE NOT SYMMETRIC. The harm this pass exists to
 * prevent is one-directional: a guardrail that READS AS ON WHILE EVALUATING
 * NOTHING. That is `enabled: true` beside a mode resolving to disabled, and it
 * is the pairing every reader gets wrong. The mirror image, `enabled: false`
 * beside `mode: 'monitor'`, is not a disagreement anyone can act on — the fold
 * opens with `if (!enabled) return 'disabled'`, so the engine, every screen and
 * `/compiled`'s consumers all read it as off — and that column is the only
 * place a paused guardrail can remember it was WATCHING rather than blocking.
 *
 * So:
 *   · PAUSE sends `{ enabled: false }` and leaves `mode` alone. Resolved
 *     posture: off, at every reader. The memory survives.
 *   · RESUME sends the full pair from `writeGuardrailMode`, so nothing that
 *     reads as on is ever stored beside a mode that says otherwise.
 *
 * Writing `mode: 'disabled'` on pause instead would be coherent and WRONG: it
 * erases the distinction between a paused enforcing guardrail and a paused
 * watching one, and every resume after it silently promotes a guardrail that
 * was only recording into one that blocks live traffic. That is the single
 * direction an operator cannot undo after the fact.
 *
 * Returns the PATCH body, not a mode, because the two directions send
 * different sets of fields and a caller that had to remember which is a caller
 * that will eventually forget.
 */
export function toggleGuardrailFields(record: {
  mode?: unknown;
  enabled?: boolean;
}): Partial<GuardrailModeFields> {
  if (readGuardrailMode(record) !== 'disabled') return { enabled: false };
  // What the mode COLUMN says on its own, with the switch's override lifted —
  // that is the memory. A column that still reads disabled (or was never
  // written) has nothing to remember, and resumes to enforce.
  const remembered = toGuardrailMode(record.mode, true);
  return writeGuardrailMode(remembered === 'disabled' ? 'enforce' : remembered);
}

// ── 7. Policy hook eligibility ───────────────────────────────────────────────

/**
 * Which hooks each family may be bound to.
 *
 * THE ONE TABLE. It is both the save-time rule and the dispatch rule — the
 * engine indexes this directly, and there is deliberately no second, wider
 * runtime copy. A validator that refuses a binding the engine happily runs
 * means a hand-written row does something the UI calls illegal, and neither
 * side can see the disagreement.
 *
 * `prompt.pre` allows exactly what `input.pre` allows, because it carries
 * exactly the same subject: one `text`. The only family missing from both is
 * `tool_access`, and for the same reason in both — its subject is a tool call,
 * and a user turn contains none.
 *
 * `prompt_shield` on `output.pre` is NOT a relaxation, it is today's behaviour.
 * `evaluateGuardrail` runs the prompt shield in whichever phase it was called
 * in, so a guardrail attached through `outputGuardrailKey` shields the model's
 * output right now, and `liftLegacyPolicies` binds every lifted policy to both
 * `input.pre` and `output.pre`. Anything narrower here would reject a
 * configuration the fleet is already running and — because the engine read a
 * widened copy of this table — would have rejected it at save time while
 * running it at evaluation time.
 */
export const POLICY_VALID_HOOKS: Readonly<Record<PolicyFamily, readonly HookId[]>> = {
  pii: ['prompt.pre', 'input.pre', 'output.pre', 'output.stream.delta', 'tool.pre', 'tool.post'],
  secrets: ['prompt.pre', 'input.pre', 'output.pre', 'output.stream.delta', 'tool.pre', 'tool.post'],
  word_filter: ['prompt.pre', 'input.pre', 'output.pre', 'tool.post'],
  regex: ['prompt.pre', 'input.pre', 'output.pre', 'output.stream.delta', 'tool.pre', 'tool.post'],
  moderation: ['prompt.pre', 'input.pre', 'output.pre', 'tool.post'],
  prompt_shield: ['prompt.pre', 'input.pre', 'output.pre', 'tool.post'],
  custom: ['prompt.pre', 'input.pre', 'output.pre', 'tool.pre', 'tool.post'],
  tool_access: ['tool.pre', 'tool.post'],
  webhook: ['prompt.pre', 'input.pre', 'output.pre', 'tool.pre', 'tool.post'],
};

/**
 * Families allowed on `output.stream.delta`. Exactly the span-capable set, and
 * for a correctness reason rather than a cost one: the hold-back invariant
 * requires a BOUNDED match length in RAW characters, and word_filter's folding
 * is length-changing and joins non-contiguous tokens, so a six-character folded
 * pattern can straddle any window. The LLM families are excluded because a
 * judge call per window multiplies latency and model spend by the number of
 * windows. They all still run post-hoc on `output.pre`.
 */
export const STREAM_ELIGIBLE_FAMILIES: ReadonlySet<PolicyFamily> = new Set<PolicyFamily>([
  'pii',
  'secrets',
  'regex',
]);

/** Cheap, local, database-or-CPU only. They run BEFORE any LLM family. */
export const DETERMINISTIC_POLICY_FAMILIES: ReadonlySet<PolicyFamily> = new Set<PolicyFamily>([
  'pii',
  'secrets',
  'word_filter',
  'regex',
  'tool_access',
]);

/**
 * The families whose cost is a REMOTE ROUND TRIP — the three model-backed ones
 * plus `webhook` — and therefore the ones the engine runs in its LAST phase,
 * started together and awaited with `Promise.all`.
 *
 * THIS is the set the engine's phase test reads, never
 * `DETERMINISTIC_POLICY_FAMILIES`, and the asymmetry is deliberate: the test
 * must be TOTAL over a `family` string this build may never have heard of (a
 * row written by a newer console against the same tenant database), and an
 * unknown family has to run in the FIRST phase — the one whose dispatcher turns
 * it into a degraded entry. Asking "is it deterministic" instead would defer
 * such a policy to the model phase and change where its degradation is
 * reported.
 */
export const DEFERRED_PHASE_FAMILIES: ReadonlySet<PolicyFamily> = new Set<PolicyFamily>([
  'moderation',
  'prompt_shield',
  'custom',
  'webhook',
]);

/** A regex rule may not declare a longer bound than this; the save-time
 *  validator rejects it, and `policyMaxMatchChars` clamps a stored one so a bad
 *  row cannot inflate the stream hold-back to an arbitrary size. */
export const REGEX_MAX_MATCH_CHARS = 4096;

/** PEM header plus the generic token cap — the longest raw match the secret
 *  patterns can produce. */
const SECRETS_MAX_MATCH_CHARS = 512;

/** Longest raw-text match any PII category pattern can produce. */
const PII_MAX_MATCH_CHARS = 256;

/**
 * Longest raw-text match this policy can produce, or 0 for "unbounded or
 * non-deterministic". This is what sizes the stream hold-back window, so 0 is
 * the FAIL-SAFE answer: the save-time validator refuses to bind a policy
 * returning 0 to `output.stream.delta`, because a window sized for it would
 * have to be the whole answer.
 *
 * PII returns 0 unless `detectObfuscated` is explicitly false, because that
 * pass scans a normalised string whose length differs from the raw one — there
 * is no raw-character bound to state.
 */
export function policyMaxMatchChars(policy: GuardrailPolicy): number {
  switch (policy.family) {
    case 'regex': {
      let max = 0;
      for (const rule of policy.rules ?? []) {
        const declared = Number(rule.maxMatchChars);
        // An undeclared or nonsensical bound makes the whole policy unbounded:
        // one such rule is enough to break the hold-back guarantee.
        if (!Number.isFinite(declared) || declared <= 0) return 0;
        max = Math.max(max, Math.min(Math.trunc(declared), REGEX_MAX_MATCH_CHARS));
      }
      return max;
    }
    case 'secrets':
      return SECRETS_MAX_MATCH_CHARS;
    case 'pii':
      return policy.detectObfuscated === false ? PII_MAX_MATCH_CHARS : 0;
    default:
      return 0;
  }
}

// ── 8. Stream, message and visibility defaults ──────────────────────────────

export const DEFAULT_STREAM_SETTINGS: Required<StreamGuardSettings> = {
  enabled: false,
  holdBackChars: 256,
  holdBackMs: 200,
  overlapChars: 64,
  maxHeldChars: 4000,
  onBudgetExceeded: 'release',
  onBlock: 'truncate',
};

/**
 * The CLOSED variable set for a block message. `{{value}}`, `{{text}}` and
 * `{{span}}` deliberately do NOT exist: a template is tenant-editable and its
 * output is shown to end users, so an interpolatable matched value would turn
 * the guardrail into an exfiltration channel for the very data it exists to
 * protect.
 *
 * The default templates and the interpolator live in ./messages — see the
 * dependency rule at the top of this file:
 *     import { DEFAULT_BLOCK_MESSAGES, renderBlockMessage } from './messages';
 */
export const BLOCK_MESSAGE_VARS = [
  'guardrailName',
  'guardrailKey',
  'categories',
  'codes',
  'toolName',
  'requestId',
  'traceId',
] as const;
export type BlockMessageVar = (typeof BLOCK_MESSAGE_VARS)[number];

export interface RenderedBlockMessage {
  reasonClass: BlockReasonClass;
  body: string;
  mode: 'error' | 'replace';
  /** 400 by default — that is today's guardrail-block status and every deployed
   *  OpenAI-compatible client parses it. 446 only when opted in. */
  status: number;
  traceId: string;
}

export const DEFAULT_VERDICT_VISIBILITY: Required<VerdictVisibility> = {
  headers: true,
  useVerdictStatusCodes: false,
  detailedHeaders: false,
  aegisCompatHeaders: true,
};

export const VERDICT_HEADERS = {
  decision: 'x-cognipeer-guardrail', // allow|flag|warn|redact|block
  key: 'x-cognipeer-guardrail-key',
  hook: 'x-cognipeer-guardrail-hook',
  mode: 'x-cognipeer-guardrail-mode', // enforce|monitor|disabled
  enforced: 'x-cognipeer-guardrail-enforced', // true|false — the dry-run signal
  risk: 'x-cognipeer-guardrail-risk', // 0..100
  codes: 'x-cognipeer-guardrail-codes',
  trace: 'x-cognipeer-guardrail-trace-id',
  // Deprecated aliases, kept for one release because deployed SDK clients read
  // them today. Removed in v3.
  legacyTrace: 'x-aegis-trace-id',
  legacyDecision: 'x-aegis-decision',
  legacyPost: 'x-aegis-post-decision',
} as const;

export const VERDICT_STATUS = { passedWithFindings: 246, blocked: 446 } as const;

/** The status a block returns when verdict status codes are NOT opted into. */
export const DEFAULT_BLOCK_STATUS = 400;

// ── 9. Record shape ─────────────────────────────────────────────────────────
/**
 * `IGuardrail` already carries `hooks`/`hooksVersion`/`mode`, so these two are
 * aliases rather than an augmentation. They are kept because the rest of the
 * hook plane names `IGuardrailV2` to mean "a record read through the hook
 * plane, whose hooks may still need lifting", and because deriving the field
 * set with `Pick` makes it impossible for the two to drift.
 */
export type IGuardrailV2Fields = Pick<IGuardrail, 'hooks' | 'hooksVersion' | 'mode'>;
export type IGuardrailV2 = IGuardrail & IGuardrailV2Fields;

// ── 10. Call / verdict ──────────────────────────────────────────────────────

export interface HookActor {
  /**
   * MUST come from the authenticated context, NEVER from a request header: an
   * actor id a caller can choose is an actor id a caller can borrow, and
   * `allowedRoles` is keyed on it.
   */
  id: string;
  kind: 'user' | 'api_token' | 'agent' | 'system' | 'mcp_gateway';
  roles: string[];
}

export interface HookScope {
  tenantId: string;
  /** NEVER read from a client-supplied body or header. A remote enforcement
   *  endpoint derives it from the API token; there is no wire field for it. */
  tenantDbName: string;
  projectId?: string;
  actor: HookActor;
  surface: HookSurface;
  /** Persisted as `source` on the evaluation log — same values as today. */
  source: string;
  requestId?: string;
  traceId: string;
  /** Wall-clock budget for SYNC policies. On expiry, `failMode` decides. */
  budgetMs?: number;
  /**
   * THE ONE cancellation channel of the hook plane: the caller's abandoned
   * request, handed to every family unchanged, so a family needs exactly one
   * thing to honour and there is no second mechanism to keep in sync.
   */
  signal?: HookAbortSignal;
}

/**
 * Structural, NOT `AbortSignal`. Requiring the DOM type would force `lib.dom`
 * on every shared consumer, and the SDK avoids it for the same reason — so
 * `aborted` is the only member a producer MUST supply, and a bare
 * `{ aborted: false }` is still a valid signal.
 *
 * The two listener members are OPTIONAL and exist so that a real `AbortSignal`
 * — which is what a request-scoped caller already has — can be SUBSCRIBED to
 * rather than only polled. Polling is enough for a family that loops (pii walks
 * segments, tool_access walks URL arguments); it is NOT enough for one that is
 * parked in a single `await` on an outbound HTTP call, which can only be cut
 * short by handing this straight to `fetch`'s `signal` or by aborting a
 * controller from an `abort` listener — which is exactly what the webhook
 * family does, and why an abandoned request no longer leaves a webhook running
 * to completion. Declared as optional METHODS so that assigning a real
 * `AbortSignal` (whose `addEventListener` is wider on every parameter)
 * type-checks.
 */
export interface HookAbortSignal {
  readonly aborted: boolean;
  addEventListener?(type: 'abort', listener: () => void): void;
  removeEventListener?(type: 'abort', listener: () => void): void;
}

export interface HookCall<S extends HookSubject = HookSubject> {
  contractVersion: GuardrailContractVersion;
  hook: HookId;
  subject: S;
  scope: HookScope;
  guardrailKeys: string[];
  /**
   * Run ONLY these families. This is what lets a latency-sensitive caller ask
   * for just the deterministic part instead of racing the whole evaluation
   * against a hardcoded timeout.
   */
  only?: PolicyFamily[];
  /**
   * Suppress evaluation-log writes and usage events. Used by the red-team
   * runner, the dashboard test panel and the "would this block?" preview — one
   * flag in one place, instead of each of them reaching around the store.
   */
  shadow?: boolean;
  skipLogging?: boolean;
}

export interface HookVerdict<S extends HookSubject = HookSubject> {
  contractVersion: GuardrailContractVersion;
  hook: HookId;
  mode: GuardrailMode;
  /**
   * THE EFFECTIVE decision, ALREADY neutralised to 'allow' when
   * `mode !== 'enforce'`. Callers therefore need no `enforced` guard of their
   * own — and must not add one, because the enforcement path they replaced had
   * none and relied on exactly this property.
   */
  decision: SafetyAction;
  /** What WOULD have happened. This is the dry-run affordance. */
  wouldBeDecision: SafetyAction;
  enforced: boolean;
  /**
   * True when the guardrail is disabled or absent: no policies ran, so
   * `decision: 'allow'` is VACUOUS rather than "the content is safe". The test
   * panel must surface this; runtime enforcement may ignore it.
   */
  disabled: boolean;
  findings: SafetyFinding[];
  mutations: Mutation[];
  /** Present iff mutations were produced — `applyMutations` already ran. */
  subject?: S;
  /** Shortcut the legacy result reads as `redactedText`. */
  text?: string;
  riskScore: number;
  codes: string[];
  message?: RenderedBlockMessage;
  guardrailKeys: string[];
  /** First evaluated key — what the legacy result reports. */
  guardrailKey: string;
  guardrailName: string;
  /**
   * `${key}@${updatedAt.toISOString()}`, joined with '+' when several
   * guardrails were merged.
   *
   * NOT part of the `check` -> `policy` rename, and NOT renameable: it is the
   * FROZEN wire field `policy_version`, which a partner SDK reads. It has meant
   * "the version of the guardrail configuration this verdict was produced
   * under" since before the rename, and it keeps that meaning.
   */
  policyVersion: string;
  traceId: string;
  latencyMs: number;
  /** Policies that could not run; `failMode` has already been applied. */
  degraded?: Array<{ policyId: string; family: PolicyFamily; reason: string }>;
  /**
   * Policies that were STARTED and then abandoned before they answered. Their
   * findings and mutations are discarded with them.
   *
   * NOTHING POPULATES THIS TODAY, and that is a statement about the engine
   * rather than about the wire. The engine runs the deterministic families one
   * after another and starts the deferred ones together with `Promise.all`, so
   * every policy it starts is awaited: `shortCircuit` decides what is never
   * STARTED, which is not the same fact and needs no entry here. The field
   * stays because `/guardrails/hooks/evaluate` renders it (as `[]`) and a
   * remote enforcement point may already read the key — withdrawing a key a
   * consumer parses is a worse change than a permanently empty array — and
   * because the moment a hook abandons in-flight work again this is where it
   * has to be said.
   *
   * A DISTINCT LIST FROM `degraded` whenever it does carry anything, and the
   * distinction is the reason the hook plane exists: a policy that did not run
   * must never look like a policy that found nothing. `degraded` means "it
   * tried and could not" and carries a `failMode`-resolved finding with it;
   * this means "we stopped waiting for it" and carries no finding at all.
   */
  cancelled?: Array<{
    policyId: string;
    family: PolicyFamily;
    reason: string;
  }>;
}

/**
 * The vacuous verdict: no guardrail ran, so 'allow' means "nothing was
 * checked", not "this is safe". `disabled: true` is what carries that
 * distinction to the test panel and to the legacy facade's `disabled` flag.
 */
export function allowVerdict<S extends HookSubject>(input: {
  hook: HookId;
  traceId: string;
  guardrailKeys?: string[];
  guardrailKey?: string;
  guardrailName?: string;
  latencyMs?: number;
}): HookVerdict<S> {
  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook: input.hook,
    mode: 'disabled',
    decision: 'allow',
    wouldBeDecision: 'allow',
    enforced: false,
    disabled: true,
    findings: [],
    mutations: [],
    riskScore: 0,
    codes: [],
    guardrailKeys: input.guardrailKeys ?? [],
    guardrailKey: input.guardrailKey ?? '',
    guardrailName: input.guardrailName ?? '',
    policyVersion: '',
    traceId: input.traceId,
    latencyMs: input.latencyMs ?? 0,
  };
}

/**
 * max() over the ladder; concatenates findings, mutations, codes and degraded
 * entries in verdict order.
 *
 * `subject` / `text` are carried through ONLY when a single verdict produced
 * them. When two or more did, each rewrote a copy of the same original subject
 * and neither result contains the other's redaction — so the merged verdict
 * deliberately carries NO subject, and the engine must re-apply the merged
 * `mutations` list to the ORIGINAL subject in one pass. Picking a winner here
 * instead would silently drop one guardrail's redaction while the verdict still
 * claimed decision 'redact', which is the failure mode axiom A5 exists to
 * forbid: a verdict never claims enforcement it did not deliver.
 */
export function mergeVerdicts<S extends HookSubject>(
  hook: HookId,
  verdicts: Array<HookVerdict<S>>,
): HookVerdict<S> {
  const first = verdicts[0];
  if (!first) return allowVerdict<S>({ hook, traceId: '' });
  if (verdicts.length === 1) return first;

  const findings: SafetyFinding[] = [];
  const mutations: Mutation[] = [];
  const degraded: NonNullable<HookVerdict<S>['degraded']> = [];
  const cancelled: NonNullable<HookVerdict<S>['cancelled']> = [];
  const codes = new Set<string>();
  const guardrailKeys: string[] = [];
  const policyVersions: string[] = [];
  let riskScore = 0;
  // Wall-clock, not a sum: the engine evaluates guardrails inside one window,
  // and reporting the total CPU time as latency would inflate every dashboard
  // that charts it.
  let latencyMs = 0;

  for (const v of verdicts) {
    findings.push(...v.findings);
    mutations.push(...v.mutations);
    if (v.degraded) degraded.push(...v.degraded);
    if (v.cancelled) cancelled.push(...v.cancelled);
    for (const code of v.codes) codes.add(code);
    for (const key of v.guardrailKeys) {
      if (!guardrailKeys.includes(key)) guardrailKeys.push(key);
    }
    if (v.policyVersion) policyVersions.push(v.policyVersion);
    riskScore = Math.max(riskScore, v.riskScore);
    latencyMs = Math.max(latencyMs, v.latencyMs);
  }

  const carriers = verdicts.filter((v) => v.subject !== undefined || v.text !== undefined);
  const sole = carriers.length === 1 ? carriers[0] : undefined;

  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook,
    // One enforcing guardrail among monitors still enforces; 'disabled' only
    // survives when every merged verdict was disabled.
    mode: verdicts.some((v) => v.mode === 'enforce')
      ? 'enforce'
      : verdicts.some((v) => v.mode === 'monitor')
        ? 'monitor'
        : 'disabled',
    decision: foldActions(verdicts.map((v) => v.decision)),
    wouldBeDecision: foldActions(verdicts.map((v) => v.wouldBeDecision)),
    enforced: verdicts.some((v) => v.enforced),
    disabled: verdicts.every((v) => v.disabled),
    findings,
    mutations,
    subject: sole?.subject,
    text: sole?.text,
    riskScore,
    codes: [...codes],
    // The blocking verdict's message is the one a user must see; a warn-level
    // message from another guardrail would explain the wrong thing.
    message:
      verdicts.find((v) => v.decision === 'block' && v.message)?.message ??
      verdicts.find((v) => v.message)?.message,
    guardrailKeys,
    guardrailKey: first.guardrailKey,
    guardrailName: first.guardrailName,
    policyVersion: policyVersions.join('+'),
    traceId: first.traceId,
    latencyMs,
    degraded: degraded.length > 0 ? degraded : undefined,
    cancelled: cancelled.length > 0 ? cancelled : undefined,
  };
}

/**
 * THE one blocking error. Signature-compatible with the enforcement plane's
 * error it replaces — same `code` members, same `status` mapping, and the
 * deprecated `evaluation` getter — so the sandbox toolbox's `error.evaluation`
 * and its `202 : 403` branch compile with only an import-line change.
 */
export class GuardrailEnforcementError extends Error {
  readonly name = 'GuardrailEnforcementError';

  constructor(
    readonly code: 'blocked' | 'approval_required' | 'sandbox_unavailable',
    readonly verdict: HookVerdict,
  ) {
    super(verdict.message?.body ?? code);
  }

  /** @deprecated alias for `verdict`; kept so the sandbox toolbox keeps compiling. */
  get evaluation(): HookVerdict {
    return this.verdict;
  }

  get status(): number {
    return this.code === 'approval_required' ? 202 : 403;
  }
}

export { GuardrailEnforcementError as AegisEnforcementError };
