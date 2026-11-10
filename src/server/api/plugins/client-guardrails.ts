import { enforceServiceQuota, isQuotaExceededError, quotaExceededBody } from '@/lib/quota/serviceQuota';
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { GuardrailType, IUser } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  deleteGuardrail,
  evaluateGuardrail,
  getGuardrailByKey,
  listGuardrails,
} from '@/lib/services/guardrail';
import type { GuardrailView } from '@/lib/services/guardrail';
import { ensureHooks } from '@/lib/services/guardrail/hooks/legacy';
import {
  POLICY_VALID_HOOKS,
  HOOK_IDS,
  STREAM_ELIGIBLE_FAMILIES,
  toGuardrailMode,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  PolicyFamily,
  GuardrailPolicy,
  GuardrailHooksConfig,
  GuardrailMode,
  HookActor,
  HookId,
  SafetyAction,
} from '@/lib/services/guardrail/hooks/contract';
// The dashboard plugin owns the shared half of this surface. These two files
// are the TWO DOORS onto one hook plane, and a remote enforcement point is
// expected to work against either: if the request shapes, the verdict keys or
// the response headers drifted apart, a point written against one would
// silently mis-parse the other. Everything load-bearing on the wire is shared by
// import.
import {
  applyVerdictHeaders,
  buildHookSubject,
  guardrailByKeyInScope,
  parseHookId,
  readHookEvaluationOptions,
  resolveVerdictVisibility,
  respondWithHookVerdict,
  toGuardrailRecord,
} from './guardrails';
import {
  VALID_TYPES,
  buildUserMessage,
  createGuardrailFromRequest,
  guardrailWriteErrorBody,
  parseGuardrailCreateBody,
  parseGuardrailPatchBody,
  updateGuardrailFromRequest,
} from './guardrail-write';
import {
  getApiTokenContextForRequest,
  parseBooleanQuery,
  readJsonBody,
  safeReadJsonBody,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-guardrails');

type GuardrailsListQuery = {
  enabled?: string;
  search?: string;
  type?: string;
};

/** What a listed guardrail says about its hook plane. */
interface GuardrailHooksSummary {
  contractVersion: number;
  /** false = this config was DERIVED from the legacy columns on read, and will
   *  be re-derived on the next one. */
  authored: boolean;
  /** The hooks `/guardrails/hooks/evaluate` will actually evaluate against this
   *  guardrail. A hook outside this list answers with a vacuous allow. */
  servable: HookId[];
  bindings: Partial<Record<HookId, {
    enabled: boolean;
    timing: 'sync' | 'async';
    onFail: 'block' | 'log';
    failMode?: 'open' | 'closed';
    timeoutMs?: number;
  }>>;
  /**
   * WHAT runs, never HOW it is configured. A whitelist rather than a redaction
   * pass: a webhook policy's `headers` carry the operator's bearer token and its
   * `credentialProviderKey` / `signingSecretRef` name the credentials behind it,
   * and a list response is the one most likely to be logged whole by whatever
   * sits between here and the caller. Anything added to a policy config later is
   * therefore private by default, which is the correct direction for the
   * mistake to run in.
   */
  policies: Array<{
    id: string;
    family: PolicyFamily;
    enabled: boolean;
    label?: string;
    hooks: HookId[];
    action?: SafetyAction;
  }>;
  stream: { enabled: boolean; holdBackChars?: number } | null;
}

/** A guardrail as this surface lists it: the serialised record the create and
 *  update routes return, minus the authored `hooks` blob, plus what a caller
 *  needs in order to know what it can ask of it. */
type ClientGuardrailListItem = Omit<GuardrailView, 'hooks'> & {
  effectiveMode: GuardrailMode;
  hooksSummary: GuardrailHooksSummary;
};

/**
 * Whether a policy contributes to a hook — the engine's `isDispatchable` minus
 * its `only` filter, which is a per-CALL narrowing and not a property of the
 * guardrail.
 */
function dispatchesOn(policy: GuardrailPolicy, hook: HookId): boolean {
  if (!policy.enabled) return false;
  if (!policy.hooks?.includes(hook)) return false;
  if (hook === 'output.stream.delta' && !STREAM_ELIGIBLE_FAMILIES.has(policy.family)) return false;
  // THE SAME TABLE the engine dispatches from and the save-time validator
  // enforces — there is exactly one now. A local widened copy used to live
  // here; it silently became a NARROWING when `prompt.pre` was added to the
  // contract table and not to the copy, which would have made this route
  // report a hook as unservable that the engine does in fact serve. `servable`
  // is read by a remote enforcement point to decide what to send, so a wrong
  // answer here is a guardrail that never gets called.
  const valid = POLICY_VALID_HOOKS[policy.family] as readonly HookId[] | undefined;
  // A family this build has never heard of is dispatched anyway (the engine
  // turns it into a degraded entry, which `failMode` then acts on), so it is
  // reported: the hook does run.
  return valid ? valid.includes(hook) : true;
}

/** A hook runs iff its binding is enabled AND an enabled policy names it —
 *  hooks/engine.ts states the rule, hooks/legacy.ts's downward projection and
 *  the save-time validator both depend on it. */
function servesHook(hooks: GuardrailHooksConfig, hook: HookId): boolean {
  if (hooks.bindings?.[hook]?.enabled !== true) return false;
  return (hooks.policies ?? []).some((policy) => dispatchesOn(policy, hook));
}

function summarizeHooks(view: GuardrailView): GuardrailHooksSummary {
  // A LEGACY row summarises too: `ensureHooks` lifts it exactly as the engine
  // does, so what a caller reads is what would actually be enforced rather than
  // "no hooks". Nothing is written — a GET must not provision the lifted PII
  // policy, which the engine does for itself on the evaluate path.
  const resolved = ensureHooks(toGuardrailRecord(view));
  const hooks = resolved.hooks;

  const bindings: GuardrailHooksSummary['bindings'] = {};
  for (const hook of HOOK_IDS) {
    const binding = hooks.bindings?.[hook];
    if (!binding) continue;
    bindings[hook] = {
      enabled: binding.enabled === true,
      timing: binding.schedule?.timing ?? 'sync',
      onFail: binding.schedule?.onFail ?? 'block',
      failMode: binding.failMode,
      timeoutMs: binding.timeoutMs,
    };
  }

  return {
    contractVersion: hooks.contractVersion,
    authored: resolved.hooksVersion >= 1,
    servable: HOOK_IDS.filter((hook) => servesHook(hooks, hook)),
    bindings,
    policies: (hooks.policies ?? []).map((policy) => ({
      id: policy.id,
      family: policy.family,
      enabled: policy.enabled === true,
      label: policy.label,
      hooks: policy.hooks ?? [],
      action: policy.action,
    })),
    stream: hooks.stream
      ? { enabled: hooks.stream.enabled === true, holdBackChars: hooks.stream.holdBackChars }
      : null,
  };
}

function toClientGuardrailListItem(view: GuardrailView): ClientGuardrailListItem {
  const item: ClientGuardrailListItem & { hooks?: GuardrailHooksConfig } = {
    ...view,
    // `mode` with `enabled` folded in, by the same rule the engine applies. A
    // legacy row has no mode column at all, so a caller reading `mode: null`
    // cannot tell "unset, therefore enforcing" from "not enforcing".
    effectiveMode: toGuardrailMode(view.mode, view.enabled),
    hooksSummary: summarizeHooks(view),
  };
  // Spread-then-remove rather than a field list: everything else is the
  // create/update serialisation VERBATIM — a caller can hand an item straight
  // back to PATCH, where an absent `hooks` leaves the stored config untouched —
  // and a field added to the record later reaches this route without an edit.
  // That inclusive default is safe for the RECORD, whose every column those two
  // routes already return; `hooks` is the exception, and the only place a
  // credential is stored (see GuardrailHooksSummary.policies).
  delete item.hooks;
  return item;
}

/**
 * Whether a guardrail is addressable by this token.
 *
 * The same reach `guardrailByKeyInScope` grants an API token (it is called
 * without a user here, so its owner/admin branch never applies): the token's own
 * project, plus workspace-level rows that belong to no project. Listing a
 * different set than the evaluate routes accept would be a list a caller cannot
 * act on, or — the direction that matters — one project reading another's
 * policy names.
 */
function reachableFromToken(guardrail: GuardrailView, projectId: string): boolean {
  if (!guardrail.projectId) return true;
  return String(guardrail.projectId) === String(projectId);
}

/**
 * An API token's actor identity.
 *
 * Derived from the AUTHENTICATED token and never from the request body, per the
 * contract's rule on `HookActor.id`: an actor id a caller can choose is an
 * actor id a caller can borrow, and `tool_access.allowedRoles` is keyed on it.
 * A remote enforcement point therefore cannot present its own end user's role
 * here — the roles it is judged under are the token owner's.
 */
function apiTokenActor(ctx: { tokenRecord: { userId: string }; user: IUser | null }): HookActor {
  return {
    id: ctx.tokenRecord.userId,
    kind: 'api_token',
    roles: ctx.user?.role ? [ctx.user.role] : [],
  };
}

/**
 * The guardrail keys a hook evaluation runs against.
 *
 * Plural, unlike the dashboard route's `:key`: a remote point evaluates a HOOK,
 * and one hook can be governed by several guardrails whose verdicts merge.
 * `guardrail_key` stays accepted as the singular spelling every other route on
 * this surface already uses.
 */
function readGuardrailKeysField(
  body: Record<string, unknown>,
): { keys?: string[]; error?: string } {
  const raw = body.guardrail_keys ?? body.guardrail_key;
  const list = Array.isArray(raw) ? raw : [raw];
  const keys: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return { error: 'guardrail_key (or guardrail_keys) is required' };
    }
    // Duplicates would double every finding and double-bill the evaluation;
    // runHook de-duplicates too, but a 404 loop over the same key twice is
    // simply wasted work.
    if (!keys.includes(entry)) keys.push(entry);
  }
  if (keys.length === 0) {
    return { error: 'guardrail_key (or guardrail_keys) is required' };
  }
  return { keys };
}

