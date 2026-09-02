/**
 * The `webhook` policy family — a customer-supplied classifier as a first-class
 * policy.
 *
 * THE WIRE BODY *IS* THE CONTRACT TYPE. This family POSTs a `HookCall` and
 * parses a `HookVerdict`, the exact two shapes the in-process engine already
 * speaks and the exact two shapes `POST /api/client/v1/guardrails/hooks/evaluate`
 * accepts in reverse. That is deliberate and it is the whole point of the
 * family: a customer writes ONE guard service against ONE documented contract,
 * and an in-process family, a remote enforcement point and a customer endpoint
 * are then the same thing seen from three sides. A bespoke envelope here would
 * be a second contract to keep in sync with the first, and the second one is
 * always the one that drifts.
 *
 * PURITY. Like every other family, this one reports findings and PROPOSES
 * mutations; it never decides the action. The engine folds actions. That matters
 * more here than anywhere else, because the "detector" is a network endpoint a
 * tenant configured: see `parseVerdictBody` below for why a remote `decision` is
 * read as evidence and never as policy.
 *
 * EGRESS. Every request goes through `safeFetch` (`@/lib/security/outboundFetch`)
 * — the single SSRF definition in this repo. It DNS-resolves the host, rejects
 * loopback/private/link-local/metadata space, re-validates every redirect hop,
 * and honours both an `AbortSignal` and its own timeout. There is deliberately
 * no second URL validator in this file; a guardrail whose SSRF rules drift from
 * the rest of the console is a guardrail nobody can reason about.
 *
 * SIGNING follows the repo's existing convention verbatim
 * (`ocrJobWebhook.ts:60-65`, `crawlerWebhook.ts:83-90`):
 *   `x-cognipeer-signature: t=<unix-seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`>`
 * so a receiver that already verifies OCR or crawler callbacks verifies these
 * with the same code path.
 *
 * LATENCY IS THE HAZARD. This call sits INLINE on the request path — unlike the
 * OCR and crawler webhooks, which are best-effort background deliveries and can
 * afford 10s timeouts and 1s/2s/4s backoff. Three things bound it: a mandatory
 * per-policy budget enforced with an AbortController, retries that share that one
 * budget instead of multiplying it, and a circuit breaker so a webhook that has
 * started failing stops being dialled at all.
 */

import crypto from 'node:crypto';

import { createLogger } from '@/lib/core/logger';
import { safeFetch } from '@/lib/security/outboundFetch';

import {
  GUARDRAIL_CONTRACT_VERSION,
  LEGACY_FINDING_TYPE,
  SPAN_CAPABLE,
  toLegacyAction,
  type PolicyFamily,
  type GuardrailPolicy,
  type GuardrailFailMode,
  type HookActor,
  type HookCall,
  type HookId,
  type HookScope,
  type HookSubject,
  type Mutation,
  type SafetyAction,
  type SafetyFinding,
  type SubjectSegment,
  type WebhookPolicyConfig,
} from '../hooks/contract';
import { applyMutations } from '../hooks/mutations';
import { buildEvaluationErrorFinding, normalizeSeverity } from '../types';

const log = createLogger('guardrail:webhook');

const FAMILY: PolicyFamily = 'webhook';

// ── Budget ──────────────────────────────────────────────────────────────────
/**
 * 800ms. Chosen against what this competes with, not against what a webhook
 * would like: the whole deterministic pass (PII + secrets + regex) is
 * sub-millisecond, so this single policy is the entire p99 of a hook that uses
 * it. A budget is MANDATORY here even though `GuardrailPolicyBase.timeoutMs`
 * documents "0/absent = no timeout" — "no timeout" is a defensible default for
 * a local detector and an unacceptable one for a third-party socket.
 */
const DEFAULT_BUDGET_MS = 800;
/** Below this a request cannot complete a TLS handshake, so it would only ever
 *  produce timeouts that look like endpoint failures and trip the breaker. */
const MIN_BUDGET_MS = 50;
/** A ceiling an operator cannot raise past. 10s inline is already a bad day;
 *  beyond it the request is functionally hung and the caller should see a
 *  degraded verdict rather than wait. */
const MAX_BUDGET_MS = 10_000;
/** Do not start another attempt with less time than this left — an attempt that
 *  cannot finish only burns the remainder and reports a timeout. */
const MIN_ATTEMPT_MS = 120;

// ── Response caps ───────────────────────────────────────────────────────────
// Everything below arrives from an endpoint the console does not control, and
// most of it is persisted (findings land in the evaluation log) or rendered.
// Uncapped, a broken or hostile receiver turns one request into an unbounded
// write. The caps are generous enough that no honest classifier hits them.
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_FINDINGS = 50;
const MAX_MUTATIONS = 100;
const MAX_MESSAGE_CHARS = 512;
const MAX_VALUE_CHARS = 256;
const MAX_CATEGORY_CHARS = 64;
const MAX_CODE_CHARS = 64;
const MAX_REPLACEMENT_CHARS = 512;

// ── Circuit breaker ─────────────────────────────────────────────────────────
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
/** Bounded so a tenant cycling through generated URLs cannot grow the map
 *  without limit; eviction is insertion-order (Map preserves it). */
const MAX_TRACKED_CIRCUITS = 1000;

// ── Credential cache ────────────────────────────────────────────────────────
/** Same 60s/5s policy the rest of the guardrail plane uses: a hook runs on every
 *  request, and a provider read per call would add a DB round trip to the very
 *  latency this family is trying to bound. 5s on failure so a fixed provider
 *  starts working again in seconds rather than a minute. */
const CREDENTIAL_TTL_MS = 60_000;
const CREDENTIAL_FAILURE_TTL_MS = 5_000;
const MAX_CACHED_CREDENTIALS = 500;

/**
 * Machine codes this family emits. Append-only, like every other family's.
 * They are what an operator greps for when a webhook stops working, so each one
 * names a DISTINCT cause: "it timed out" and "it answered with nonsense" want
 * different fixes.
 */
