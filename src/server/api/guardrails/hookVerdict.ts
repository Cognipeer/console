import type { FastifyReply } from 'fastify';
import type { GuardrailHooksConfig, IUser } from '@/lib/database';
import { runHook } from '@/lib/services/guardrail';
// Reached at its own path, like the hook-plane modules in the route plugins:
// the service barrel re-exports only the hook plane's entry points.
import {
  DEFAULT_VERDICT_VISIBILITY,
  GUARDRAIL_CONTRACT_VERSION,
  HOOK_IDS,
  HOOK_SUBJECT_KIND,
  isPlainRecord,
  POLICY_FAMILIES,
  textSubject,
  toolCallSubject,
  toolResultSubject,
  VERDICT_HEADERS,
  VERDICT_STATUS,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  PolicyFamily,
  HookId,
  HookScope,
  HookSubject,
  HookVerdict,
  VerdictVisibility,
} from '@/lib/services/guardrail/hooks/contract';
import { buildUserMessage } from '../plugins/guardrail-write';

// ── Hook evaluation over the wire ─────────────────────────────────────────

/**
 * Build the subject a hook expects out of a request body.
 *
 * The shape is driven by `HOOK_SUBJECT_KIND`, not by a hand-written switch over
 * hook ids, so a hook added to the contract lands here as a compile error
 * rather than as a route that silently accepts the wrong payload.
 */
export function buildHookSubject(
  hook: HookId,
  body: Record<string, unknown>,
): { subject?: HookSubject; error?: string } {
  const kind = HOOK_SUBJECT_KIND[hook];
  switch (kind) {
    case 'text': {
      if (typeof body.text !== 'string') {
        return { error: `text is required for hook "${hook}"` };
      }
      return { subject: textSubject(body.text) };
    }
    case 'tool_call':
    case 'tool_result': {
      if (typeof body.tool_name !== 'string' || body.tool_name.trim() === '') {
        return { error: `tool_name is required for hook "${hook}"` };
      }
      if (body.tool_args !== undefined && !isPlainRecord(body.tool_args)) {
        return { error: 'tool_args must be an object' };
      }
      const args = isPlainRecord(body.tool_args) ? body.tool_args : {};
      // Informational only — it reaches the webhook family's wire body and
      // nothing that gates a decision — so it defaults rather than 400s.
      const providerRef = typeof body.provider_ref === 'string' ? body.provider_ref : 'api';
      if (kind === 'tool_result') {
        if (body.tool_result === undefined) {
          return { error: `tool_result is required for hook "${hook}"` };
        }
        return {
          subject: toolResultSubject({
            toolName: body.tool_name,
            args,
            result: body.tool_result,
            providerRef,
          }),
        };
      }
      return {
        subject: toolCallSubject({
          toolName: body.tool_name,
          requestedName:
            typeof body.requested_name === 'string' ? body.requested_name : undefined,
          args,
          providerRef,
          sandboxAvailable:
            typeof body.sandbox_available === 'boolean' ? body.sandbox_available : undefined,
        }),
      };
    }
    case 'stream_delta': {
      if (typeof body.buffer !== 'string') {
        return {
          error:
            'buffer is required for hook "output.stream.delta" (the full accumulated channel text; spans are absolute into it)',
        };
      }
      const buffer = body.buffer;
      const releasedTo =
        typeof body.released_to === 'number' && Number.isFinite(body.released_to)
          ? Math.max(0, Math.min(Math.trunc(body.released_to), buffer.length))
          : 0;
      // There is no `streamDeltaSubject` builder in the contract — the stream
      // gate is the only in-process producer and builds it inline — so the
      // INVARIANT is reproduced here explicitly: exactly ONE segment covering
      // the whole buffer, at the gate's own `/buffer` pointer, so `text ===
      // buffer` and `applyMutations` can write a redaction back into the string
      // the caller actually emits.
      return {
        subject: {
          kind: 'stream_delta',
          text: buffer,
          segments: [{ path: '/buffer', text: buffer }],
          delta: typeof body.delta === 'string' ? body.delta : buffer.slice(releasedTo),
          buffer,
          releasedTo,
          seq: typeof body.seq === 'number' && Number.isFinite(body.seq) ? body.seq : 0,
          final: body.final === true,
        },
      };
    }
  }
}

