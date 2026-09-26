import type { FastifyPluginAsync } from 'fastify';
import type { AgentStatus, IAgentConfig } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createAgentRecord,
  createConversation,
  deleteAgentRecord,
  getAgentByKey,
  getConversationById,
  listAgents,
  updateAgentRecord,
  runSyncAgentTurn,
  createBackgroundAgentRun,
  getAgentRunStatus,
  isBackgroundModeRequested,
  agentRunConflictErrorBody,
  agentSyncTimeoutErrorBody,
  idempotencyKeyRequiresBackgroundErrorBody,
  idempotencyKeyConflictErrorBody,
  agentRunConcurrencyLimitErrorBody,
} from '@/lib/services/agents';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  agentDefaultCallback,
  backgroundDisabledErrorBody,
  invalidRequestErrorBody,
  lookupIdempotentAgentRun,
  resolveAgentExecutionLimits,
  serializeAgentRun,
  validateCallbackRequest,
} from '@/lib/services/agents/agentRunService';
import type { LicenseType } from '@/lib/license/license-manager';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';
// By path: the agents barrel does not export the error class.
import { AgentGuardrailBlockedError } from '@/lib/services/agents/agentService';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import {
  getApiTokenContextForRequest,
  getHeaderValue,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';
import {
  connectedConfigForUpdate,
  normalizeA2aUpdate,
  prepareNewAgentConfig,
  publishValidatedAgent,
  redactAgent,
  sendAgentGuardrailBlock,
  validateNativeConfigUpdate,
} from './agent-config-write';
import { resolveConfigGuardrailBindings } from './guardrail-bindings';

const logger = createLogger('api:client-agents');

function extractUserMessage(input: unknown): string | null {
  if (typeof input === 'string') {
    return input;
  }

  if (Array.isArray(input)) {
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = input[index];
      if (!item || typeof item !== 'object') {
        continue;
      }

      const candidate = item as {
        content?: string | Array<Record<string, unknown>>;
        role?: string;
      };

      if (candidate.role === 'user' && typeof candidate.content === 'string') {
        return candidate.content;
      }

      if (candidate.role === 'user' && Array.isArray(candidate.content)) {
        const textPart = candidate.content.find(
          (part) => part.type === 'input_text' && typeof part.text === 'string',
        );
        if (textPart && typeof textPart.text === 'string') {
          return textPart.text;
        }
      }
    }
  }

  return null;
}

/**
 * Dual-prefix (§8, §12.3): `resp_<id>` is the synchronous scheme's id
 * (conversation-scoped) and also what a completed background run embeds as
 * its OWN `result.id` (`resp_<runId>`, §8); `run_<id>` is the background
 * run RESOURCE's own top-level id (the status-envelope `id` a caller
 * polling `GET /runs/:id` actually sees and is the most natural thing to
 * copy back as `previous_response_id`). Both must be accepted. Returns
 * `null` for anything else — an unrecognized prefix must 404, not silently
 * fall through to starting a brand-new conversation.
 */
function conversationIdFromResponseId(
  responseId: string,
): { strippedId: string; kind: 'resp' | 'run' } | null {
  if (responseId.startsWith('resp_')) return { strippedId: responseId.slice(5), kind: 'resp' };
  if (responseId.startsWith('run_')) return { strippedId: responseId.slice(4), kind: 'run' };
  return null;
}

