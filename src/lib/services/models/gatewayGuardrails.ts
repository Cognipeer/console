/**
 * Model-level guardrail enforcement of the gateway: the block error, the input /
 * output chain with its redaction and annotation folding, the semantic-cache
 * policy versions, and the actor a gateway-side hook call acts for.
 */

import { getCachedGuardrail } from '@/lib/services/guardrail/hooks/recordCache';
import { evaluateGuardrail } from '@/lib/services/guardrail';
import type { HookActor } from '@/lib/services/guardrail';
import type { UnifiedMessage } from '@cognipeer/agent-sdk';
import type { OpenAiStreamChunkLike } from '@/lib/services/guardrail/hooks/streamGate';
import { resolveUsageAttribution } from '@/lib/services/usage/usageEvents';
import type { GuardrailAnnotation } from './gatewayTypes';

// ── Guardrail block error ────────────────────────────────────────────────

/**
 * A finding as it may leave the process in an error body.
 *
 * `value` is the MATCHED STRING — the credential the secrets family found, the
 * card number the PII family found — and `span` is where it sits. The
 * evaluation logger masks `value` before storage for exactly that reason; the
 * HTTP error path did not, so a blocked completion handed the client the secret
 * it was blocked for. Both routes (`/chat/completions`, `/messages`) serialise
 * `error.findings` as-is, so the stripping happens HERE, where the error is
 * built, and covers every route at once. Everything that identifies the policy
 * decision (type, category, severity, message, code, action, block) is kept.
 */
export function clientSafeFindings(findings: readonly unknown[]): unknown[] {
  return findings.map((finding) => {
    if (!finding || typeof finding !== 'object') return finding;
    const { value: _value, span: _span, ...safe } = finding as Record<string, unknown>;
    void _value;
    void _span;
    return safe;
  });
}

export class GuardrailBlockError extends Error {
  readonly guardrailKey: string;
  readonly action: string;
  /** Client-safe: `value` and `span` are stripped at construction. */
  readonly findings: unknown[];

  constructor(
    message: string,
    guardrailKey: string,
    action: string,
    findings: unknown[] = [],
  ) {
    super(message);
    this.name = 'GuardrailBlockError';
    this.guardrailKey = guardrailKey;
    this.action = action;
    this.findings = clientSafeFindings(findings);
  }
}

/**
 * The bound output guardrails as `key@updatedAt` — the same `policyVersion`
 * spelling `HookVerdict` uses — for the semantic-cache variant key.
 *
 * Reads the RECORD CACHE (TTL'd, tenant-scoped), not the database: a request
 * that pays for an embedding and a vector search can afford a memoised record
 * read, but not a DB round trip per bound key. A record that cannot be read —
 * cache miss into a failing database, a key that no longer exists — falls back
 * to the bare key, so the lookup degrades to "keyed by binding" rather than
 * failing the request. An empty list is returned as `[]` on purpose: "no output
 * guardrail" is itself a policy that must not share entries with a guarded one.
 */
export async function outputGuardrailPolicyVersions(
  tenantDbName: string,
  projectId: string | undefined,
  guardrailKeys: readonly string[],
): Promise<string[]> {
  return Promise.all(
    guardrailKeys.map(async (key) => {
      try {
        const record = await getCachedGuardrail(tenantDbName, key, projectId ?? null);
        const updatedAt = record?.updatedAt;
        const stamp = updatedAt instanceof Date && !Number.isNaN(updatedAt.getTime())
          ? updatedAt.toISOString()
          : typeof updatedAt === 'string'
            ? updatedAt
            : undefined;
        return stamp ? `${key}@${stamp}` : key;
      } catch {
        return key;
      }
    }),
  );
}

// ── Model guardrail enforcement ───────────────────────────────────────────
// Every guardrail a model binds runs on every chat completion. WHICH ones a
// given hook gets is `resolveBindings`' answer, not this file's: a model may
// carry the ordered `guardrails` list, or only the two legacy slots
// (`inputGuardrailKey` / `outputGuardrailKey`), and the resolver projects the
// second shape onto the first. For a legacy row that projection yields exactly
// one key per hook, so everything below reduces to what it did before.
//
// `input.pre` checks the latest user message before the model is called,
// `output.pre` the assistant response (non-streaming; the streamed answer is
// gated by `createStreamGate` and audited post-hoc). Blocking guardrails throw
// GuardrailBlockError.