export const WEBHOOK_CODES = {
  insecureUrl: 'webhook_insecure_url',
  circuitOpen: 'webhook_circuit_open',
  unavailable: 'webhook_unavailable',
  status: 'webhook_status',
  invalidResponse: 'webhook_invalid_response',
  contractMismatch: 'webhook_contract_mismatch',
  /** The budget ran out — the endpoint is up but too slow to be on this path. */
  timeout: 'webhook_timeout',
  /** The endpoint was NEVER dialled: the LOCAL budget handed to this policy —
   *  what the engine had left after earlier policies — was too small for one
   *  attempt. Not the endpoint's fault, so it never counts against the circuit
   *  breaker, and it is reported as an expired budget rather than a timeout. */
  budgetExpired: 'webhook_budget_expired',
  /** The CALLER walked away before the policy ran. Distinct from a timeout: this
   *  one is not the endpoint's fault and must not read as one in the logs. */
  aborted: 'webhook_aborted',
  /** The remote returned a non-allow decision but no findings — see
   *  `parseVerdictBody`. */
  verdict: 'webhook_verdict',
} as const;

/**
 * ONE sentence for every abandonment — today only the caller walking away, but
 * the wording covers any of them. It deliberately says nothing about WHY: from
 * the endpoint's side every abandonment is the same event, and the reason is
 * the engine's to report, not this message's.
 */
const ABANDONED_MESSAGE = 'The request was abandoned before the guardrail webhook answered.';

// ═══════════════════════════════════════════════════════════════════════════
// The shared family dispatch shape
// ═══════════════════════════════════════════════════════════════════════════
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
 * and they never look at the record. The engine folds the decision.
 */
export interface FamilyRunInput<C extends GuardrailPolicy = GuardrailPolicy> {
  policy: C;
  subject: HookSubject;
  hook: HookId;
  scope: HookScope;
  action: SafetyAction;
}

/** A policy that could not run. */
export interface FamilyDegradation {
  policyId: string;
  family: PolicyFamily;
  reason: string;
}

export interface FamilyRunResult {
  findings: SafetyFinding[];
  mutations: Mutation[];
  degraded?: FamilyDegradation[];
  /**
   * Detector-supplied risk, 0..100 — additive over the deterministic families'
   * result type, the same way the LLM family adds `gated`. A classifier's score
   * is its primary output and there is nowhere else on the result to put it, so
   * dropping it would mean a customer's risk model reached the console and then
   * evaporated. The engine folds with max().
   */
  riskScore?: number;
}

/**
 * The extra context THIS family needs and a deterministic one does not — the
 * same extension the LLM family makes for its model resolution. Every member is
 * optional, so an engine that builds ONE `FamilyRunInput` and passes it to all
 * nine adapters still type-checks here; each absent field degrades to a safe
 * default rather than to an error.
 */