function createResponsesHandler(usePublished: boolean) {
  return withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const model = body.model;

      if (typeof model !== 'string') {
        return reply.code(400).send({
          error: 'model field is required and must contain the agent key',
        });
      }

      const requestedVersion = body.version !== undefined && body.version !== null
        ? Number(body.version)
        : undefined;
      if (requestedVersion !== undefined && (!Number.isFinite(requestedVersion) || requestedVersion < 1)) {
        return reply.code(400).send({ error: 'version must be a positive integer' });
      }

      const agent = await getAgentByKey(ctx.tenantDbName, model, ctx.projectId);
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      if (agent.status !== 'active') {
        return reply.code(400).send({ error: 'Agent is not active' });
      }

      const userMessage = extractUserMessage(body.input);
      if (!userMessage) {
        return reply.code(400).send({
          error: 'input field is required (string or array of message items)',
        });
      }

      let conversationId: string | undefined;
      // §12.15's hash must never depend on a conversationId that is FRESH
      // on this specific attempt — a caller retrying "start a new
      // conversation" (no previous_response_id) gets a brand-new
      // conversationId on every attempt, so including it in the hash would
      // make the SAME logical retry never match itself. Only stabilize the
      // hash on conversationId when the caller explicitly continued an
      // EXISTING conversation via previous_response_id.
      let idempotencyConversationScope: string | null = null;
      if (typeof body.previous_response_id === 'string') {
        // Dual-mode (§8, §12.3): a background/run response is polled by its
        // OWN `run_<runId>` id, and its embedded `result.id` is
        // `resp_<runId>` — a caller may reasonably pass either back as
        // `previous_response_id`. A `run_` id MUST resolve via the AgentRun
        // lookup (no raw-conversationId fallback: that scheme never existed
        // for run ids). A `resp_` id keeps the existing dual-mode: try the
        // AgentRun lookup first, fall back to the raw-conversationId scheme
        // (the synchronous, conversation-scoped id) only if no run matches.
        //
        // agentKey alone is not unique across projects (findAgentByKey takes
        // an optional projectId precisely because the same key can exist in
        // more than one) — without the projectId check, a token in project B
        // could reuse a previous_response_id from project A's conversation
        // with the same-keyed agent and read/append to project A's history.
        const parsed = conversationIdFromResponseId(body.previous_response_id);
        const run = parsed
          ? await getAgentRunStatus(ctx.tenantDbName, ctx.tenantId, ctx.projectId, parsed.strippedId)
          : null;
        const resolvedConversationId = run ? run.conversationId : parsed?.kind === 'resp' ? parsed.strippedId : undefined;
        const conversation = resolvedConversationId !== undefined
          ? await getConversationById(ctx.tenantDbName, resolvedConversationId)
          : null;
        if (resolvedConversationId === undefined || !conversation
          || conversation.agentKey !== agent.key || conversation.projectId !== ctx.projectId) {
          return reply.code(404).send({
            error: 'previous_response_id does not match a valid conversation',
          });
        }
        conversationId = resolvedConversationId;
        idempotencyConversationScope = resolvedConversationId;
      }

      // Effective execution limits: min(env ceiling, tenant quota, the
      // agent's own Execution settings). Execution settings are operational
      // and apply without publishing, so they are read from the live agent.
      const limits = await resolveAgentExecutionLimits({
        agentConfig: agent.config,
        quotaContext: {
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          licenseType: ctx.tenant.licenseType as LicenseType,
          userId: ctx.tokenRecord.userId,
          tokenId: ctx.tokenRecord._id?.toString(),
        },
      });

      const idempotencyKey = getHeaderValue(request, 'idempotency-key');
      const background = isBackgroundModeRequested(
        getHeaderValue(request, 'x-cognipeer-background'),
        body,
        limits.defaultMode,
      );
      // §9/§12.15: Idempotency-Key is background-only — sync mode persists
      // nothing to key a retry against, so honoring it would silently do
      // nothing. Rejected loudly instead.
      if (idempotencyKey && !background) {
        return reply.code(400).send(idempotencyKeyRequiresBackgroundErrorBody());
      }
      if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        return reply.code(400).send(invalidRequestErrorBody(`Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`, 'idempotency_key_too_long'));
      }
      if (background && !limits.backgroundEnabled) {
        return reply.code(400).send(backgroundDisabledErrorBody());
      }

      let callback: { url?: string; secret?: string } = {};
      if (background) {
        const requested = await validateCallbackRequest(body.callback_url, body.callback_secret);
        if (!requested.ok) return reply.code(400).send(invalidRequestErrorBody(requested.message, 'invalid_callback'));
        callback = requested.url ? { url: requested.url, secret: requested.secret } : agentDefaultCallback(agent.config);
      }

      // A replayed request must not mint a fresh conversation first — every
      // retry of "start a new conversation" would leave an orphan behind.
      if (background && idempotencyKey) {
        const prior = await lookupIdempotentAgentRun({
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          agentKey: agent.key,
          userMessage,
          version: requestedVersion,
          idempotencyKey,
          idempotencyConversationScope,
        });
        if (prior.kind === 'conflict') return reply.code(409).send(idempotencyKeyConflictErrorBody());
        if (prior.kind === 'replay') return reply.code(200).send(serializeAgentRun(prior.run));
      }

      if (!conversationId) {
        const conversation = await createConversation(
          ctx.tenantDbName,
          ctx.tenantId,
          ctx.projectId,
          ctx.tokenRecord.userId,
          agent.key,
          undefined,
          { source: 'api' },
        );
        conversationId = String(conversation._id);
      }

      const apiTokenId = ctx.tokenRecord._id ? String(ctx.tokenRecord._id) : undefined;
      const runtimeContext = buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
        userId: ctx.tokenRecord.userId,
        tokenId: apiTokenId,
        source: 'api',
      });

      if (background) {
        const outcome = await createBackgroundAgentRun({
          tenantId: ctx.tenantId,
          tenantDbName: ctx.tenantDbName,
          projectId: ctx.projectId,
          agentKey: agent.key,
          conversationId,
          userMessage,
          userId: ctx.tokenRecord.userId,
          version: requestedVersion,
          usePublished,
          runtimeContext,
          apiTokenId,
          callbackUrl: callback.url,
          callbackSecret: callback.secret,
          idempotencyKey: idempotencyKey ?? undefined,
          idempotencyConversationScope,
          limits,
        });
        if (outcome.kind === 'conflict') {
          return reply.code(409).send(agentRunConflictErrorBody());
        }
        if (outcome.kind === 'idempotency_conflict') {
          return reply.code(409).send(idempotencyKeyConflictErrorBody());
        }
        if (outcome.kind === 'concurrency_limit') {
          return reply.code(429).send(agentRunConcurrencyLimitErrorBody(outcome.limit, outcome.scope));
        }
        // `idempotent_replay` returns the SAME run a prior identical request
        // already created — 200, not 202, since no new work was queued here.
        return reply.code(outcome.kind === 'idempotent_replay' ? 200 : 202).send(serializeAgentRun(outcome.run));
      }

      // §3.2/§12.14: the same single-active-run check runs against
      // AgentRun before running inline — a background run already
      // `queued`/`running` for this conversation rejects a synchronous
      // request the same way it would reject a second background one.
      const syncOutcome = await runSyncAgentTurn({
        request: {
          agentKey: agent.key,
          conversationId,
          projectId: ctx.projectId,
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          usePublished,
          userId: ctx.tokenRecord.userId,
          userMessage,
          version: requestedVersion,
          runtimeContext,
        },
        syncTimeoutMs: limits.syncTimeoutMs,
      });
      if (syncOutcome.kind === 'conflict') {
        return reply.code(409).send(agentRunConflictErrorBody());
      }
      if (syncOutcome.kind === 'timeout') {
        return reply.code(504).send(agentSyncTimeoutErrorBody());
      }

      const { _conversation_messages, ...responseBody } = syncOutcome.response;
      void _conversation_messages;
      return reply.code(200).send(responseBody);
    } catch (error) {
      if (error instanceof AgentGuardrailBlockedError) {
        // Info, not error: a refused prompt is policy working as configured.
        logger.info('Client agent response blocked by guardrail', {
          guardrailKey: error.guardrailKey,
          hook: error.hook,
        });
        return sendAgentGuardrailBlock(reply, error);
      }
      logger.error('Client agent responses error', { error });
      // Which failure it was — a provider rejecting its key, a model that no
      // longer exists, a rate limit — instead of one opaque 500 for all.
      const classified = classifyAgentRunError(error);
      return reply.code(classified.status).send({ error: classified.error });
    }
  });
}