export function guardrailContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part && typeof part === 'object' && 'text' in part
            ? String((part as { text?: unknown }).text ?? '')
            : '',
      )
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

export function extractLatestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role === 'user') return guardrailContentToText(msg.content);
  }
  return '';
}

export function extractAssistantText(response: unknown): string {
  const choices = (response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  return guardrailContentToText(choices?.[0]?.message?.content);
}

interface GuardrailEnforcementOutcome {
  /** Text with redact-action findings masked; undefined when nothing was redacted. */
  redactedText?: string;
  /** Non-blocking findings (warn/flag/redact) to surface to the caller. */
  findings: Awaited<ReturnType<typeof evaluateGuardrail>>['findings'];
  guardrailKey: string;
}

async function enforceModelGuardrail(params: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  guardrailKey: string;
  text: string;
  phase: 'input' | 'output';
  requestId?: string;
  source?: string;
}): Promise<GuardrailEnforcementOutcome | null> {
  if (!params.text.trim()) return null;
  const result = await evaluateGuardrail({
    tenantDbName: params.tenantDbName,
    tenantId: params.tenantId,
    projectId: params.projectId,
    guardrailKey: params.guardrailKey,
    text: params.text,
    phase: params.phase,
    requestId: params.requestId,
    source: params.source ?? 'chat.completions',
  });
  // `blocked`, NOT `passed`: `passed` is the counterfactual ("would a blocking
  // finding have fired"), which stays true-to-form in monitor mode, while
  // `blocked` is the guardrail's Mode-neutralised decision. Reading `passed`
  // here is what made a Monitor guardrail keep refusing chat.completions.
  if (result.blocked) {
    // Prefer the finding's own message: a fail-closed guardrail whose judge model
    // could not run already explains that, and reducing it to the bare category
    // `evaluation_error` threw that explanation away — leaving a provider
    // misconfiguration looking like a content violation.
    const reasons = result.findings
      .filter((f) => f.block)
      .map((f) => f.message || f.category || f.type)
      .filter(Boolean)
      .join('; ');
    throw new GuardrailBlockError(
      `${params.phase === 'input' ? 'Input' : 'Output'} blocked by guardrail "${result.guardrailName}"${reasons ? `: ${reasons}` : ''}`,
      result.guardrailKey,
      result.action,
      result.findings,
    );
  }
  return {
    redactedText: result.redactedText,
    findings: result.findings,
    guardrailKey: result.guardrailKey,
  };
}

/** One guardrail's non-blocking findings, in the shape the response carries. */
interface GuardrailAnnotationResult {
  guardrail_key: string;
  findings: unknown[];
}

interface GuardrailChainOutcome {
  /**
   * Text after every redact-action rewrite in the chain; undefined when nothing
   * rewrote it. Distinguishing "unchanged" from "rewritten to the same string"
   * is what keeps the caller from cloning the request body for no reason.
   */
  redactedText?: string;
  /** Guardrails that produced findings, in binding order. */
  results: GuardrailAnnotationResult[];
}

/**
 * Runs every guardrail bound to one hook, in binding order, and folds them.
 *
 * Two properties are load-bearing:
 *
 *  1. THE FIRST BLOCKER WINS. `enforceModelGuardrail` throws, and the loop is
 *     sequential, so the GuardrailBlockError the caller sees — and therefore the
 *     message the end user reads — always comes from the earliest blocking
 *     guardrail in binding order. An operator who put the guardrail with the
 *     friendlier refusal first meant it, and a Promise.all here would make that
 *     message depend on which provider answered quickest.
 *
 *  2. REDACTIONS CHAIN. Guardrail N+1 evaluates the text as guardrail N left it,
 *     not the original. Feeding each the original and keeping the last
 *     `redactedText` would silently discard every earlier redaction — the
 *     composed result would mask strictly less than the guardrails did
 *     individually, which is the opposite of what composing them is for.
 *
 * A key that resolves to no record still throws (`evaluateGuardrail` does), as
 * it always has: a model pointing at a deleted guardrail is a misconfiguration,
 * and quietly running the rest of the chain would let it look enforced.
 */