export interface HookEvaluationOptions {
  only?: PolicyFamily[];
  shadow?: boolean;
  budgetMs?: number;
  requestId?: string;
}

/**
 * What the AUTHENTICATED CONTEXT — never the body — allows an evaluation
 * request to ask for.
 */
export interface HookEvaluationAccess {
  /**
   * May this caller run in `shadow`? Shadow suppresses BOTH the evaluation-log
   * row and the usage event (`engine.ts`), so honouring it for a client API
   * token would let a tenant integration evaluate for free and off the record
   * by adding one body field — and "every evaluation is logged" would not hold
   * for that route. Only a dashboard session held by an admin may preview; for
   * everyone else the flag is silently forced OFF rather than rejected, so a
   * caller that copied the dashboard's request body still gets its verdict, on
   * the record. Defaults to false: a route has to opt in.
   */
  allowShadow: boolean;
}

/**
 * The roles that may suppress the audit trail for a preview. `user` is a
 * project member with no administrative standing; the three admin roles are
 * the ones who could, in any case, read and delete the log rows a shadow run
 * would not have written.
 */
export function canRequestShadowEvaluation(user: Pick<IUser, 'role'> | undefined): boolean {
  return user?.role === 'owner' || user?.role === 'admin' || user?.role === 'project_admin';
}

export function readHookEvaluationOptions(
  body: Record<string, unknown>,
  access: HookEvaluationAccess = { allowShadow: false },
): { options?: HookEvaluationOptions; error?: string } {
  let only: PolicyFamily[] | undefined;
  if (body.only !== undefined) {
    if (!Array.isArray(body.only)) return { error: 'only must be an array of policy families' };
    const families: PolicyFamily[] = [];
    for (const entry of body.only) {
      if (typeof entry !== 'string' || !POLICY_FAMILIES.includes(entry as PolicyFamily)) {
        return { error: `only contains an unknown policy family "${String(entry)}"` };
      }
      families.push(entry as PolicyFamily);
    }
    only = families;
  }

  let budgetMs: number | undefined;
  if (body.budget_ms !== undefined) {
    if (typeof body.budget_ms !== 'number' || !Number.isFinite(body.budget_ms) || body.budget_ms <= 0) {
      return { error: 'budget_ms must be a positive number of milliseconds' };
    }
    budgetMs = Math.trunc(body.budget_ms);
  }

  return {
    options: {
      only,
      // Opt-IN, and GATED. A remotely-connected enforcement point is real
      // traffic: its evaluations belong in the audit trail and on the bill.
      // Only a preview ("would this block?") asks for shadow, it has to say
      // so, and the caller has to be one `access` lets ask — the client API
      // token route never is.
      shadow: access.allowShadow && body.shadow === true,
      budgetMs,
      requestId: typeof body.request_id === 'string' ? body.request_id : undefined,
    },
  };
}

/**
 * Verdict visibility, defaults filled in field by field.
 *
 * Not a spread over `DEFAULT_VERDICT_VISIBILITY`: every field of the stored
 * object is optional, so `{ ...defaults, ...stored }` would overwrite a default
 * with `undefined` for any key the operator has not touched.
 */
export function resolveVerdictVisibility(
  hooks: GuardrailHooksConfig | undefined,
): Required<VerdictVisibility> {
  const visibility = hooks?.visibility;
  return {
    headers: visibility?.headers ?? DEFAULT_VERDICT_VISIBILITY.headers,
    useVerdictStatusCodes:
      visibility?.useVerdictStatusCodes ?? DEFAULT_VERDICT_VISIBILITY.useVerdictStatusCodes,
    detailedHeaders: visibility?.detailedHeaders ?? DEFAULT_VERDICT_VISIBILITY.detailedHeaders,
    aegisCompatHeaders:
      visibility?.aegisCompatHeaders ?? DEFAULT_VERDICT_VISIBILITY.aegisCompatHeaders,
  };
}

