import { createHash, randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type {
  GuardrailType,
  IUser,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import {
  deleteGuardrail,
  evaluateGuardrail,
  getGuardrail,
  listGuardrails,
  MODERATION_CATEGORIES,
  PII_CATEGORIES,
  PROMPT_SHIELD_ISSUES,
  WORD_FILTER_BUILTIN_LISTS,
  createWordList,
  updateWordList,
  deleteWordList,
  getWordList,
  listWordLists,
  parseWordListContent,
  normalizeWordArray,
  WordListValidationError,
} from '@/lib/services/guardrail';
import type { GuardrailView, WordListView } from '@/lib/services/guardrail';
// The service barrel deliberately re-exports only the hook plane's ENTRY
// POINTS (`runHook` and friends); the contract's constants and the red-team
// battery are reached at their own paths. See the
// "Deliberately NOT re-exported" note in services/guardrail/index.ts — this
// plugin is a configuration surface, not a second evaluation path, so it is on
// the allowed side of that line.
import {
  GUARDRAIL_CONTRACT_VERSION,
  readHooks,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  HookActor,
  HookScope,
  HookSurface,
} from '@/lib/services/guardrail/hooks/contract';
import { runGuardrailRedTeam } from '@/lib/services/guardrail/hooks/redteam';
import { capabilities as sdkGuardrailCapabilities } from '@/lib/services/guardrail/sdkAdapter';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';
import {
  parseBooleanQuery,
  readJsonBody,
  requireProjectContextForRequest,
  safeReadJsonBody,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import {
  buildUserMessage,
  createGuardrailFromRequest,
  guardrailWriteErrorBody,
  parseGuardrailCreateBody,
  parseGuardrailPatchBody,
  updateGuardrailFromRequest,
} from './guardrail-write';
import { guardrailByKeyInScope } from '../guardrails/scope';
import {
  applyVerdictHeaders,
  buildHookSubject,
  canRequestShadowEvaluation,
  parseHookId,
  readHookEvaluationOptions,
  resolveVerdictVisibility,
  respondWithHookVerdict,
} from '../guardrails/hookVerdict';
import type { HookEvaluationOptions } from '../guardrails/hookVerdict';

// The write-path helpers live in `guardrail-write.ts`; these names stay
// importable from here for the other plugins and the tests that use them.
export {
  findLlmModelConfigError,
  readHooksField,
  readModeField,
} from './guardrail-write';

// The shared, non-route halves of this surface live in `../guardrails/`
// (key-scoped lookup, hook-verdict wire shape); these names stay importable
// from here for the EE overlay and the tests that use them.
export { guardrailByKeyInScope } from '../guardrails/scope';
export {
  applyVerdictHeaders,
  buildHookSubject,
  canRequestShadowEvaluation,
  headerSafeCodes,
  hookVerdictResponse,
  parseHookId,
  readHookEvaluationOptions,
  resolveVerdictVisibility,
  respondWithHookVerdict,
  verdictStatusCode,
} from '../guardrails/hookVerdict';
export type { HookEvaluationAccess } from '../guardrails/hookVerdict';

const logger = createLogger('api:guardrails');

type GuardrailsQuery = {
  enabled?: string;
  includeTemplates?: string;
  search?: string;
  type?: GuardrailType;
};

type EvaluationsQuery = {
  from?: string;
  groupBy?: 'hour' | 'day' | 'month';
  limit?: string;
  passed?: string;
  skip?: string;
  to?: string;
};

/** The only `?target=` the compiled-policy endpoint knows how to emit. */
const COMPILE_TARGETS = ['agent-sdk'] as const;
type CompileTarget = (typeof COMPILE_TARGETS)[number];

/**
 * Resolve a guardrail by id within the caller's project scope.
 *
 * getGuardrail is scoped only by the tenant database, so without this any
 * member of one project could read another project's guardrail, disable it
 * (enabled:false / failMode:'open') or delete it — silently removing another
 * team's safety control — and read the flagged text in its evaluation logs.
 * Returns null for an out-of-scope id so it is indistinguishable from a
 * missing one. Owners and admins too: the active project decides, and they
 * reach another one by switching to it. Legacy rows stored before guardrails
 * carried a projectId stay reachable.
 */
async function guardrailInProjectScope(
  tenantDbName: string,
  id: string,
  projectId: string,
): Promise<GuardrailView | null> {
  const guardrail = await getGuardrail(tenantDbName, id);
  if (!guardrail) return null;
  if (!guardrail.projectId) return guardrail;
  return String(guardrail.projectId) === String(projectId) ? guardrail : null;
}

/** Same project scoping as guardrailInProjectScope, for word lists. */
async function wordListInProjectScope(
  tenantDbName: string,
  id: string,
  projectId: string,
): Promise<WordListView | null> {
  const wordList = await getWordList(tenantDbName, id);
  if (!wordList) return null;
  if (!wordList.projectId) return wordList;
  return String(wordList.projectId) === String(projectId) ? wordList : null;
}

/** `${key}@${updatedAt}`, the engine's own policy version string
 *  (hooks/engine.ts:1133) computed over a view's widened timestamps. */
function policyVersionOfView(view: GuardrailView): string {
  const stamped = view.updatedAt ?? view.createdAt;
  const iso =
    stamped instanceof Date
      ? stamped.toISOString()
      : typeof stamped === 'string'
        ? stamped
        : undefined;
  return iso ? `${view.key}@${iso}` : view.key;
}

/**
 * An actor id MUST come from the authenticated context and never from the
 * request body: an actor id a caller can choose is an actor id a caller can
 * borrow, and `tool_access.allowedRoles` is keyed on it. There is deliberately
 * no wire field for either the id or the roles.
 */
function dashboardActor(session: { userId: string }, user: Pick<IUser, 'role'>): HookActor {
  return { id: session.userId, kind: 'user', roles: [user.role] };
}

function hookScope(input: {
  tenantId: string;
  tenantDbName: string;
  projectId?: string;
  actor: HookActor;
  surface: HookSurface;
  source: string;
  options: HookEvaluationOptions;
}): HookScope {
  return {
    tenantId: input.tenantId,
    tenantDbName: input.tenantDbName,
    projectId: input.projectId,
    actor: input.actor,
    surface: input.surface,
    source: input.source,
    requestId: input.options.requestId,
    // Reusing requestId when we have one keeps the block message's {{traceId}}
    // and the caller's own correlation id aligned, exactly as the legacy
    // facade does.
    traceId: input.options.requestId ?? randomUUID(),
    budgetMs: input.options.budgetMs,
  };
}

export const guardrailsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/guardrails', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as GuardrailsQuery;

      const guardrails = await listGuardrails(session.tenantDbName, {
        enabled: parseBooleanQuery(query.enabled),
        projectId,
        search: query.search,
        type: query.type,
      });

      const payload: Record<string, unknown> = { guardrails };

      if (query.includeTemplates === 'true') {
        payload.templates = {
          moderationCategories: MODERATION_CATEGORIES,
          piiCategories: PII_CATEGORIES,
          promptShieldIssues: PROMPT_SHIELD_ISSUES,
          wordFilterLists: WORD_FILTER_BUILTIN_LISTS,
        };
      }

      return reply.code(200).send(payload);
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/guardrails', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      const parsed = parseGuardrailCreateBody(body);
      if (!parsed.ok) {
        return reply.code(parsed.status).send(guardrailWriteErrorBody(parsed));
      }

      const guardrail = await createGuardrailFromRequest(
        {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId,
          actorId: session.userId,
        },
        parsed.value,
      );

      return reply.code(201).send({ guardrail });
    } catch (error) {
      logger.error('Create guardrail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/guardrails/evaluate', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.guardrail_key !== 'string') {
        return reply.code(400).send({ error: 'guardrail_key is required' });
      }

      if (typeof body.text !== 'string') {
        return reply.code(400).send({ error: 'text is required' });
      }

      const result = await evaluateGuardrail({
        guardrailKey: body.guardrail_key,
        projectId,
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        text: body.text,
        source: 'dashboard-evaluate',
      });

      // Headers only. This endpoint's STATUS is part of its published shape —
      // it has always answered 200, findings or not — so the opt-in 246/446
      // codes are confined to the hook routes below, where nothing is
      // depending on the old one.
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
      logger.error('Evaluate guardrail error', { error });
      if (error instanceof Error && error.message.toLowerCase().includes('not found')) {
        return reply.code(404).send({ error: error.message });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  // ── Word lists (tenant-managed banned-word lists) ──
  // Registered as static /guardrails/word-lists* paths; Fastify prefers
  // static segments over :id params, so these never shadow guardrail ids.

  app.get('/guardrails/word-lists', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string };
      const lists = await listWordLists(session.tenantDbName, {
        projectId,
        search: query.search,
      });
      return reply.code(200).send({ wordLists: lists });
    } catch (error) {
      logger.error('List word lists error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/guardrails/word-lists', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }

      // Accept either a parsed `words` array or raw CSV/TXT `content`.
      let words: string[];
      if (typeof body.content === 'string') {
        words = parseWordListContent(body.content);
      } else if (body.words !== undefined) {
        words = normalizeWordArray(body.words);
      } else {
        return reply.code(400).send({ error: 'Provide `words` (string array) or `content` (raw CSV/TXT)' });
      }

      if (words.length === 0) {
        return reply.code(400).send({ error: 'The list contains no usable entries' });
      }

      const wordList = await createWordList(
        session.tenantDbName,
        session.tenantId,
        session.userId,
        {
          name: body.name.trim(),
          description: typeof body.description === 'string' ? body.description.trim() : undefined,
          language: typeof body.language === 'string' ? body.language.trim() : undefined,
          words,
          projectId,
        },
      );

      return reply.code(201).send({ wordList });
    } catch (error) {
      if (error instanceof WordListValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Create word list error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/guardrails/word-lists/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const wordList = await wordListInProjectScope(session.tenantDbName, id, projectId);
      if (!wordList) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      return reply.code(200).send({ wordList });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.patch('/guardrails/word-lists/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!(await wordListInProjectScope(session.tenantDbName, id, projectId))) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      const body = readJsonBody<Record<string, unknown>>(request);

      let words: string[] | undefined;
      if (typeof body.content === 'string') {
        words = parseWordListContent(body.content);
      } else if (body.words !== undefined) {
        words = normalizeWordArray(body.words);
      }
      if (words !== undefined && words.length === 0) {
        return reply.code(400).send({ error: 'The list contains no usable entries' });
      }

      const wordList = await updateWordList(session.tenantDbName, id, session.userId, {
        name: typeof body.name === 'string' ? body.name.trim() : undefined,
        description: typeof body.description === 'string' ? body.description.trim() : undefined,
        language: typeof body.language === 'string' ? body.language.trim() : undefined,
        words,
      });

      if (!wordList) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      return reply.code(200).send({ wordList });
    } catch (error) {
      if (error instanceof WordListValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Update word list error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.delete('/guardrails/word-lists/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!(await wordListInProjectScope(session.tenantDbName, id, projectId))) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      const deleted = await deleteWordList(session.tenantDbName, id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete word list error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  // ── Hook plane ────────────────────────────────────────────────────────────
  //
  // `:key` beside `:id` on sibling routes is fine — Fastify keeps param names
  // on the route, not on the radix node, and hook ids containing dots stay one
  // path segment. Both were verified against the router before these were
  // written.

  /**
   * Evaluate ONE hook of ONE guardrail, directly.
   *
   * This is the remote half of the enforcement plane: a point that runs a model
   * or a tool somewhere else asks the console what the policy says, instead of
   * shipping the policy to it. That is also why the answer carries
   * `policy_version` — paired with the compiled endpoint's ETag it is how a
   * remote point knows its cached policy is still the current one.
   */
  app.post('/guardrails/:key/hooks/:hook', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { key, hook: hookParam } = request.params as { key: string; hook: string };

      const hookField = parseHookId(hookParam);
      if (!hookField.hook) {
        return reply.code(400).send({ error: hookField.error });
      }

      const guardrail = await guardrailByKeyInScope(session.tenantDbName, key, projectId, user);
      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      const body = safeReadJsonBody<Record<string, unknown>>(request);

      const subjectField = buildHookSubject(hookField.hook, body);
      if (!subjectField.subject) {
        return reply.code(400).send({ error: subjectField.error });
      }

      // The dashboard is the ONE surface where `shadow` may be honoured, and
      // only for an admin session; the client API token route calls
      // `readHookEvaluationOptions` with the default and never gets it.
      const optionsField = readHookEvaluationOptions(body, {
        allowShadow: canRequestShadowEvaluation(user),
      });
      if (!optionsField.options) {
        return reply.code(400).send({ error: optionsField.error });
      }

      return await respondWithHookVerdict({
        reply,
        hook: hookField.hook,
        subject: subjectField.subject,
        scope: hookScope({
          tenantId: session.tenantId,
          tenantDbName: session.tenantDbName,
          projectId,
          actor: dashboardActor(session, user),
          surface: 'dashboard',
          source: 'dashboard-hook',
          options: optionsField.options,
        }),
        guardrailKeys: [guardrail.key],
        visibility: resolveVerdictVisibility(readHooks(guardrail)),
        options: optionsField.options,
      });
    } catch (error) {
      logger.error('Evaluate guardrail hook error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  /**
   * The compiled policy for a remote enforcement point, with an `ETag` it can
   * revalidate against.
   *
   * This is what makes "switch this hook to log mode remotely" work without a
   * deploy: the point holds the compiled config, polls with `If-None-Match`,
   * gets a 304 while nothing has changed and a fresh body the moment an
   * operator edits a schedule, an action or the mode.
   *
   * A guardrail with no stored config compiles to an empty one, which is what
   * the engine would enforce for it.
   */
  app.get('/guardrails/:key/compiled', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const query = (request.query ?? {}) as { target?: string };

      const target = (query.target ?? 'agent-sdk') as CompileTarget;
      if (!(COMPILE_TARGETS as readonly string[]).includes(target)) {
        return reply.code(400).send({
          error: `target must be one of ${COMPILE_TARGETS.join(', ')}`,
        });
      }

      const guardrail = await guardrailByKeyInScope(session.tenantDbName, key, projectId, user);
      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      const payload = {
        target,
        contractVersion: GUARDRAIL_CONTRACT_VERSION,
        policyVersion: policyVersionOfView(guardrail),
        guardrail: {
          key: guardrail.key,
          name: guardrail.name,
          description: guardrail.description ?? null,
          enabled: guardrail.enabled,
          // The stored mode, plus what it resolves to once `enabled` is folded
          // in — a disabled guardrail is 'disabled' whatever its mode column
          // says, and a remote point must not have to re-derive that rule.
          mode: guardrail.mode ?? null,
          action: guardrail.action,
          failMode: guardrail.failMode ?? null,
          modelKey: guardrail.modelKey ?? null,
        },
        hooks: readHooks(guardrail),
        // Which hooks the installed agent SDK can actually serve. Synchronous
        // and SDK-free, so this stays a cheap GET.
        capabilities: sdkGuardrailCapabilities(),
      };

      const body = JSON.stringify(payload);
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`;

      if (etagMatches(request, etag)) {
        // 304 carries no body; the validators still have to be on it, or the
        // next request revalidates against nothing.
        return reply.code(304).header('ETag', etag).header('Cache-Control', 'no-cache').send();
      }

      return reply
        .code(200)
        .header('ETag', etag)
        // The policy must never be served from a cache without asking: an
        // operator switching a hook to log mode expects the next poll to see it.
        .header('Cache-Control', 'no-cache')
        .header('Content-Type', 'application/json; charset=utf-8')
        .send(body);
    } catch (error) {
      logger.error('Compile guardrail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/guardrails/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const guardrail = await guardrailInProjectScope(session.tenantDbName, id, projectId);

      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      return reply.code(200).send({ guardrail });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.patch('/guardrails/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const existing = await guardrailInProjectScope(session.tenantDbName, id, projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }
      const body = readJsonBody<Record<string, unknown>>(request);

      const parsed = parseGuardrailPatchBody(body);
      if (!parsed.ok) {
        return reply.code(parsed.status).send(guardrailWriteErrorBody(parsed));
      }

      const updated = await updateGuardrailFromRequest(
        {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId,
          actorId: session.userId,
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
      logger.error('Update guardrail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.delete('/guardrails/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!(await guardrailInProjectScope(session.tenantDbName, id, projectId))) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }
      const deleted = await deleteGuardrail(session.tenantDbName, id);

      if (!deleted) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete guardrail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  /**
   * Fire the red-team battery at one guardrail.
   *
   * Every probe runs with `shadow: true`, so a diagnostic never lands in the
   * tenant's audit trail or on their bill — that is the runner's own guarantee,
   * not something this route can grant or revoke.
   */
  app.post('/guardrails/:id/redteam', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const guardrail = await guardrailInProjectScope(session.tenantDbName, id, projectId);
      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      const report = await runGuardrailRedTeam({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        guardrailKey: guardrail.key,
      });

      return reply.code(200).send(report);
    } catch (error) {
      logger.error('Guardrail red-team error', { error });
      // The runner throws the facade's own "not found" message when the record
      // disappears between the scope policy and the run.
      if (error instanceof Error && error.message.toLowerCase().includes('not found')) {
        return reply.code(404).send({ error: error.message });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/guardrails/:id/evaluations', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as EvaluationsQuery;

      return await runWithTenantScope(session.tenantDbName, async (db) => {
        const guardrail = await guardrailInProjectScope(session.tenantDbName, id, projectId);
        if (!guardrail) {
          return reply.code(404).send({ error: 'Guardrail not found' });
        }

        const filter = parseDashboardDateFilterFromSearchParams(
          new URLSearchParams(query as Record<string, string>),
        );
        const limit = Math.min(Number.parseInt(query.limit ?? '50', 10), 200);
        const skip = Number.parseInt(query.skip ?? '0', 10);
        const from = query.from ?? filter.from?.toISOString();
        const to = query.to ?? filter.to?.toISOString();
        const passed = parseBooleanQuery(query.passed);
        const groupBy = query.groupBy ?? 'day';

        const [logs, aggregate] = await Promise.all([
          db.listGuardrailEvaluationLogs(id, {
            from: from ? new Date(from) : undefined,
            limit,
            passed,
            skip,
            to: to ? new Date(to) : undefined,
          }),
          db.aggregateGuardrailEvaluations(id, {
            from: from ? new Date(from) : undefined,
            groupBy,
            to: to ? new Date(to) : undefined,
          }),
        ]);

        return reply.code(200).send({ aggregate, logs });
      });
    } catch (error) {
      logger.error('List guardrail evaluations error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));
};

/** `If-None-Match` may carry several validators and a weak prefix; a strict
 *  equality test against the raw header answers 304 far less often than it
 *  should, and a cache that never revalidates successfully is a cache that
 *  re-downloads the whole policy on every poll. */
function etagMatches(request: FastifyRequest, etag: string): boolean {
  const header = request.headers['if-none-match'];
  if (typeof header !== 'string') return false;
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag || candidate === '*');
}