export interface WebhookFamilyRunInput extends FamilyRunInput<WebhookPolicyConfig> {
  /** Record-level fallback; `policy.failMode` wins when both are set. */
  failMode?: GuardrailFailMode;
  /** Reported on the wire as `guardrailKeys`, and used only for the log line. */
  guardrailKey?: string;
  /**
   * Mutations the policies that already ran in THIS hook call produced. The
   * normative execution order (deterministic families first, then the LLM and
   * webhook families together) is what makes this well-defined by the time a
   * webhook runs, and it is what `redactBeforeSend` applies. Absent means "the
   * engine found nothing to redact yet", not "do not redact".
   */
  priorMutations?: readonly Mutation[];
  /** Red-team runner / test panel / "would this block?" preview. Passed through
   *  to the receiver so it can skip its own logging and billing too. */
  shadow?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Runtime knobs that are NOT on the persisted `GuardrailWebhookPolicyConfig`.
 *
 * They round-trip anyway — `hooks` is stored as one JSON blob (a `TEXT` column
 * on SQLite, an object on Mongo), so unknown keys survive a save — but they are
 * invisible to the type, to the save-time validator and to the config screen
 * until someone adds them to `provider/types.domain.ts`.
 *
 * `redactBeforeSend` USED TO BE ONE OF THESE and no longer is: it decides
 * whether a customer's endpoint receives text the guardrail has already decided
 * to redact, which is too consequential to leave as a key only this file knows
 * about. It now lives on the persisted type, where the validator and the config
 * screen can see it, and is read off `cfg` through the intersection below
 * exactly as before.
 */
export interface WebhookRuntimeOptions {
  /** Wall-clock ceiling for the whole policy, retries included. Default 800ms. */
  budgetMs?: number;
  /**
   * Send the STRUCTURED subject — segments, tool arguments, tool results, the
   * stream buffer, and the actor's id — instead of just the flattened text.
   * Default false, and false is the security-relevant half of that choice:
   * shipping a tool call's raw argument tree to a customer endpoint sends every
   * key, every path and every identifier the model was handed, not just the
   * prose a classifier needs.
   *
   * When absent this falls back to the persisted `send` field, whose own doc
   * comment says the same thing in fewer words.
   */
  includeState?: boolean;
  circuit?: {
    /** Consecutive failures before the endpoint is taken out of rotation. */
    failureThreshold?: number;
    /** How long it stays out on the first trip; doubles on each re-trip. */
    cooldownMs?: number;
  };
}

export type WebhookPolicy = WebhookPolicyConfig & WebhookRuntimeOptions;

// ═══════════════════════════════════════════════════════════════════════════
// Wire shapes
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The scope as it goes OUT, built field by field rather than by spreading and
 * deleting. That is not style: a field added to `HookScope` later would be
 * silently forwarded to every customer endpoint in the fleet by a spread, and
 * would not be by this.
 *
 * `tenantDbName` is absent because it is an internal database name and the input
 * to tenant switching — the one value in the whole scope that must never appear
 * on a wire in either direction (the inbound enforcement endpoint derives it
 * from the API token for exactly the same reason). `signal` is absent because it
 * is a live object, not data.
 */
export type WebhookHookScope = Omit<HookScope, 'tenantDbName' | 'signal' | 'actor'> & {
  /** `id` is withheld unless `includeState`: `kind` and `roles` are what a
   *  policy decision needs, the id is who the person is. */
  actor: Omit<HookActor, 'id'> & { id?: string };
};

/**
 * A SUBSET of `HookSubject`, never a superset. `kind` and `text` are always
 * present — `text` is the canonical flattening every classifier can consume —
 * and the structured members appear only under `includeState`. The identity
 * members (`toolName`, `providerRef`, `seq`, `final`, ...) are always sent:
 * they are policy identifiers rather than content, and a tool-safety classifier
 * that cannot see WHICH tool is being called cannot classify anything.
 */
export interface WebhookWireSubject {
  kind: HookSubject['kind'];
  text: string;
  segments?: SubjectSegment[];
  toolName?: string;
  requestedName?: string;
  providerRef?: string;
  sandboxAvailable?: boolean;
  args?: Record<string, unknown>;
  result?: unknown;
  delta?: string;
  buffer?: string;
  releasedTo?: number;
  seq?: number;
  final?: boolean;
}

export type WebhookHookCall = Omit<HookCall, 'scope' | 'subject'> & {
  subject: WebhookWireSubject;
  scope: WebhookHookScope;
};

// ═══════════════════════════════════════════════════════════════════════════
// Circuit breaker
// ═══════════════════════════════════════════════════════════════════════════
interface CircuitState {
  /** Consecutive failures since the last success. */
  failures: number;
  /** Number of times this circuit has opened; drives the cooldown backoff. */
  trips: number;
  /** Epoch ms before which no request is allowed. 0 = closed. */
  openUntil: number;
  /** While a half-open probe is in flight, no second probe may start. Carries a
   *  deadline rather than a boolean so a probe whose promise never settles
   *  cannot wedge the circuit open forever. */
  probeUntil: number;
}

/**
 * Keyed by tenant AND url. Sharing a breaker across tenants that happen to
 * configure the same endpoint would let one tenant's outage suppress another
 * tenant's policies, and "my guardrail stopped running because of someone else's
 * traffic" is not a failure mode this codebase accepts anywhere else.
 */
const circuits = new Map<string, CircuitState>();

function circuitKey(tenantId: string, url: string): string {
  // NUL separates because it cannot occur in either half, so no pair of
  // (tenant, url) values can collide by concatenation.
  return `${tenantId}\u0000${url}`;
}

function rememberCircuit(key: string, state: CircuitState): void {
  if (!circuits.has(key) && circuits.size >= MAX_TRACKED_CIRCUITS) {
    const oldest = circuits.keys().next();
    if (!oldest.done) circuits.delete(oldest.value);
  }
  circuits.set(key, state);
}

interface CircuitPermit {
  allowed: boolean;
  /** Set when refused: how long until the next probe is permitted. */
  retryInMs?: number;
}

/**
 * Closed -> every call passes. Open -> every call is refused without touching
 * the network, which is the point: a webhook that is timing out costs a full
 * budget per request, and the breaker is what converts "every request is 800ms
 * slower" into "one request per cooldown is".
 *
 * Half-open is a SINGLE probe. Letting the whole cooldown's worth of traffic
 * through at once is how a breaker re-buries an endpoint that was just coming
 * back up.
 */
function takeCircuitPermit(key: string, now: number): CircuitPermit {
  const state = circuits.get(key);
  if (!state || state.openUntil === 0) return { allowed: true };

  if (now < state.openUntil) {
    return { allowed: false, retryInMs: state.openUntil - now };
  }
  if (now < state.probeUntil) {
    // Another caller is already probing. Refusing here keeps the recovery cost
    // at one in-flight request no matter how much traffic arrives.
    return { allowed: false, retryInMs: state.probeUntil - now };
  }
  state.probeUntil = now + MAX_BUDGET_MS;
  return { allowed: true };
}

function recordCircuitSuccess(key: string): void {
  // Delete rather than reset: a healthy endpoint should cost no memory, and a
  // zeroed entry and an absent entry mean the same thing to `takeCircuitPermit`.
  circuits.delete(key);
}

function recordCircuitFailure(key: string, threshold: number, cooldownMs: number, now: number): void {
  const state = circuits.get(key) ?? { failures: 0, trips: 0, openUntil: 0, probeUntil: 0 };
  state.failures += 1;
  state.probeUntil = 0;

  if (state.failures >= threshold) {
    state.trips += 1;
    // Exponential, capped. A permanently misconfigured URL (a typo, a decommissioned
    // service) otherwise costs one wasted inline request every 30s forever.
    const backoff = Math.min(cooldownMs * 2 ** (state.trips - 1), MAX_COOLDOWN_MS);
    state.openUntil = now + backoff;
    state.failures = 0;
  }
  rememberCircuit(key, state);
}

/** Test seam. Module-level breaker state would otherwise leak between cases. */
export function resetWebhookCircuits(): void {
  circuits.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// Credentials
// ═══════════════════════════════════════════════════════════════════════════
interface CachedCredential {
  value?: string;
  expiresAt: number;
}

const credentialCache = new Map<string, CachedCredential>();

/** Test seam, and the invalidation hook a provider save should call. */
export function resetWebhookCredentialCache(): void {
  credentialCache.clear();
}

/**
 * `providerService` is reached through a DYNAMIC import so that
 * `@/lib/database` — which constructs providers and registers shutdown handlers
 * the moment it is loaded — stays off this module's import graph. That keeps the
 * family importable by a unit test and by the save-time validator without
 * booting the persistence layer.
 *
 * The promise is memoised rather than each caller issuing its own `import()`,
 * for two reasons. Node's module cache makes repeated imports cheap but not
 * free, and — the load-bearing one — TWO CONCURRENT `import()` CALLS FOR THE
 * SAME MOCKED MODULE DEADLOCK UNDER VITEST: both promises hang and the test
 * times out with no error. A policy carrying both `credentialProviderKey` and
 * `signingSecretRef` resolves them with `Promise.all`, which is exactly that
 * shape, so without this the two-secret configuration would be untestable.
 * (Reproduced on vitest 4.1.4; one import resolves, two never do.)
 */
let providerServiceModule:
  | Promise<typeof import('@/lib/services/providers/providerService')>
  | undefined;

function loadProviderService(): Promise<typeof import('@/lib/services/providers/providerService')> {
  if (!providerServiceModule) {
    providerServiceModule = import('@/lib/services/providers/providerService').catch((error) => {
      // Never memoise a rejection: a transient module-load failure would
      // otherwise disable every webhook policy for the life of the process.
      providerServiceModule = undefined;
      throw error;
    });
  }
  return providerServiceModule;
}

/** Resolves a provider-held secret (the bearer token, or the HMAC signing key). */
async function resolveProviderSecret(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  providerKey: string,
): Promise<string | undefined> {
  const key = `${tenantDbName}\u0000${projectId ?? ''}\u0000${providerKey}`;
  const now = Date.now();
  const cached = credentialCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  let value: string | undefined;
  let ttl = CREDENTIAL_TTL_MS;
  try {
    const { loadProviderRuntimeData } = await loadProviderService();
    const { credentials } = await loadProviderRuntimeData<Record<string, unknown>>(tenantDbName, {
      key: providerKey,
      tenantId,
      projectId,
    });
    value = pickCredentialValue(credentials);
    if (!value) ttl = CREDENTIAL_FAILURE_TTL_MS;
  } catch (error) {
    // Not fatal on its own: an unsigned or unauthenticated request may still be
    // what the endpoint expects. The receiver rejecting it is the honest failure,
    // and it arrives as a status code the operator can see.
    log.warn('Failed to resolve guardrail webhook credential', {
      providerKey,
      error: error instanceof Error ? error.message : String(error),
    });
    ttl = CREDENTIAL_FAILURE_TTL_MS;
  }

  if (!credentialCache.has(key) && credentialCache.size >= MAX_CACHED_CREDENTIALS) {
    const oldest = credentialCache.keys().next();
    if (!oldest.done) credentialCache.delete(oldest.value);
  }
  credentialCache.set(key, { value, expiresAt: now + ttl });
  return value;
}

/** The same field order `externalAgent.ts` uses, so a provider configured for a
 *  connected agent works unchanged as a webhook credential. */
function pickCredentialValue(credentials: Record<string, unknown>): string | undefined {
  for (const field of ['apiKey', 'api_key', 'token', 'accessToken', 'key', 'secret']) {
    const value = credentials[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Payload
// ═══════════════════════════════════════════════════════════════════════════
function projectSubject(subject: HookSubject, includeState: boolean): WebhookWireSubject {
  const wire: WebhookWireSubject = { kind: subject.kind, text: subject.text };
  if (includeState) wire.segments = subject.segments;

  switch (subject.kind) {
    case 'tool_call':
      wire.toolName = subject.toolName;
      wire.requestedName = subject.requestedName;
      wire.providerRef = subject.providerRef;
      wire.sandboxAvailable = subject.sandboxAvailable;
      if (includeState) wire.args = subject.args;
      break;
    case 'tool_result':
      wire.toolName = subject.toolName;
      wire.providerRef = subject.providerRef;
      if (includeState) {
        wire.args = subject.args;
        wire.result = subject.result;
      }
      break;
    case 'stream_delta':
      wire.delta = subject.delta;
      wire.releasedTo = subject.releasedTo;
      wire.seq = subject.seq;
      wire.final = subject.final;
      // `buffer` is only ever a duplicate of `text` (the stream_delta invariant
      // is one segment covering the whole buffer), so sending it unconditionally
      // would double the payload of every window for nothing.
      if (includeState) wire.buffer = subject.buffer;
      break;
    default:
      break;
  }
  return wire;
}

function projectScope(scope: HookScope, includeState: boolean, budgetMs: number): WebhookHookScope {
  return {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    actor: includeState
      ? { id: scope.actor.id, kind: scope.actor.kind, roles: scope.actor.roles }
      : { kind: scope.actor.kind, roles: scope.actor.roles },
    surface: scope.surface,
    source: scope.source,
    requestId: scope.requestId,
    traceId: scope.traceId,
    // The budget the RECEIVER has, not the one the run started with: telling it
    // "you have 800ms" when 200 remain invites an answer that arrives after the
    // request has already been abandoned.
    budgetMs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Response parsing
// ═══════════════════════════════════════════════════════════════════════════
/** Thrown for a response that is not a usable verdict. Carries the code so the
 *  caller can tell "endpoint answered with nonsense" from "endpoint is down". */
class WebhookResponseError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Retrying a malformed body produces the same malformed body. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WebhookResponseError';
  }
}

function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sliced = value.length > max ? value.slice(0, max) : value;
  // Third-party text that lands in log lines, in the end-user block message
  // (`{{categories}}`) and — via `finding.code` → `verdict.codes` — in a
  // response header. Line breaks and tabs collapse to one space; every other
  // C0/C1 control and DEL is dropped. An embedded CR/LF otherwise splits a log
  // line, injects a line into the block text, and makes Node refuse the whole
  // response with ERR_INVALID_CHAR once it reaches a header.
  const cleaned = sliced
    .replace(/[\t\n\r\u2028\u2029]+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .trim();
  return cleaned || undefined;
}

/**
 * `code` is a MACHINE token: it is matched by operators' alerting and written
 * into `x-guardrail-*` response headers, so it is narrowed to the characters a
 * code can consist of. Anything else is dropped rather than escaped — an
 * escaped code is a code nobody's grep matches.
 */
function clampCode(value: unknown, max: number): string | undefined {
  const cleaned = clampText(value, max)?.replace(/[^A-Za-z0-9_.:-]/g, '');
  return cleaned || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the body with a hard byte cap.
 *
 * The abort timer is deliberately still armed while this runs — a receiver that
 * answers `200` in 5ms and then dribbles the body for a minute is the same
 * hazard as one that never answers, and only the timer covers it. The cap covers
 * the other half: a fast, enormous body that would arrive well inside the budget.
 */
async function readCappedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new WebhookResponseError(
      `Response body exceeds ${MAX_RESPONSE_BYTES} bytes`,
      WEBHOOK_CODES.invalidResponse,
      false,
    );
  }

  const body = response.body;
  if (!body) return response.text();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new WebhookResponseError(
          `Response body exceeds ${MAX_RESPONSE_BYTES} bytes`,
          WEBHOOK_CODES.invalidResponse,
          false,
        );
      }
      chunks.push(value);
    }
  } finally {
    // Releasing before cancelling would leave the socket held open until GC.
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

interface ParsedVerdict {
  findings: SafetyFinding[];
  mutations: Mutation[];
  riskScore?: number;
}

/**
 * `HookVerdict` -> findings + mutations, with the remote's authority bounded at
 * every field.
 *
 * WHAT THE REMOTE CONTROLS: whether a finding exists, and its category,
 * severity, message, code, confidence and matched value; which segment a
 * redaction targets and what it is replaced with; and a risk score.
 *
 * WHAT IT DOES NOT: the action, the `critical` flag, or a span. An endpoint the
 * tenant pointed at is DATA, and letting data set the action would let a buggy
 * or compromised classifier escalate every request to a block (a self-inflicted
 * outage) or downgrade a block to a flag (the control quietly gone). The
 * operator's configured `action` decides what a finding DOES; the classifier
 * decides only WHETHER there is one.
 */
function parseVerdictBody(
  raw: unknown,
  policy: WebhookPolicy,
  ctx: WebhookFamilyRunInput,
  legacyAction: ReturnType<typeof toLegacyAction>,
): ParsedVerdict {
  if (!isRecord(raw)) {
    throw new WebhookResponseError('Response body is not a JSON object', WEBHOOK_CODES.invalidResponse, false);
  }

  // The enforcement plane's one-line guard, verbatim: absent is fine (a minimal
  // receiver may not echo it), a DIFFERENT version is not. Silently interpreting
  // a v3 body under v2 rules is how a contract change becomes a security bug
  // instead of an error.
  const version = raw.contractVersion;
  if (version !== undefined && version !== GUARDRAIL_CONTRACT_VERSION) {
    throw new WebhookResponseError(
      `Webhook answered with contract version ${String(version)}; this build speaks ${GUARDRAIL_CONTRACT_VERSION}`,
      WEBHOOK_CODES.contractMismatch,
      false,
    );
  }

  const segmentPaths = new Set(ctx.subject.segments.map((segment) => segment.path));
  // When `send` is 'text' the receiver never saw `segments`, so it cannot know a
  // pointer to name. A single-segment subject has exactly one place a rewrite
  // could mean, so an omitted path resolves to it rather than being dropped.
  const solePath = ctx.subject.segments.length === 1 ? ctx.subject.segments[0].path : undefined;

  const findings: SafetyFinding[] = [];
  const rawFindings = Array.isArray(raw.findings) ? raw.findings.slice(0, MAX_FINDINGS) : [];
  for (const entry of rawFindings) {
    if (!isRecord(entry)) continue;
    const finding: SafetyFinding = {
      // Every finding persists a legacy `type`, and webhook's is 'custom' —
      // LEGACY_FINDING_TYPE is the single source of that mapping.
      type: LEGACY_FINDING_TYPE.webhook,
      category: clampText(entry.category, MAX_CATEGORY_CHARS) ?? FAMILY,
      severity: normalizeSeverity(entry.severity),
      message:
        clampText(entry.message, MAX_MESSAGE_CHARS)
        ?? `Flagged by the ${policy.label ?? 'external'} guardrail webhook.`,
      action: legacyAction,
      block: legacyAction === 'block',
      family: FAMILY,
      hook: ctx.hook,
      policyId: policy.id,
    };

    const code = clampCode(entry.code, MAX_CODE_CHARS);
    if (code) finding.code = code;
    const value = clampText(entry.value, MAX_VALUE_CHARS);
    if (value) finding.value = value;
    const path = typeof entry.path === 'string' ? entry.path : undefined;
    // A pointer the subject does not have would make the finding point at a
    // place that does not exist; dropping the pointer keeps the finding.
    if (path && segmentPaths.has(path)) finding.path = path;
    const confidence = Number(entry.confidence);
    if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) {
      finding.confidence = confidence;
    }
    // `span` and `critical` are deliberately NOT read. `webhook` is not in
    // SPAN_CAPABLE — its verdicts are whole-text, so an offset it supplies was
    // computed against a flattening it may not even have received — and
    // `critical` forces a block regardless of the configured action, which is
    // exactly the policy decision a family does not get to make.

    findings.push(finding);
  }

  // A classifier that answers "block" without listing a reason has still
  // answered. Dropping that on the floor would make the policy look like it
  // passed, so it becomes one finding the engine can fold; what the finding DOES
  // is still the operator's configured action.
  const remoteDecision = typeof raw.decision === 'string' ? raw.decision : undefined;
  if (findings.length === 0 && remoteDecision && remoteDecision !== 'allow') {
    const message = isRecord(raw.message) ? clampText(raw.message.body, MAX_MESSAGE_CHARS) : undefined;
    findings.push({
      type: LEGACY_FINDING_TYPE.webhook,
      category: FAMILY,
      severity: normalizeSeverity(undefined),
      message: message ?? `The ${policy.label ?? 'external'} guardrail webhook rejected this content.`,
      action: legacyAction,
      block: legacyAction === 'block',
      family: FAMILY,
      hook: ctx.hook,
      policyId: policy.id,
      code: WEBHOOK_CODES.verdict,
    });
  }

  const mutations: Mutation[] = [];
  const rawMutations = Array.isArray(raw.mutations) ? raw.mutations.slice(0, MAX_MUTATIONS) : [];
  for (const entry of rawMutations) {
    if (!isRecord(entry)) continue;
    const op = entry.op;
    const path = typeof entry.path === 'string' && entry.path ? entry.path : solePath;
    if (!path) continue;

    if (op === 'replace_span' && !SPAN_CAPABLE.has(FAMILY)) {
      // Kept as a runtime check against the shared set rather than a hardcoded
      // `continue`, so that if `webhook` ever joins SPAN_CAPABLE this starts
      // accepting spans instead of silently ignoring them forever.
      continue;
    }

    if (op === 'replace_value') {
      if (!segmentPaths.has(path)) continue;
      const value = typeof entry.value === 'string' ? entry.value : '';
      const replacement = clampText(entry.replacement, MAX_REPLACEMENT_CHARS) ?? '';
      if (!value) continue;
      mutations.push({
        op: 'replace_value',
        path,
        value,
        replacement,
        family: FAMILY,
        policyId: policy.id,
        category: clampText(entry.category, MAX_CATEGORY_CHARS),
      });
      continue;
    }

    if (op === 'remove') {
      // Structural deletion is confined to the two content roots. Without this a
      // receiver could name any pointer at all — `/text` on a plain text subject,
      // or a path outside the subject entirely — and `remove` is the one op whose
      // effect cannot be inspected in the resulting string.
      if (!path.startsWith('/args') && !path.startsWith('/result')) continue;
      if (ctx.subject.kind !== 'tool_call' && ctx.subject.kind !== 'tool_result') continue;
      mutations.push({ op: 'remove', path, family: FAMILY, policyId: policy.id });
    }
  }

  const rawRisk = Number(raw.riskScore);
  const riskScore = Number.isFinite(rawRisk) ? Math.min(100, Math.max(0, rawRisk)) : undefined;

  return { findings, mutations, riskScore };
}

// ═══════════════════════════════════════════════════════════════════════════
// Degradation
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The single exit for "the policy could not run". `buildEvaluationErrorFinding`
 * is the house's one implementation of the fail-open/fail-closed rule (fail-open
 * surfaces a non-blocking `flag` so the outage is visible without changing the
 * verdict; fail-closed turns it into a real violation), and reimplementing it
 * here is how the two would drift.
 */
function degraded(input: {
  policy: WebhookPolicy;
  ctx: WebhookFamilyRunInput;
  /** `policy.failMode ?? record.failMode`, resolved by the caller. */
  failMode: GuardrailFailMode | undefined;
  legacyAction: ReturnType<typeof toLegacyAction>;
  code: string;
  message: string;
}): FamilyRunResult {
  const base = buildEvaluationErrorFinding({
    type: LEGACY_FINDING_TYPE.webhook,
    failMode: input.failMode,
    action: input.legacyAction,
    message: input.message,
  });
  return {
    findings: [
      {
        ...base,
        family: FAMILY,
        hook: input.ctx.hook,
        policyId: input.policy.id,
        code: input.code,
      },
    ],
    mutations: [],
    degraded: [{ policyId: input.policy.id, family: FAMILY, reason: input.code }],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════════════
function resolveBudgetMs(policy: WebhookPolicy, scope: HookScope): number {
  // `timeoutMs` is the generic per-policy field and means "0/absent = no timeout"
  // everywhere else; here absent falls through to the default instead, because a
  // third-party socket with no deadline is the failure this family exists to
  // avoid.
  const declared = Number(policy.budgetMs ?? (Number(policy.timeoutMs) > 0 ? policy.timeoutMs : undefined));
  const wanted = Number.isFinite(declared) && declared > 0 ? declared : DEFAULT_BUDGET_MS;
  // `scope.budgetMs` is the run's whole budget, and the family is not told how
  // much of it is already spent — so it is applied as a CEILING, not as a
  // remaining-time calculation it cannot honestly make.
  const ceiling = Number(scope.budgetMs) > 0 ? Math.min(wanted, Number(scope.budgetMs)) : wanted;
  return Math.min(MAX_BUDGET_MS, Math.max(MIN_BUDGET_MS, Math.trunc(ceiling)));
}

/**
 * Runs one `webhook` policy.
 *
 * Never throws: every failure path — a bad URL, an open circuit, a timeout, a
 * non-200, an unparseable body — returns through `degraded()`, so `failMode`
 * decides the outcome exactly once and the engine's `Promise.all` cannot be
 * rejected by a third party's endpoint.
 */
export async function runWebhookPolicy(ctx: WebhookFamilyRunInput): Promise<FamilyRunResult> {
  const cfg = ctx.policy as WebhookPolicy;
  // The engine filters, but a family must never run a policy it was handed
  // disabled — the red-team runner and the test panel dispatch directly.
  if (!cfg.enabled) return { findings: [], mutations: [] };

  // Idempotent, and identical to every sibling adapter: when the engine has
  // already resolved the effective action this is a no-op, and when a caller
  // passes the record's action it still honours the per-policy override.
  const legacyAction = toLegacyAction(cfg.action ?? ctx.action);
  const failMode = cfg.failMode ?? ctx.failMode;
  const fail = (code: string, message: string): FamilyRunResult =>
    degraded({ policy: cfg, ctx, failMode, legacyAction, code, message });

  const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';
  // Re-checked here even though the save-time validator enforces it: rows
  // written before that validator existed are still on disk, and the body this
  // POSTs carries the subject text — over http that is the guardrail publishing
  // the very content it was configured to protect.
  if (!url || !url.toLowerCase().startsWith('https://')) {
    return fail(WEBHOOK_CODES.insecureUrl, 'Guardrail webhook URL must be an https:// endpoint.');
  }

  const now = Date.now();
  const key = circuitKey(ctx.scope.tenantId, url);
  const permit = takeCircuitPermit(key, now);
  if (!permit.allowed) {
    return fail(
      WEBHOOK_CODES.circuitOpen,
      `Guardrail webhook is temporarily out of rotation after repeated failures; retrying in ${Math.ceil((permit.retryInMs ?? 0) / 1000)}s.`,
    );
  }

  // Cheapest check first: never dial out for a request that is already gone.
  // The in-flight case is handled per attempt below, by linking this signal to
  // the attempt's own controller.
  if (ctx.scope.signal?.aborted) {
    return fail(WEBHOOK_CODES.aborted, 'The request was abandoned before the guardrail webhook could run.');
  }

  const budgetMs = resolveBudgetMs(cfg, ctx.scope);
  const includeState = cfg.includeState ?? cfg.send === 'subject';
  const redactBeforeSend = cfg.redactBeforeSend !== false;

  // Redact with what this run has already found, before anything leaves the
  // process. `applyMutations` clones only the containers it rewrites, so the
  // caller's subject is untouched and the engine's later single-pass application
  // over the ORIGINAL subject is unaffected.
  let outgoing = ctx.subject;
  let redactions = 0;
  if (redactBeforeSend && ctx.priorMutations && ctx.priorMutations.length > 0) {
    const outcome = applyMutations(ctx.subject, ctx.priorMutations);
    outgoing = outcome.subject;
    redactions = outcome.applied.length;
  }

  const body: WebhookHookCall = {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook: ctx.hook,
    subject: projectSubject(outgoing, includeState),
    scope: projectScope(ctx.scope, includeState, budgetMs),
    guardrailKeys: ctx.guardrailKey ? [ctx.guardrailKey] : [],
    ...(ctx.shadow ? { shadow: true } : {}),
  };
  // Serialised ONCE and reused for both the signature and the request. The OCR
  // and crawler webhooks call JSON.stringify twice; V8 happens to produce
  // identical bytes, but a signature computed over a different serialisation
  // than the one sent is a bug that only shows up as "the receiver rejects
  // everything", so it is not worth relying on.
  const bodyJson = JSON.stringify(body);

  const [bearer, signingSecret] = await Promise.all([
    cfg.credentialProviderKey
      ? resolveProviderSecret(
        ctx.scope.tenantDbName,
        ctx.scope.tenantId,
        ctx.scope.projectId,
        cfg.credentialProviderKey,
      )
      : Promise.resolve(undefined),
    cfg.signingSecretRef
      ? resolveProviderSecret(
        ctx.scope.tenantDbName,
        ctx.scope.tenantId,
        ctx.scope.projectId,
        cfg.signingSecretRef,
      )
      : Promise.resolve(undefined),
  ]);

  // Stable across retries so a receiver can dedupe a redelivery it already
  // answered; the signature's own `t=` is what bounds a replay window.
  const deliveryId = `gr_${crypto.randomUUID().replace(/-/g, '')}`;
  const host = safeHost(url);
  const threshold = Math.max(1, Math.trunc(cfg.circuit?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD));
  const cooldownMs = Math.max(1_000, Math.trunc(cfg.circuit?.cooldownMs ?? DEFAULT_COOLDOWN_MS));

  const deadline = Date.now() + budgetMs;
  // Retries share ONE budget rather than each getting their own, and there is no
  // backoff sleep between them: the OCR and crawler webhooks can afford 1s/2s/4s
  // because nobody is waiting: here a user is.
  const attempts = 1 + Math.min(2, Math.max(0, Math.trunc(Number(cfg.retries ?? 0)) || 0));
  // Widened to `string`: WEBHOOK_CODES is `as const`, so an inferred literal type
  // here would reject every later assignment of a different code.
  let lastCode: string = WEBHOOK_CODES.unavailable;
  let lastMessage = 'The guardrail webhook could not be reached.';
  /** Whether any attempt actually reached `safeFetch`. The breaker only ever
   *  counts what the ENDPOINT did, and an endpoint that was never dialled did
   *  nothing. */
  let dialed = false;

  const outerSignal = ctx.scope.signal;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Re-checked per attempt, not only before the first: a 5xx retry must not
    // redial for a layer that ended (or a caller that left) while the previous
    // attempt was in flight.
    if (outerSignal?.aborted) {
      return fail(WEBHOOK_CODES.aborted, ABANDONED_MESSAGE);
    }

    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      if (!dialed) {
        // The LOCAL budget was too small before the first attempt — the engine
        // spent most of `scope.budgetMs` on earlier policies, or the caller
        // set one under `MIN_ATTEMPT_MS`. That is a fact about this request,
        // not about the endpoint: counted as a breaker failure, five such
        // requests would take a healthy webhook out of rotation for every
        // request in the tenant, and under `failMode: 'closed'` block them all
        // with `webhook_circuit_open`.
        return fail(
          WEBHOOK_CODES.budgetExpired,
          `The guardrail webhook was not called: ${Math.max(0, remaining)}ms of the evaluation budget remained ` +
            `and one attempt needs at least ${MIN_ATTEMPT_MS}ms.`,
        );
      }
      lastCode = WEBHOOK_CODES.timeout;
      lastMessage = `The guardrail webhook did not answer within ${budgetMs}ms.`;
      break;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    // THE LAST MILE OF CANCELLATION. Polling the scope before the loop only
    // avoids dialling out; it does nothing for a request already parked in the
    // `await` below, which is where a webhook actually spends its time. The
    // engine hands every family the CALLER's scope — whose signal is a real
    // `AbortSignal` when the caller has one — and `HookAbortSignal` declares
    // the listener pair optionally, so mirroring it onto this attempt's
    // controller is what turns "abandoned" into "aborted": the receiver stops
    // being asked for a verdict nobody will read.
    //
    // Optional-call because the pair IS optional: a caller may still supply a
    // poll-only `{ aborted }`, in which case this degrades to the old
    // behaviour rather than throwing.
    const onOuterAbort = (): void => controller.abort();
    outerSignal?.addEventListener?.('abort', onOuterAbort);
    try {
      dialed = true;
      const response = await safeFetch(
        url,
        {
          method: 'POST',
          headers: buildHeaders({ cfg, bodyJson, bearer, signingSecret, deliveryId, redactBeforeSend, redactions }),
          body: bodyJson,
          signal: controller.signal,
        },
        // Belt and braces: our controller covers the body read below, safeFetch's
        // own timer covers the redirect loop it runs internally, and without this
        // it would default to the 30s outbound timeout.
        { timeoutMs: remaining },
      );

      // A verdict is a synchronous answer. 201/202/204 are not answers, and
      // treating them as success would mean parsing an empty body into "allow" —
      // the one outcome a guardrail must never invent.
      if (response.status !== 200) {
        const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
        // Drain so the socket returns to the pool instead of being torn down.
        await response.body?.cancel().catch(() => undefined);
        lastCode = WEBHOOK_CODES.status;
        lastMessage = `The guardrail webhook answered with HTTP ${response.status}.`;
        if (retryable && attempt < attempts - 1) continue;
        recordCircuitFailure(key, threshold, cooldownMs, Date.now());
        return fail(lastCode, lastMessage);
      }

      const text = await readCappedText(response);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text) as unknown;
      } catch {
        throw new WebhookResponseError(
          'The guardrail webhook answered with a body that is not JSON.',
          WEBHOOK_CODES.invalidResponse,
          false,
        );
      }

      const parsed = parseVerdictBody(parsedJson, cfg, ctx, legacyAction);
      recordCircuitSuccess(key);
      return {
        findings: parsed.findings,
        mutations: parsed.mutations,
        riskScore: parsed.riskScore,
      };
    } catch (error) {
      if (error instanceof WebhookResponseError) {
        lastCode = error.code;
        lastMessage = error.message;
        if (error.retryable && attempt < attempts - 1) continue;
        recordCircuitFailure(key, threshold, cooldownMs, Date.now());
        return fail(lastCode, lastMessage);
      }

      const message = error instanceof Error ? error.message : String(error);

      // OUR OWN CANCELLATION IS NOT THE ENDPOINT'S FAULT, and it is checked
      // before the timeout reading because both arrive as an `AbortError`.
      // Two things follow, and both matter. Reporting it as a timeout would
      // put "did not answer within 800ms" in the audit log for a call that was
      // cut at 20ms — a false statement about a healthy receiver. And
      // `recordCircuitFailure` here would let a burst of cancelled requests
      // take a webhook that never failed out of rotation for every OTHER
      // request, which is a self-inflicted outage.
      if (outerSignal?.aborted) {
        return fail(WEBHOOK_CODES.aborted, ABANDONED_MESSAGE);
      }

      const aborted = errorName(error) === 'AbortError';
      lastCode = aborted ? WEBHOOK_CODES.timeout : WEBHOOK_CODES.unavailable;
      lastMessage = aborted
        ? `The guardrail webhook did not answer within ${budgetMs}ms.`
        : `The guardrail webhook could not be reached: ${message}`;
      log.warn('Guardrail webhook call failed', {
        // Host only, never the full URL: an operator-configured endpoint may
        // carry a token in its query string, and the logger redacts by key name,
        // which cannot see inside a URL.
        host,
        hook: ctx.hook,
        policyId: cfg.id,
        guardrailKey: ctx.guardrailKey,
        attempt: attempt + 1,
        error: message,
      });
      // A timeout is worth one more try inside the same budget; an SSRF refusal
      // or a DNS failure is deterministic and will not change in 200ms.
      const retryable = aborted || !isDeterministicNetworkError(error);
      if (retryable && attempt < attempts - 1) continue;
      recordCircuitFailure(key, threshold, cooldownMs, Date.now());
      return fail(lastCode, lastMessage);
    } finally {
      clearTimeout(timer);
      // Released per attempt. A retrying webhook subscribes to the same
      // request-scoped signal once per attempt, and a listener that is never
      // removed accumulates for the life of the request.
      outerSignal?.removeEventListener?.('abort', onOuterAbort);
    }
  }