/** The alphabet a finding code may use on the wire, per code and in total. */
const HEADER_CODE_FORBIDDEN = /[^A-Za-z0-9_.:-]/g;
const HEADER_CODE_MAX_CHARS = 64;
const HEADER_CODES_MAX_CHARS = 1024;

/**
 * Finding codes come from policy configs AND from webhook responses — remote
 * text. Node refuses a header value containing CR/LF (`ERR_INVALID_CHAR`), so
 * one webhook answering `code: "x\r\n"` would turn every hook response for
 * that guardrail into a 500. Restricted to a token alphabet and capped —
 * rather than merely stripped of CR/LF — so the header stays a comma-separated
 * list of tokens whatever a remote sends; a code that sanitises to nothing is
 * dropped, duplicates are folded, and the total is cut at a token boundary.
 * Returns undefined when nothing survives, so no empty header is set.
 */
export function headerSafeCodes(codes: readonly string[]): string | undefined {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const code of codes) {
    const token = code.replace(HEADER_CODE_FORBIDDEN, '').slice(0, HEADER_CODE_MAX_CHARS);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  let joined = tokens.join(',');
  if (joined.length > HEADER_CODES_MAX_CHARS) {
    joined = joined.slice(0, HEADER_CODES_MAX_CHARS).replace(/,[^,]*$/, '');
  }
  return joined || undefined;
}

/**
 * Describe the verdict in response headers.
 *
 * The core set is ALWAYS emitted — that is the owner's call, and it is the
 * cheap half of the deal that makes the status codes opt-in: an integrator can
 * always see what a guardrail decided without having to opt into a status code
 * their HTTP client may not survive. `visibility.headers` therefore gates
 * nothing here; `detailedHeaders` still gates the two that carry policy detail
 * (risk score and finding codes) into a place proxies log by default.
 *
 * Names come from `VERDICT_HEADERS` rather than being spelled out, so the
 * contract stays the single description of this wire surface.
 */
export function applyVerdictHeaders(
  reply: FastifyReply,
  verdict: HookVerdict,
  visibility: Required<VerdictVisibility>,
): void {
  reply.header(VERDICT_HEADERS.decision, verdict.decision);
  reply.header(
    VERDICT_HEADERS.key,
    verdict.guardrailKeys.length > 0 ? verdict.guardrailKeys.join(',') : verdict.guardrailKey,
  );
  reply.header(VERDICT_HEADERS.hook, verdict.hook);
  reply.header(VERDICT_HEADERS.mode, verdict.mode);
  reply.header(VERDICT_HEADERS.enforced, verdict.enforced ? 'true' : 'false');
  reply.header(VERDICT_HEADERS.trace, verdict.traceId);

  if (visibility.detailedHeaders) {
    reply.header(VERDICT_HEADERS.risk, String(verdict.riskScore));
    const codes = headerSafeCodes(verdict.codes);
    if (codes) {
      reply.header(VERDICT_HEADERS.codes, codes);
    }
  }

  if (visibility.aegisCompatHeaders) {
    // Deprecated aliases, removed in contract v3. Deployed SDK clients read
    // them today, and `x-aegis-post-decision` is specifically the one they read
    // after a tool has run.
    reply.header(VERDICT_HEADERS.legacyDecision, verdict.decision);
    reply.header(VERDICT_HEADERS.legacyTrace, verdict.traceId);
    if (verdict.hook === 'tool.post') {
      reply.header(VERDICT_HEADERS.legacyPost, verdict.decision);
    }
  }
}

/**
 * 246 / 446 are NON-STANDARD and therefore opt-in per guardrail: a block is
 * HTTP 400 (or a plain 200 on the evaluate endpoints) today and every deployed
 * client parses that. `verdict.decision` is already neutralised for a
 * monitor-mode guardrail, so a monitored block reports 246 "passed with
 * findings" — which is the truth: nothing was blocked.
 */
export function verdictStatusCode(
  verdict: HookVerdict,
  visibility: Required<VerdictVisibility>,
): number {
  if (!visibility.useVerdictStatusCodes) return 200;
  if (verdict.decision === 'block') return VERDICT_STATUS.blocked;
  return verdict.findings.length > 0 ? VERDICT_STATUS.passedWithFindings : 200;
}