export const clientAgentsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/agents', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { status?: AgentStatus };
      const agents = await listAgents(ctx.tenantDbName, {
        ...(query.status ? { status: query.status } : {}),
        projectId: ctx.projectId,
      });

      return reply.code(200).send({
        agents: agents.map((agent) => ({
          config: {
            maxTokens: agent.config.maxTokens,
            modelKey: agent.config.modelKey,
            temperature: agent.config.temperature,
            topP: agent.config.topP,
          },
          createdAt: agent.createdAt,
          description: agent.description,
          key: agent.key,
          name: agent.name,
          status: agent.status,
        })),
      });
    } catch (error) {
      logger.error('List client agents error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/agents/:agentKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentKey } = request.params as { agentKey: string };
      const agent = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({
        agent: {
          config: {
            maxTokens: agent.config.maxTokens,
            modelKey: agent.config.modelKey,
            temperature: agent.config.temperature,
            topP: agent.config.topP,
          },
          createdAt: agent.createdAt,
          description: agent.description,
          key: agent.key,
          name: agent.name,
          status: agent.status,
        },
      });
    } catch (error) {
      logger.error('Get client agent error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // Deliberately different defaults, not a typo: /agents/responses always
  // runs the published version (usePublished=true); the general /responses
  // dialect runs the current draft config unless the caller asks for a
  // specific version (usePublished=false). A caller who has only ever seen
  // a published version in the dashboard can otherwise assume the general
  // Responses route uses it too — it does not, unless told to.
  app.post('/client/v1/agents/responses', createResponsesHandler(true));
  app.post('/client/v1/responses', createResponsesHandler(false));

  // ── Authoring: create an agent definition ──
  app.post('/client/v1/agents', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'Agent name is required' });
      }

      // Guardrail bindings, validated exactly as the dashboard route validates
      // them. No `user`: a token is scoped to its project, so a guardrail owned
      // by another project is out of reach and only a tenant-wide one (no
      // projectId) falls back.
      const prepared = await prepareNewAgentConfig(body.config, {
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
      });
      if ('badRequest' in prepared) return reply.code(400).send(prepared.badRequest);

      const agent = await createAgentRecord(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        ctx.tokenRecord.userId,
        {
          config: prepared.config,
          description: typeof body.description === 'string' ? body.description : undefined,
          name: body.name,
          status: body.status as AgentStatus | undefined,
        },
      );

      return reply.code(201).send({ agent: redactAgent(agent) });
    } catch (error) {
      logger.error('Create client agent error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  // ── Authoring: update an agent definition (project-scoped resolve by key) ──
  app.patch('/client/v1/agents/:agentKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentKey } = request.params as { agentKey: string };
      const existing = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);

      if (body.config && typeof body.config === 'object') {
        const cfg = body.config as Record<string, unknown>;
        if (cfg.kind === 'external') {
          let externalConfig: IAgentConfig;
          try {
            externalConfig = connectedConfigForUpdate(cfg, existing);
          } catch (validationError) {
            return reply.code(400).send({
              error: validationError instanceof Error ? validationError.message : 'Invalid agent config',
            });
          }
          const bindings = await resolveConfigGuardrailBindings(
            ctx.tenantDbName,
            ctx.projectId,
            cfg.guardrails,
          );
          if (bindings.error) {
            return reply.code(400).send({ error: bindings.error });
          }
          if (bindings.patch) Object.assign(externalConfig, bindings.patch);
          body.config = externalConfig;
        } else if (existing.config?.kind === 'external') {
          // Guard: never let a native-shaped config silently clobber a stored
          // connected agent's connection.
          delete body.config;
        } else {
          const checked = await validateNativeConfigUpdate(cfg, existing.key, {
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            projectId: ctx.projectId,
          });
          if ('badRequest' in checked) return reply.code(400).send(checked.badRequest);
        }
      }

      normalizeA2aUpdate(body, existing);

      const agent = await updateAgentRecord(
        ctx.tenantDbName,
        String(existing._id),
        body,
        ctx.tokenRecord.userId,
      );
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ agent: redactAgent(agent) });
    } catch (error) {
      logger.error('Update client agent error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  // ── Authoring: delete an agent definition (project-scoped resolve by key) ──
  app.delete('/client/v1/agents/:agentKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentKey } = request.params as { agentKey: string };
      const existing = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const deleted = await deleteAgentRecord(ctx.tenantDbName, String(existing._id));
      if (!deleted) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client agent error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  // ── Authoring: publish the current config as a new version ──
  app.post('/client/v1/agents/:agentKey/publish', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentKey } = request.params as { agentKey: string };
      const existing = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const published = await publishValidatedAgent(
        request,
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        existing,
        String(existing._id),
        ctx.tokenRecord.userId,
      );
      if ('badRequest' in published) return reply.code(400).send(published.badRequest);
      return reply.code(201).send({ version: published.version });
    } catch (error) {
      logger.error('Publish client agent error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to publish agent',
      });
    }
  }));
};