export async function enforceModelGuardrailChain(params: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  guardrailKeys: string[];
  text: string;
  phase: 'input' | 'output';
  requestId?: string;
  source?: string;
}): Promise<GuardrailChainOutcome> {
  const results: GuardrailAnnotationResult[] = [];
  let text = params.text;
  let rewritten = false;

  for (const guardrailKey of params.guardrailKeys) {
    const outcome = await enforceModelGuardrail({
      tenantDbName: params.tenantDbName,
      tenantId: params.tenantId,
      projectId: params.projectId,
      guardrailKey,
      text,
      phase: params.phase,
      requestId: params.requestId,
      source: params.source,
    });
    // null = there was nothing to check (empty text). That can happen mid-chain
    // when an earlier redaction emptied the message, and skipping is right:
    // there is no subject left to adjudicate.
    if (!outcome) continue;
    if (outcome.redactedText !== undefined) {
      text = outcome.redactedText;
      rewritten = true;
    }
    if (outcome.findings.length > 0) {
      results.push({
        guardrail_key: outcome.guardrailKey,
        findings: outcome.findings,
      });
    }
  }

  return { redactedText: rewritten ? text : undefined, results };
}

/** Collapses a chain's per-guardrail findings into one annotation entry. */
export function foldGuardrailAnnotation(
  results: GuardrailAnnotationResult[],
): GuardrailAnnotation | undefined {
  if (results.length === 0) return undefined;
  // Byte-identical to the pre-multi-binding shape, deliberately: no `results`
  // key appears on a response that only ever had one guardrail on the hook.
  if (results.length === 1) return results[0];
  return {
    ...results[0],
    findings: results.flatMap((result) => result.findings),
    results,
  };
}

/** Rewrites the latest user message's textual content (used by the redact action). */
export function replaceLatestUserText(messages: unknown, newText: string): unknown {
  if (!Array.isArray(messages)) return messages;
  const cloned = [...messages];
  for (let i = cloned.length - 1; i >= 0; i--) {
    const msg = cloned[i] as { role?: string; content?: unknown };
    if (msg?.role === 'user') {
      cloned[i] = { ...msg, content: newText };
      break;
    }
  }
  return cloned;
}

/** Attaches non-blocking guardrail findings to an OpenAI-shaped response. */
export function annotateResponseWithGuardrails(
  response: unknown,
  annotations: Record<string, GuardrailAnnotation>,
): unknown {
  if (!response || typeof response !== 'object' || Object.keys(annotations).length === 0) {
    return response;
  }
  return { ...(response as Record<string, unknown>), guardrails: annotations };
}

// ── Streaming guardrail enforcement helpers ───────────────────────────────

/**
 * The actor a gateway-side hook call is made on behalf of.
 *
 * `HookActor.id` is required to come from the AUTHENTICATED context and never
 * from a caller-supplied field, so it is read from the same request-scoped
 * attribution `logModelUsage` already writes onto every usage row. When there is
 * no ambient request (a queued job, a unit test) it degrades to an anonymous
 * system actor, which is safe on THIS door specifically: the only check that
 * reads the actor is `tool_access`'s `allowedRoles`, and POLICY_VALID_HOOKS keeps
 * that family off `output.stream.delta`.
 */
export function gatewayActor(): HookActor {
  const attribution = resolveUsageAttribution();
  const kind: HookActor['kind'] =
    attribution.actorType === 'user'
      ? 'user'
      : attribution.actorType === 'api_token'
        ? 'api_token'
        : 'system';
  return {
    id: attribution.userId ?? attribution.apiTokenId ?? '',
    kind,
    roles: [],
  };
}

/**
 * True when a frame the gate released actually put characters on the wire.
 *
 * This is what decides whether a later block has to tell the client to discard
 * what it already rendered: a block that lands before the first character is a
 * clean refusal, one that lands after it leaves half an answer on screen.
 */
export function streamFrameHasContent(frame: OpenAiStreamChunkLike): boolean {
  return (frame.choices ?? []).some((choice) => {
    const content = choice.delta?.content;
    return typeof content === 'string' && content.length > 0;
  });
}

// ── Native-message variants ───────────────────────────────────────────────

/** The text of the latest user message of unified messages (text parts only). */
export function latestUserTextNative(messages: readonly UnifiedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    return message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** Rewrites the latest user message's content (the redact action). */
export function replaceLatestUserTextNative(messages: readonly UnifiedMessage[], newText: string): UnifiedMessage[] {
  const cloned = [...messages];
  for (let i = cloned.length - 1; i >= 0; i -= 1) {
    if (cloned[i]?.role === 'user') {
      cloned[i] = { ...cloned[i], content: newText };
      break;
    }
  }
  return cloned;
}