/**
 * The wire shape of a hook verdict.
 *
 * snake_case and `guardrail_key` / `redacted_text` / `message` are deliberate:
 * they are the keys `/guardrails/evaluate` already returns, so a caller that
 * knows one guardrail endpoint can parse them all. Everything the hook plane
 * adds on top of that response is a new key, never a changed one.
 */
export function hookVerdictResponse(verdict: HookVerdict): Record<string, unknown> {
  const blocking = verdict.findings.filter((finding) => finding.block);
  return {
    hook: verdict.hook,
    contract_version: verdict.contractVersion,
    decision: verdict.decision,
    would_be_decision: verdict.wouldBeDecision,
    enforced: verdict.enforced,
    mode: verdict.mode,
    disabled: verdict.disabled,
    // The legacy meaning, kept: "was there a blocking finding", NOT "was the
    // request blocked". The two diverge in monitor mode and every existing
    // caller reads the first.
    passed: blocking.length === 0,
    findings: verdict.findings,
    mutations: verdict.mutations,
    // Present only when `applyMutations` actually rewrote something, which is
    // the only case where a caller must substitute it for what it sent.
    subject: verdict.subject ?? null,
    redacted_text: verdict.text ?? null,
    risk_score: verdict.riskScore,
    codes: verdict.codes,
    // The rendered end-user message plus its reason class, mode and status —
    // what a remote enforcement point needs to refuse the call in its own
    // client's dialect.
    blocked_message: verdict.message ?? null,
    message: blocking.length > 0 ? buildUserMessage(verdict.findings) : null,
    guardrail_key: verdict.guardrailKey,
    guardrail_keys: verdict.guardrailKeys,
    guardrail_name: verdict.guardrailName,
    policy_version: verdict.policyVersion,
    trace_id: verdict.traceId,
    latency_ms: verdict.latencyMs,
    degraded: verdict.degraded ?? [],
    // BESIDE `degraded`, AND FOR THE SAME REASON. A policy that could not run
    // and a policy we stopped waiting for are both policies whose absence from
    // `findings` needs explaining, and dropping either one at the process
    // boundary is what turns "two runs of the same input returned different
    // finding counts" into a mystery. Additive, like every other key this
    // plane added: a caller that ignores it is exactly where it was.
    cancelled: verdict.cancelled ?? [],
  };
}

/**
 * Run one hook for one guardrail and answer with the verdict.
 *
 * Shared by both API surfaces so the two cannot drift: a remote enforcement
 * point that works against the dashboard route must parse the token route
 * identically, and the whole point of this endpoint is that the SAME policy
 * decision is available from wherever the enforcement actually happens.
 */
export async function respondWithHookVerdict(params: {
  reply: FastifyReply;
  hook: HookId;
  subject: HookSubject;
  scope: HookScope;
  guardrailKeys: string[];
  visibility: Required<VerdictVisibility>;
  options: HookEvaluationOptions;
}): Promise<FastifyReply> {
  const verdict = await runHook({
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook: params.hook,
    subject: params.subject,
    scope: params.scope,
    guardrailKeys: params.guardrailKeys,
    only: params.options.only,
    shadow: params.options.shadow,
  });

  applyVerdictHeaders(params.reply, verdict, params.visibility);
  return params.reply
    .code(verdictStatusCode(verdict, params.visibility))
    .send(hookVerdictResponse(verdict));
}

/**
 * A hook id off the wire — a route param on the dashboard surface, a body field
 * on the token one.
 *
 * Hook ids contain dots (`output.stream.delta`), which are ordinary characters
 * inside one path segment; that was verified against the router rather than
 * assumed.
 */
export function parseHookId(value: unknown): { hook?: HookId; error?: string } {
  if (typeof value === 'string' && (HOOK_IDS as readonly string[]).includes(value)) {
    return { hook: value as HookId };
  }
  return { error: `hook must be one of ${HOOK_IDS.join(', ')}` };
}