  recordCircuitFailure(key, threshold, cooldownMs, Date.now());
  return fail(lastCode, lastMessage);
}

/**
 * `name` off an arbitrary throw value, WITHOUT `instanceof Error`: an aborted
 * `fetch` rejects with a `DOMException`, which is not reliably an `Error`
 * subclass across Node versions, and misreading a timeout as a generic network
 * failure would put the wrong code in the audit log.
 */
function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

/** `OutboundNetworkError` is raised for a refused target or an unusable URL — a
 *  verdict about the CONFIGURATION, which a retry cannot change. Matched by name
 *  rather than by importing the class, so this file keeps exactly one import from
 *  the outbound module and stays trivially mockable in a unit test. */
function isDeterministicNetworkError(error: unknown): boolean {
  return errorName(error) === 'OutboundNetworkError';
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

function buildHeaders(input: {
  cfg: WebhookPolicy;
  bodyJson: string;
  bearer?: string;
  signingSecret?: string;
  deliveryId: string;
  redactBeforeSend: boolean;
  redactions: number;
}): Record<string, string> {
  // Operator headers go on FIRST so the computed ones below always win. An
  // operator who could overwrite `x-cognipeer-signature` from the config screen
  // would be able to disable request signing without the UI ever saying so.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.cfg.headers ?? {})) {
    if (typeof value === 'string' && name.trim()) headers[name.trim().toLowerCase()] = value;
  }

  if (input.bearer && !headers.authorization) {
    headers.authorization = `Bearer ${input.bearer}`;
  }

  const t = Math.floor(Date.now() / 1000);
  headers['content-type'] = 'application/json';
  headers['user-agent'] = 'cognipeer-guardrail/1.0';
  headers['x-cognipeer-delivery-id'] = input.deliveryId;
  // A convenience mirror of the `t=` inside the signature. It is NOT covered by
  // the HMAC and a receiver must therefore reject a stale request on the SIGNED
  // value; this one exists so a receiver can log or rate-limit before it has done
  // any crypto.
  headers['x-cognipeer-timestamp'] = String(t);
  if (input.redactBeforeSend) {
    // How many rewrites were actually applied, not a bare "redacted: true".
    // `redactBeforeSend` can only remove what another policy already found, so
    // claiming the payload is clean would be a promise this family cannot keep.
    headers['x-cognipeer-guardrail-redactions'] = String(input.redactions);
  }

  if (input.signingSecret) {
    // Identical to ocrJobWebhook.ts:60-65 and crawlerWebhook.ts:83-90 — same
    // `${t}.${body}` preimage, same `t=<unix>,v1=<hex>` encoding, same header —
    // so a receiver already verifying either of those verifies this unchanged.
    // Re-signed on every attempt: a retry that reused the first attempt's
    // timestamp would age out of a receiver's replay window and be rejected for
    // the wrong reason.
    const sig = crypto
      .createHmac('sha256', input.signingSecret)
      .update(`${t}.${input.bodyJson}`)
      .digest('hex');
    headers['x-cognipeer-signature'] = `t=${t},v1=${sig}`;
  }

  return headers;
}