/** A retired-surface answer. `replacement` is a path on this same API, or
 *  null when nothing token-facing replaces the call. */
interface AegisGoneAnswer {
  replacement: string | null;
  message: string;
}

/**
 * 410 Gone, in the shape a deployed `@cognipeer/console-sdk` ≤ 1.7.x surfaces
 * as `CognipeerAPIError(410)`. `Deprecation: true` is the draft-era boolean
 * form, which is what deployed tooling recognises; `Link rel=successor-version`
 * names the replacement when there is one. No `Sunset`: the sunset has already
 * happened — that is what the status says.
 */
function sendAegisGone(reply: FastifyReply, answer: AegisGoneAnswer) {
  reply.header('Deprecation', 'true');
  if (answer.replacement) {
    reply.header('Link', `<${answer.replacement}>; rel="successor-version"`);
  }
  return reply.code(410).send({
    error: {
      type: 'gone',
      code: 'aegis_removed',
      message: answer.message,
      replacement: answer.replacement,
    },
  });
}

export const clientGuardrailsApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/client/v1/guardrails/evaluate', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.guardrail_key !== 'string') {
        return reply.code(400).send({ error: 'guardrail_key is required' });
      }

      if (typeof body.text !== 'string') {
        return reply.code(400).send({ error: 'text is required' });
      }

      await enforceServiceQuota(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        { domain: 'guardrail', resourceKey: body.guardrail_key, cost: { requests: 1 } },
      );

      const result = await evaluateGuardrail({
        guardrailKey: body.guardrail_key,
        projectId: ctx.projectId,
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        text: body.text,
        source: 'client-api',
      });

      // Headers only. This endpoint has always answered 200, findings or not,
      // and that status is part of its published shape; the opt-in 246/446
      // codes live on the hook route below, where nothing depends on the old
      // one.
      if (result.verdict) {
        applyVerdictHeaders(reply, result.verdict, resolveVerdictVisibility(undefined));
      }

      return reply.code(200).send({
        action: result.action,
        findings: result.findings,
        guardrail_key: result.guardrailKey,
        guardrail_name: result.guardrailName,
        message: result.passed ? null : buildUserMessage(result.findings),
        passed: result.passed,
        disabled: result.disabled ?? false,
        redacted_text: result.redactedText ?? null,
        // ADDITIVE: spans, mutations, risk score, response codes and
        // `wouldBeDecision`. Every key above keeps its exact meaning.
        verdict: result.verdict ?? null,
      });
    } catch (error) {
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
      logger.error('Evaluate client guardrail error', { error });
      const message = error instanceof Error ? error.message : 'Internal error';
      return reply.code(message.toLowerCase().includes('not found') ? 404 : 500).send({
        error: message,
      });
    }
  }));

  /**
   * Evaluate ONE hook, for a remotely-connected enforcement point.
   *
   * THE TENANT COMES FROM THE API TOKEN AND NOWHERE ELSE. There is no
   * `tenant_id` / `tenant_db` field on this body and there must never be one:
   * `HookScope.tenantDbName` selects the database every policy reads its
   * policies, word lists and PII catalog out of, so a caller-supplied value
   * would be a cross-tenant read carrying a valid signature. The same rule
   * covers the actor — see `apiTokenActor`.
   */
  app.post('/client/v1/guardrails/hooks/evaluate', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = safeReadJsonBody<Record<string, unknown>>(request);

      const hookField = parseHookId(body.hook);
      if (!hookField.hook) {
        return reply.code(400).send({ error: hookField.error });
      }

      const keysField = readGuardrailKeysField(body);
      if (!keysField.keys) {
        return reply.code(400).send({ error: keysField.error });
      }

      // Resolved BEFORE the hook runs, for two reasons: an unknown key has to
      // be a 404 (`runHook` deliberately never throws and returns a VACUOUS
      // allow for one, which a remote enforcement point would read as "the
      // content is safe"), and the guardrails' own `visibility` decides what
      // this response is allowed to say.
      const records: GuardrailView[] = [];
      for (const key of keysField.keys) {
        const record = await guardrailByKeyInScope(ctx.tenantDbName, key, ctx.projectId);
        if (!record) {
          return reply.code(404).send({ error: `Guardrail with key "${key}" not found` });
        }
        records.push(record);
      }

      const subjectField = buildHookSubject(hookField.hook, body);
      if (!subjectField.subject) {
        return reply.code(400).send({ error: subjectField.error });
      }

      const optionsField = readHookEvaluationOptions(body);
      if (!optionsField.options) {
        return reply.code(400).send({ error: optionsField.error });
      }

      // One request per evaluate call, counted against each guardrail named.
      for (const record of records) {
        await enforceServiceQuota(
          { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
          { domain: 'guardrail', resourceKey: record.key, cost: { requests: 1 } },
        );
      }

      // Several guardrails merge into one verdict, so their visibility settings
      // have to merge too, and every field merges by OR. Opting ANY guardrail
      // into the verdict status codes opts the response in: the alternative is
      // a caller that enabled them on the guardrail it cares about and still
      // gets a 200 because another key in the same call had not.
      const visibility = records
        .map((record) => resolveVerdictVisibility(ensureHooks(toGuardrailRecord(record)).hooks))
        .reduce((merged, next) => ({
          headers: merged.headers || next.headers,
          useVerdictStatusCodes: merged.useVerdictStatusCodes || next.useVerdictStatusCodes,
          detailedHeaders: merged.detailedHeaders || next.detailedHeaders,
          aegisCompatHeaders: merged.aegisCompatHeaders || next.aegisCompatHeaders,
        }));

      return await respondWithHookVerdict({
        reply,
        hook: hookField.hook,
        subject: subjectField.subject,
        scope: {
          tenantId: ctx.tenantId,
          tenantDbName: ctx.tenantDbName,
          projectId: ctx.projectId,
          actor: apiTokenActor(ctx),
          surface: 'api',
          source: 'client-api-hook',
          requestId: optionsField.options.requestId,
          // Reusing the caller's request id keeps the block message's
          // {{traceId}} aligned with its own correlation id.
          traceId: optionsField.options.requestId ?? randomUUID(),
          budgetMs: optionsField.options.budgetMs,
        },
        guardrailKeys: records.map((record) => record.key),
        visibility,
        options: optionsField.options,
      });
    } catch (error) {
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
      logger.error('Evaluate client guardrail hook error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  /**
   * List the guardrail definitions this token can address.
   *
   * THE TENANT AND THE PROJECT COME FROM THE API TOKEN, exactly as they do on
   * the evaluate routes above: there is no `project_id` / `tenant_id` query
   * parameter and there must never be one, or a caller could enumerate another
   * tenant's policy names with a valid signature of their own.
   *
   * RBAC: `/api/client/v1/guardrails` maps to the `guardrails` service
   * (lib/security/rbac.ts, ROUTE_PREFIXES) and `getRequiredPermissionLevel`
   * answers `read` for a GET, so `withClientApiRequestContext` — which enforces
   * API-token RBAC by default — already gates this at guardrails:read, capped
   * by the token's own least-privilege scope. The prefix match covers this path
   * exactly, so a read here is covered; nothing route-local is needed and
   * nothing here may widen it.
   */
  app.get('/client/v1/guardrails', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as GuardrailsListQuery;

      // Rejected rather than passed through: an unrecognised `type` would filter
      // the list down to nothing and read as "this project has no guardrails",
      // which is the one answer a caller must not get wrong.
      if (query.type !== undefined && !VALID_TYPES.includes(query.type as GuardrailType)) {
        return reply.code(400).send({ error: 'type must be "preset" or "custom"' });
      }
      const search =
        typeof query.search === 'string' && query.search.trim() !== ''
          ? query.search.trim()
          : undefined;

      // Listed TENANT-WIDE and narrowed here, rather than filtered by the store,
      // because `listGuardrails({ projectId })` emits `projectId = @projectId` —
      // a predicate that EXCLUDES NULL. A workspace-level guardrail is reachable
      // by key from `/guardrails/hooks/evaluate` (guardrailByKeyInScope falls
      // back to exactly those rows), so a store-side project filter would list a
      // set that disagrees with the set this surface evaluates. The store still
      // applies `enabled` / `type` / `search`, and the guardrail table is a
      // tenant's policy list rather than a traffic table.
      const all = await listGuardrails(ctx.tenantDbName, {
        enabled: parseBooleanQuery(query.enabled),
        search,
        type: query.type as GuardrailType | undefined,
      });

      const guardrails = all
        .filter((guardrail) => reachableFromToken(guardrail, ctx.projectId))
        .map(toClientGuardrailListItem);

      return reply.code(200).send({ guardrails });
    } catch (error) {
      logger.error('List client guardrails error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Create a guardrail definition ──
  app.post('/client/v1/guardrails', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      const parsed = parseGuardrailCreateBody(body);
      if (!parsed.ok) {
        return reply.code(parsed.status).send(guardrailWriteErrorBody(parsed));
      }

      const guardrail = await createGuardrailFromRequest(
        {
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          actorId: ctx.tokenRecord.userId,
        },
        parsed.value,
      );

      return reply.code(201).send({ guardrail });
    } catch (error) {
      logger.error('Create client guardrail error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Update a guardrail definition (resolve by key, scoped to project) ──
  app.patch('/client/v1/guardrails/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      const parsed = parseGuardrailPatchBody(body);
      if (!parsed.ok) {
        return reply.code(parsed.status).send(guardrailWriteErrorBody(parsed));
      }

      const existing = await getGuardrailByKey(ctx.tenantDbName, key, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      const updated = await updateGuardrailFromRequest(
        {
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          actorId: ctx.tokenRecord.userId,
        },
        existing,
        parsed.value,
      );
      if (!updated.ok) {
        return reply.code(updated.status).send(guardrailWriteErrorBody(updated));
      }
      const guardrail = updated.guardrail;

      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }
      return reply.code(200).send({ guardrail });
    } catch (error) {
      logger.error('Update client guardrail error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Delete a guardrail definition (resolve by key, scoped to project) ──
  app.delete('/client/v1/guardrails/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };

      const existing = await getGuardrailByKey(ctx.tenantDbName, key, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      const deleted = await deleteGuardrail(ctx.tenantDbName, existing.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client guardrail error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Retired Aegis client surface: 410 Gone for one release ────────────────
  // `@cognipeer/console-sdk` ≤ 1.7.x still calls these three paths. Without a
  // route here Fastify answers a bare 404 — which an SDK consumer's catch block
  // cannot tell from a typo, so a tool gate that treats transport errors as an
  // outage fails OPEN on the very call meant to gate it. A 410 that names the
  // replacement is unambiguous: the surface is gone on purpose, and this is
  // where it went. Removed with contract v3.
  //
  // Same wrapper as every other route in this file: an unauthenticated caller
  // still gets 401, and RBAC still applies (`/api/client/v1/aegis` maps to the
  // `guardrails` service in lib/security/rbac.ts) — a retired path must not
  // become an unauthenticated probe.
  app.post('/client/v1/aegis/evaluate', withClientApiRequestContext(async (_request, reply) =>
    sendAegisGone(reply, {
      replacement: '/api/client/v1/guardrails/hooks/evaluate',
      message: 'The Aegis enforcement plane was removed. Evaluate a tool call with '
        + 'POST /api/client/v1/guardrails/hooks/evaluate (hook "tool.pre" or "tool.post"); '
        + 'the verdict carries decision, riskScore, codes and traceId. '
        + 'Upgrade to @cognipeer/console-sdk 2.x (client.guardrails.hooks.evaluate).',
    })));

  app.get('/client/v1/aegis/shields', withClientApiRequestContext(async (_request, reply) =>
    sendAegisGone(reply, {
      replacement: '/api/client/v1/guardrails',
      message: 'Aegis shields were folded into guardrails. List them with '
        + 'GET /api/client/v1/guardrails; hooksSummary.servable says which hooks each one '
        + 'evaluates. Upgrade to @cognipeer/console-sdk 2.x (client.guardrails.list).',
    })));

  app.get('/client/v1/aegis/shields/:id/audit', withClientApiRequestContext(async (_request, reply) =>
    sendAegisGone(reply, {
      replacement: null,
      message: 'The Aegis audit log was removed with the shields it indexed. Guardrail '
        + 'decisions are recorded as evaluation logs (hook, decision, riskScore, traceId) and '
        + 'read in the dashboard under Guardrails > Evaluations '
        + '(GET /api/guardrails/:id/evaluations, cookie session); there is no API-token read '
        + 'of that log yet. Correlate a call through the traceId of its verdict.',
    })));
};
