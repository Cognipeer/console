import { AgentDocumentParseError } from '@/lib/services/agents/import/document';
import {
  AgentImportError,
  applyAgentDocumentImport,
  previewAgentDocumentImport,
  type ApplyAgentDocumentImportInput,
} from '@/lib/services/agents/import/importService';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { maskAgentSandboxSecrets } from '@/lib/services/agents/agentSandboxSecrets';
import { resolveSandboxAvailability } from '@/lib/services/agents/agentSandboxTools';
import type { AgentStatus, IAgent, IAgentConfig, IAgentConversation, IUser } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createAgentRecord,
  createConversation,
  deleteAgentRecord,
  deleteConversation,
  executePlaygroundChat,
  getAgentById,
  getConversationById,
  getAgentVersion,
  listAgents,
  listAgentVersions,
  listConversations,
  updateAgentRecord,
} from '@/lib/services/agents';
// By path: the agents barrel does not export the error class.
import {
  AgentGuardrailBlockedError,
  checkAgentModel,
  // Imported BY PATH: the barrel exports the queue-routing wrapper, and the
  // streaming route deliberately needs the local one (a progress callback
  // cannot cross the job queue).
  executePlaygroundChatLocal,
} from '@/lib/services/agents/agentService';
import {
  validateAgentConfig,
  type AgentConfigIssue,
} from '@/lib/services/agents/agentConfigValidation';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import {
  AgentManifestError,
  applyAgentManifest,
  buildAgentManifest,
  parseAgentManifest,
  previewAgentImport,
  serializeAgentManifest,
  type AgentManifestFormat,
} from '@/lib/services/agents/agentManifest';
import { collectManifestResources, parseResourceInclude } from '@/lib/services/agents/manifestResources';
import {
  generateAgentProject,
  type AgentCodegenTarget,
} from '@/lib/services/agents/agentCodegen';
import { buildPromptVariables, renderPromptTemplate } from '@/lib/services/agents/promptVariables';
import {
  computeScheduleNextRun,
  deleteAgentSchedule,
  readSchedules,
  runAgentSchedule,
  upsertAgentSchedule,
  type AgentScheduleInput,
} from '@/lib/services/agents/agentScheduleService';
import { getDatabase } from '@/lib/database';
import {
  getAgentRunStatus,
  listAgentRuns,
  requestAgentRunCancellation,
  reserveConversationForSyncTurn,
  resolveAgentExecutionLimits,
  serializeAgentRun,
} from '@/lib/services/agents/agentRunService';
import type { LicenseType } from '@/lib/license/license-manager';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import {
  applyStreamHeaders,
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import {
  applyConfigGuardrailBindings,
  connectedConfigForUpdate,
  normalizeA2aUpdate,
  prepareNewAgentConfig,
  publishValidatedAgent,
  redactAgent,
  sendAgentGuardrailBlock,
  validateNativeConfigUpdate,
} from './agent-config-write';

const logger = createLogger('api:agents');

/** A version snapshot carries the config it froze — sandbox secrets included. */
function redactVersion<T extends { snapshot?: { config?: IAgentConfig } }>(version: T): T {
  if (!version?.snapshot?.config?.sandbox) return version;
  return { ...version, snapshot: maskAgentSandboxSecrets(version.snapshot) } as T;
}

/**
 * Resolve an agent by id within the caller's project scope.
 *
 * getAgentById is scoped only by the tenant database, so without this an
 * ordinary member could address any agent in the tenant: read its prompt and
 * connection config, rewrite or delete it, or run it on the owning project's
 * credentials. Returns null for an out-of-scope id so it is indistinguishable
 * from a missing one. Owners and admins keep tenant-wide reach, which
 * resolveProjectContext already grants them, and agents stored without a
 * projectId stay tenant-wide.
 */
async function agentInProjectScope(
  tenantDbName: string,
  agentId: string,
  projectId: string,
  user: Pick<IUser, 'role'>,
): Promise<IAgent | null> {
  const agent = await getAgentById(tenantDbName, agentId);
  if (!agent) return null;
  if (user.role === 'owner' || user.role === 'admin') return agent;
  if (!agent.projectId) return agent;
  return String(agent.projectId) === String(projectId) ? agent : null;
}

/**
 * The caller's project context plus the agent `:agentId` names, or null —
 * with the 404 already sent — when it is missing or out of scope.
 */
async function requireScopedAgent(request: FastifyRequest, reply: FastifyReply) {
  const context = await requireProjectContextForRequest(request);
  const { agentId } = request.params as { agentId: string };
  const agent = await agentInProjectScope(context.session.tenantDbName, agentId, context.projectId, context.user);
  if (!agent) {
    void reply.code(404).send({ error: 'Agent not found' });
    return null;
  }
  return { ...context, agentId, agent };
}

/**
 * Logs a failed route and answers it: the project-context status when that is
 * what failed, else a 500 with `message`.
 */
function sendRouteError(reply: FastifyReply, error: unknown, logMessage: string, message: string) {
  logger.error(logMessage, { error });
  return sendProjectContextError(reply, error) ?? reply.code(500).send({ error: message });
}

/**
 * A dashboard turn on a session holds that conversation's run slot, the same
 * one API and background runs take — two turns writing one conversation at
 * once lose one turn's history. `undefined` = stateless (no session), `null`
 * = the slot is taken.
 */
async function reserveDashboardSession(input: {
  session: { tenantId: string; tenantDbName: string; userId: string };
  projectId: string;
  agentKey: string;
  conversationId: unknown;
  userMessage: string;
}) {
  if (typeof input.conversationId !== 'string') return undefined;
  return reserveConversationForSyncTurn(await getDatabase(), {
    tenantId: input.session.tenantId,
    tenantDbName: input.session.tenantDbName,
    projectId: input.projectId,
    agentKey: input.agentKey,
    conversationId: input.conversationId,
    userMessage: input.userMessage,
    userId: input.session.userId,
  });
}

const SESSION_BUSY_BODY = {
  error: 'This session already has a run in progress. Wait for it to finish or start a new session.',
  type: 'agent_run_conflict',
  code: 'agent_run_conflict',
};

/**
 * Dashboard chat may only extend a console session. API / A2A / scheduled /
 * eval sessions are real traffic — the UI shows them read-only, and this keeps
 * a hand-crafted request from appending to them. Legacy sessions (no source)
 * stay writable, matching `isContinuableSession` on the client.
 */
async function readOnlySessionSource(tenantDbName: string, conversationId: unknown): Promise<string | null> {
  if (typeof conversationId !== 'string') return null;
  const conversation = await getConversationById(tenantDbName, conversationId);
  const source = conversation?.metadata?.source;
  return typeof source === 'string' && source !== 'console' ? source : null;
}

/**
 * What `/chat` and `/chat/stream` both check before a playground turn runs:
 * the message, the agent in scope, a writable session and its run slot. Null —
 * with the refusal already sent — when any of them is missing. Otherwise the
 * held reservation (release it when the turn ends) and the run input.
 */
async function prepareDashboardTurn(request: FastifyRequest, reply: FastifyReply) {
  const { projectId, user, session } = await requireProjectContextForRequest(request);
  const { agentId } = request.params as { agentId: string };
  const body = readJsonBody<Record<string, unknown>>(request);

  if (typeof body.message !== 'string') {
    void reply.code(400).send({ error: 'Message is required' });
    return null;
  }
  const agent = await agentInProjectScope(session.tenantDbName, agentId, projectId, user);
  if (!agent) {
    void reply.code(404).send({ error: 'Agent not found' });
    return null;
  }
  const readOnlySource = await readOnlySessionSource(session.tenantDbName, body.conversationId);
  if (readOnlySource) {
    void reply.code(409).send({ error: `This session came in via ${readOnlySource} and is read-only. Start a new session to test the agent.` });
    return null;
  }
  const reservation = await reserveDashboardSession({
    session, projectId, agentKey: agent.key, conversationId: body.conversationId, userMessage: body.message,
  });
  if (reservation === null) {
    void reply.code(409).send(SESSION_BUSY_BODY);
    return null;
  }

  return {
    body,
    reservation,
    run: {
      agentKey: agent.key,
      // Playground JSON editor: caller-supplied runtime context (downstream
      // headers/metadata), stamped with the dashboard user's identity.
      runtimeContext: buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
        userId: session.userId,
        source: 'playground',
      }),
      projectId,
      tenantDbName: session.tenantDbName,
      tenantId: session.tenantId,
      userMessage: body.message,
      ...(typeof body.version === 'number' ? { version: body.version } : {}),
      ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
    },
  };
}

/**
 * One row of the sessions table: what it is, what it cost, how long it worked.
 *
 * Totals come from the turns themselves — each one recorded its own tokens,
 * price and server-measured latency when it ran (`persistSessionTurn`) — so a
 * session listed months later shows the same numbers it showed live, at the
 * prices that applied then rather than today's.
 */
function summariseConversation(conversation: IAgentConversation) {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let activeMs = 0;
  let turns = 0;
  // A turn that reported usage but no price leaves the total a lower bound,
  // which the UI marks rather than presenting as exact.
  let costComplete = true;
  // What the Sessions filters ask ("did anything go wrong?") — the same
  // verdicts the session drawer badges: a failed tool call or an output that
  // failed its schema is an error; a run cut short by a limit, a cancel or an
  // unresumable pause is "stopped".
  let failedCalls = 0;
  let hasError = false;
  let stopped = false;

  for (const message of conversation.messages ?? []) {
    if (message.role !== 'assistant') continue;
    turns += 1;
    for (const step of message.steps ?? []) {
      if (step.status === 'error' || step.error) failedCalls += 1;
    }
    if (message.outputError) hasError = true;
    if (message.stopReason) stopped = true;
    inputTokens += message.usage?.inputTokens ?? 0;
    outputTokens += message.usage?.outputTokens ?? 0;
    totalTokens += message.usage?.totalTokens ?? 0;
    activeMs += message.latencyMs ?? 0;
    if (message.usage?.costUsd === undefined) {
      if (message.usage) costComplete = false;
    } else {
      costUsd += message.usage.costUsd;
    }
  }

  return {
    _id: String(conversation._id),
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages?.length ?? 0,
    turns,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    costComplete,
    activeMs,
    failedCalls,
    status: hasError || failedCalls > 0 ? 'error' : stopped ? 'stopped' : turns > 0 ? 'success' : 'empty',
    source: typeof conversation.metadata?.source === 'string' ? conversation.metadata.source : undefined,
    hasContext: Boolean(
      conversation.metadata?.runtimeContext
      && Object.keys(conversation.metadata.runtimeContext as Record<string, unknown>).length > 0,
    ),
  };
}

export const agentsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/agents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string; status?: string };
      const agents = await listAgents(session.tenantDbName, {
        projectId,
        search: query.search,
        status: query.status as AgentStatus | undefined,
      });

      return reply.code(200).send({ agents: agents.map(redactAgent) });
    } catch (error) {
      return sendRouteError(reply, error, 'List agents error', 'Failed to list agents');
    }
  }));

  app.post('/agents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session, user } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'Agent name is required' });
      }

      const prepared = await prepareNewAgentConfig(body.config, {
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        user,
      });
      if ('badRequest' in prepared) return reply.code(400).send(prepared.badRequest);

      const agent = await createAgentRecord(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        {
          config: prepared.config,
          description: body.description as string | undefined,
          name: body.name,
        },
      );

      return reply.code(201).send({ agent: redactAgent(agent), warnings: prepared.warnings });
    } catch (error) {
      return sendRouteError(reply, error, 'Create agent error', 'Failed to create agent');
    }
  }));

  app.get('/agents/:agentId', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      return reply.code(200).send({ agent: redactAgent(scoped.agent) });
    } catch (error) {
      return sendRouteError(reply, error, 'Get agent error', 'Failed to get agent');
    }
  }));

  app.patch('/agents/:agentId', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent: existing, agentId, projectId, session, user } = scoped;
      const body = readJsonBody<Record<string, unknown>>(request);
      let warnings: AgentConfigIssue[] = [];

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
          const bindingError = await applyConfigGuardrailBindings(
            externalConfig,
            session.tenantDbName,
            projectId,
            user,
          );
          if (bindingError) {
            return reply.code(400).send({ error: bindingError });
          }
          body.config = externalConfig;
        } else if (existing.config?.kind === 'external') {
          // Guard: never let a native-shaped config silently clobber a stored
          // connected agent's connection (e.g. a stray playground auto-save).
          delete body.config;
        } else {
          const checked = await validateNativeConfigUpdate(cfg, existing.key, {
            tenantDbName: session.tenantDbName,
            tenantId: session.tenantId,
            projectId,
            user,
          });
          if ('badRequest' in checked) return reply.code(400).send(checked.badRequest);
          warnings = checked.warnings;
        }
      }

      normalizeA2aUpdate(body, existing);

      const agent = await updateAgentRecord(session.tenantDbName, agentId, body, session.userId);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ agent: redactAgent(agent), warnings });
    } catch (error) {
      return sendRouteError(reply, error, 'Update agent error', 'Failed to update agent');
    }
  }));

  app.delete('/agents/:agentId', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const deleted = await deleteAgentRecord(scoped.session.tenantDbName, scoped.agentId);

      if (!deleted) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      return sendRouteError(reply, error, 'Delete agent error', 'Failed to delete agent');
    }
  }));

  app.get('/agents/:agentId/versions', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, agentId, session } = scoped;
      const query = (request.query ?? {}) as { limit?: string; skip?: string; version?: string };

      if (query.version) {
        const version = await getAgentVersion(
          session.tenantDbName,
          agentId,
          Number.parseInt(query.version, 10),
        );

        if (!version) {
          return reply.code(404).send({ error: 'Version not found' });
        }

        return reply.code(200).send({ version: redactVersion(version) });
      }

      const result = await listAgentVersions(session.tenantDbName, agentId, {
        limit: Number.parseInt(query.limit ?? '50', 10),
        skip: Number.parseInt(query.skip ?? '0', 10),
      });

      return reply.code(200).send({
        publishedVersion: agent.publishedVersion ?? null,
        total: result.total,
        versions: result.versions.map(redactVersion),
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent versions error', 'Failed to list agent versions');
    }
  }));

  /**
   * Flattens `promptKey` + `promptVariables` into a literal `systemPrompt` for
   * code export. The generated project has no Prompts module and no runtime
   * context, so anything left unresolved here would stay unresolved forever.
   */
  async function resolveConfigForExport(
    tenantDbName: string,
    projectId: string,
    agent: IAgent,
    config: IAgentConfig,
  ): Promise<IAgentConfig> {
    let template = config.systemPrompt;
    if (!template && config.promptKey) {
      const db = await getDatabase();
      await db.switchToTenant(tenantDbName);
      const prompt = await db.findPromptByKey(config.promptKey, projectId);
      template = prompt?.template;
    }
    if (!template) return config;

    const variables = buildPromptVariables({
      config,
      agentKey: agent.key,
      agentName: agent.name,
      version: agent.publishedVersion ?? null,
    });
    const rendered = renderPromptTemplate(template, variables);
    return { ...config, systemPrompt: rendered.text, promptKey: undefined };
  }

  // ── Manifest export / import ───────────────────────────────────────────

  app.get('/agents/:agentId/export', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, agentId, projectId, session } = scoped;
      const query = (request.query ?? {}) as { format?: string; version?: string; download?: string; include?: string };

      const format: AgentManifestFormat = query.format === 'yaml' ? 'yaml' : 'json';
      // `include=skills,prompts,mcp,tools` (or `all`) embeds those definitions
      // so the manifest can be imported into a project that lacks them.
      let include;
      try {
        include = parseResourceInclude(query.include);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }

      // No `version` exports the DRAFT config — what the playground runs. A
      // version number exports that immutable snapshot instead, which is what
      // anyone promoting between environments actually wants.
      let config = agent.config;
      let version: number | null = null;
      if (query.version) {
        const requested = Number.parseInt(query.version, 10);
        if (!Number.isFinite(requested)) {
          return reply.code(400).send({ error: 'version must be a number' });
        }
        const snapshot = await getAgentVersion(session.tenantDbName, agentId, requested);
        if (!snapshot) return reply.code(404).send({ error: 'Version not found' });
        config = snapshot.snapshot.config;
        version = requested;
      }

      const { resources, skipped } = await collectManifestResources(session.tenantDbName, projectId, config, include);
      const manifest = buildAgentManifest(agent, config, version, resources);
      const body = serializeAgentManifest(manifest, format);

      if (query.download === '1') {
        return reply
          .code(200)
          .header('content-type', format === 'yaml' ? 'application/yaml' : 'application/json')
          .header(
            'content-disposition',
            `attachment; filename="${agent.key}${version !== null ? `-v${version}` : ''}.${format}"`,
          )
          .send(body);
      }

      return reply.code(200).send({ format, manifest, content: body, skippedResources: skipped });
    } catch (error) {
      return sendRouteError(reply, error, 'Export agent error', 'Failed to export agent');
    }
  }));

  app.post('/agents/import', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const body = await readJsonBody<{
        content?: string;
        manifest?: unknown;
        format?: AgentManifestFormat;
        /** `true` validates and reports only — nothing is written. */
        dryRun?: boolean;
        mode?: 'create' | 'update' | 'upsert';
        key?: string;
        name?: string;
        allowMissingDependencies?: boolean;
      }>(request);

      if (!body?.content && !body?.manifest) {
        return reply.code(400).send({ error: 'content or manifest is required' });
      }

      const manifest = body.content
        ? parseAgentManifest(body.content, body.format)
        : parseAgentManifest(JSON.stringify(body.manifest), 'json');

      if (body.dryRun) {
        const preview = await previewAgentImport(session.tenantDbName, projectId, manifest);
        return reply.code(200).send(preview);
      }

      const result = await applyAgentManifest(
        session.tenantDbName,
        session.tenantId,
        projectId,
        String(user._id),
        manifest,
        {
          mode: body.mode,
          key: body.key,
          name: body.name,
          allowMissingDependencies: body.allowMissingDependencies,
        },
      );

      return reply.code(result.action === 'created' ? 201 : 200).send({
        agent: redactAgent(result.agent),
        action: result.action,
        missing: result.missing,
      });
    } catch (error) {
      if (error instanceof AgentManifestError) {
        return reply.code(400).send({ error: error.message, issues: error.issues });
      }
      return sendRouteError(reply, error, 'Import agent error', 'Failed to import agent');
    }
  }));

  // ── Import from a definition document (New → Import) ────────────────
  // Any supported format — the console manifest or a Claude Managed Agent
  // (JSON / YAML / Markdown front-matter) — auto-detected unless `format`
  // says otherwise. `/preview` writes nothing.
  const sendImportError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AgentDocumentParseError) return reply.code(400).send({ error: error.message });
    if (error instanceof AgentImportError) {
      return reply.code(error.status).send({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    if (error instanceof AgentManifestError) return reply.code(400).send({ error: error.message, issues: error.issues });
    return null;
  };

  app.post('/agents/import/document/preview', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const body = await readJsonBody<{ content?: string; format?: string }>(request);
      if (typeof body?.content !== 'string' || !body.content.trim()) {
        return reply.code(400).send({ error: 'content is required' });
      }
      const preview = await previewAgentDocumentImport(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, userId: String(user._id) },
        body.content,
        body.format,
      );
      return reply.code(200).send(preview);
    } catch (error) {
      return sendImportError(reply, error)
        ?? sendRouteError(reply, error, 'Preview agent document import error', 'Failed to read the document');
    }
  }));

  app.post('/agents/import/document', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const body = await readJsonBody<ApplyAgentDocumentImportInput>(request);
      if (typeof body?.content !== 'string' || !body.content.trim()) {
        return reply.code(400).send({ error: 'content is required' });
      }
      const result = await applyAgentDocumentImport(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, userId: String(user._id) },
        body,
      );
      return reply.code(result.action === 'created' ? 201 : 200).send({
        agent: redactAgent(result.agent),
        action: result.action,
        created: result.created,
        warnings: result.warnings,
      });
    } catch (error) {
      return sendImportError(reply, error)
        ?? sendRouteError(reply, error, 'Agent document import error', 'Failed to import agent');
    }
  }));

  // ── Schedules ──────────────────────────────────────────────────────────

  app.get('/agents/:agentId/schedules', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent } = scoped;

      const schedules = readSchedules(agent);
      return reply.code(200).send({
        schedules,
        // Recomputed for display rather than trusted from storage: a stored
        // nextRunAt goes stale the moment the cron is edited elsewhere.
        nextRuns: Object.fromEntries(
          schedules.map((schedule) => [schedule.id, computeScheduleNextRun(schedule)?.toISOString() ?? null]),
        ),
        publishedVersion: agent.publishedVersion ?? null,
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent schedules error', 'Failed to list schedules');
    }
  }));

  app.post('/agents/:agentId/schedules', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, session, user } = scoped;

      const body = await readJsonBody<AgentScheduleInput>(request);
      if (!body) return reply.code(400).send({ error: 'A schedule body is required' });

      const { schedule, schedules } = await upsertAgentSchedule(
        session.tenantDbName,
        agent,
        body,
        String(user._id),
      );
      return reply.code(body.id ? 200 : 201).send({ schedule, schedules });
    } catch (error) {
      // Validation failures here are the operator's cron, not a server fault.
      const message = error instanceof Error ? error.message : String(error);
      if (/^(name|message) is required|cron|interval|schedule/i.test(message)) {
        return reply.code(400).send({ error: message });
      }
      return sendRouteError(reply, error, 'Save agent schedule error', 'Failed to save schedule');
    }
  }));

  app.delete('/agents/:agentId/schedules/:scheduleId', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, session, user } = scoped;
      const { scheduleId } = request.params as { scheduleId: string };

      const schedules = await deleteAgentSchedule(session.tenantDbName, agent, scheduleId, String(user._id));
      return reply.code(200).send({ schedules });
    } catch (error) {
      return sendRouteError(reply, error, 'Delete agent schedule error', 'Failed to delete schedule');
    }
  }));

  app.post('/agents/:agentId/schedules/:scheduleId/run', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, session, user } = scoped;
      const { scheduleId } = request.params as { scheduleId: string };
      if (!agent.publishedVersion) {
        return reply.code(409).send({
          error: 'Publish the agent first — a scheduled run always uses the published version',
        });
      }

      const schedule = readSchedules(agent).find((entry) => entry.id === scheduleId);
      if (!schedule) return reply.code(404).send({ error: 'Schedule not found' });

      // A manual run is awaited (the operator is watching) but must NOT advance
      // `nextRunAt` — testing a schedule should not skip its next real fire.
      const result = await runAgentSchedule({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId: agent.projectId,
        agent,
        schedule,
        trigger: 'manual',
        userId: String(user._id),
      });

      return reply.code(200).send(result);
    } catch (error) {
      return sendAgentGuardrailBlock(reply, error)
        ?? sendRouteError(reply, error, 'Manual schedule run error', 'Failed to run schedule');
    }
  }));

  // ── Code export ────────────────────────────────────────────────────────

  app.post('/agents/:agentId/codegen', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const body = await readJsonBody<{
        target?: AgentCodegenTarget;
        packageName?: string;
        consoleBaseUrl?: string;
        includeDockerfile?: boolean;
        version?: number;
        /** `zip` streams an archive; anything else returns the file list as JSON. */
        format?: 'zip' | 'json';
      }>(request);

      const agent = await agentInProjectScope(session.tenantDbName, agentId, projectId, user);
      if (!agent) return reply.code(404).send({ error: 'Agent not found' });

      const target = body?.target ?? 'server';
      if (!['cli', 'server', 'worker', 'lambda'].includes(target)) {
        return reply.code(400).send({ error: `Unknown target "${target}"` });
      }

      let config = agent.config;
      if (typeof body?.version === 'number') {
        const snapshot = await getAgentVersion(session.tenantDbName, agentId, body.version);
        if (!snapshot) return reply.code(404).send({ error: 'Version not found' });
        config = snapshot.snapshot.config;
      }

      // Resolve the prompt the way the runtime does before handing it to the
      // generator. Without this an agent backed by a shared prompt exports with
      // no system prompt at all, and one with variables exports the hollow
      // template — both produce a project that quietly behaves differently from
      // the agent it was generated from.
      const exportConfig = await resolveConfigForExport(session.tenantDbName, projectId, agent, config);

      const result = generateAgentProject(agent, exportConfig, {
        target,
        packageName: body?.packageName,
        consoleBaseUrl: body?.consoleBaseUrl,
        includeDockerfile: body?.includeDockerfile,
      });

      if (body?.format === 'zip') {
        const { default: JSZip } = await import('jszip');
        const zip = new JSZip();
        const root = zip.folder(result.rootDir);
        for (const file of result.files) root?.file(file.path, file.contents);
        const buffer = await zip.generateAsync({ type: 'nodebuffer' });
        return reply
          .code(200)
          .header('content-type', 'application/zip')
          .header('content-disposition', `attachment; filename="${result.rootDir}.zip"`)
          .send(buffer);
      }

      return reply.code(200).send(result);
    } catch (error) {
      return sendRouteError(reply, error, 'Agent codegen error', 'Failed to generate agent code');
    }
  }));

  app.post('/agents/:agentId/publish', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const scoped = await agentInProjectScope(session.tenantDbName, agentId, projectId, user);
      if (!scoped) {
        // Same failure an unknown id already raises inside publishAgent, so the
        // route cannot confirm that another project's agent exists.
        throw new Error(`Agent "${agentId}" not found`);
      }
      const published = await publishValidatedAgent(
        request,
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        scoped,
        agentId,
        session.userId,
      );
      if ('badRequest' in published) return reply.code(400).send(published.badRequest);
      return reply.code(201).send({ version: published.version });
    } catch (error) {
      return sendRouteError(
        reply,
        error,
        'Publish agent error',
        error instanceof Error ? error.message : 'Failed to publish agent',
      );
    }
  }));

  /**
   * What the Sandbox section of an agent can offer: whether this deployment
   * has the sandbox module, whether the tenant's license unlocks it, and the
   * templates to pick from. Always 200 — `available: false` with a `reason`
   * is an answer the UI renders, not a failure.
   */
  app.get('/agents/sandbox/capabilities', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const availability = await resolveSandboxAvailability(session.tenantId);
      if (!availability.available) {
        return reply.code(200).send({ available: false, reason: availability.reason, templates: [] });
      }
      const templates = await availability.runner.listTemplates(session.tenantDbName, session.tenantId)
        .catch((error: unknown) => {
          logger.warn('Could not list sandbox templates', { error });
          return [];
        });
      return reply.code(200).send({ available: true, templates });
    } catch (error) {
      return sendRouteError(reply, error, 'Agent sandbox capabilities error', 'Failed to read sandbox capabilities');
    }
  }));

  // Effective execution ceilings for this tenant/project (env ∧ quota) —
  // the Build → Execution card shows them as the maximum an agent may set.
  app.get('/agents/execution/limits', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const limits = await resolveAgentExecutionLimits({
        quotaContext: {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId,
          licenseType: session.licenseType as LicenseType,
          userId: session.userId,
        },
      });
      return reply.code(200).send({
        syncTimeoutSeconds: Math.floor(limits.syncTimeoutMs / 1000),
        backgroundMaxDurationMinutes: Math.floor(limits.backgroundMaxDurationMs / 60_000),
        maxConcurrentRunsPerTenant: limits.maxConcurrentRunsPerTenant,
        maxConcurrentRunsPerProject: limits.maxConcurrentRunsPerProject,
      });
    } catch (error) {
      return sendRouteError(reply, error, 'Agent execution limits error', 'Failed to read execution limits');
    }
  }));

  // Background runs of one agent, newest first (Sessions → Background runs).
  app.get('/agents/:agentId/runs', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const query = (request.query ?? {}) as { status?: string; limit?: string; conversationId?: string };
      const allowed = new Set(['queued', 'running', 'succeeded', 'failed', 'canceled']);
      const status = (query.status ?? '').split(',').filter((value) => allowed.has(value)) as Array<'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'>;
      const runs = await listAgentRuns(session.tenantDbName, {
        tenantId: session.tenantId,
        projectId,
        agentKey: agent.key,
        mode: 'background',
        ...(status.length > 0 ? { status } : {}),
        ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        limit: Math.min(Number(query.limit) || 100, 500),
      });
      return reply.code(200).send({ runs: runs.map(serializeAgentRun) });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent runs error', 'Failed to list runs');
    }
  }));

  app.post('/agents/:agentId/runs/:runId/cancel', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const { runId } = request.params as { runId: string };
      // Ownership first: the run must belong to THIS agent, not merely to the project.
      const existing = await getAgentRunStatus(session.tenantDbName, session.tenantId, projectId, runId);
      if (!existing || existing.agentKey !== agent.key || existing.mode !== 'background') {
        return reply.code(404).send({ error: 'Run not found' });
      }
      const outcome = await requestAgentRunCancellation(session.tenantDbName, session.tenantId, projectId, runId);
      if (outcome.kind === 'not_found') return reply.code(404).send({ error: 'Run not found' });
      if (outcome.kind === 'already_terminal') {
        return reply.code(409).send({ error: `Run is already ${outcome.run.status}` });
      }
      return reply.code(200).send({ run: serializeAgentRun(outcome.run) });
    } catch (error) {
      return sendRouteError(reply, error, 'Cancel agent run error', 'Failed to cancel run');
    }
  }));

  /**
   * Sends one tiny completion to a model through the agent runtime's own path,
   * so a wrong provider key is caught on the Configure page instead of in the
   * agent's first session. Always 200: the check's own verdict is the body.
   */
  app.post('/agents/model-check', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.modelKey !== 'string' || !body.modelKey) {
        return reply.code(400).send({ error: 'modelKey is required' });
      }
      const result = await checkAgentModel(session.tenantDbName, session.tenantId, projectId, body.modelKey);
      return reply.code(200).send(result);
    } catch (error) {
      return sendRouteError(reply, error, 'Agent model check error', 'Failed to check the model');
    }
  }));

  /**
   * Validates a config without saving it — the stored draft, or the `config`
   * in the body (what the editor currently holds). The Configure page calls
   * this to mark broken fields before Save.
   */
  app.post('/agents/:agentId/validate', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const body = readJsonBody<Record<string, unknown>>(request);
      const config = body.config && typeof body.config === 'object'
        ? body.config as IAgentConfig
        : agent.config;
      const validation = await validateAgentConfig({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        config,
        agentKey: agent.key,
      });
      return reply.code(200).send({ valid: validation.errors.length === 0, ...validation });
    } catch (error) {
      return sendRouteError(reply, error, 'Validate agent config error', 'Failed to validate agent config');
    }
  }));

  app.get('/agents/:agentId/conversations', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;

      const conversations = await listConversations(session.tenantDbName, agent.key, {
        limit: 50,
        projectId,
      });

      return reply.code(200).send({ conversations });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent conversations error', 'Failed to list conversations');
    }
  }));

  app.post('/agents/:agentId/conversations', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;

      const body = readJsonBody<Record<string, unknown>>(request);
      const conversation = await createConversation(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        agent.key,
        typeof body.title === 'string' ? body.title : undefined,
        { source: 'console' },
      );

      return reply.code(201).send({ conversation });
    } catch (error) {
      return sendRouteError(reply, error, 'Create agent conversation error', 'Failed to create conversation');
    }
  }));

  // ── Sessions ─────────────────────────────────────────────────────────
  //
  // A Session is the conversation record, presented under the name the
  // Sessions page uses. Kept as its own route group rather than renaming
  // `/conversations` above — nothing else in the codebase depends on that
  // name yet, but adding rather than renaming means neither guess can be
  // wrong about who else might.

  app.get('/agents/:agentId/sessions', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;

      const sessions = await listConversations(session.tenantDbName, agent.key, {
        limit: 100,
        projectId,
      });
      // Summarised here rather than shipped whole: every record carries its
      // full transcript, and a hundred of those is megabytes of tool payloads
      // sent so the list can render a row count. The session PAGE fetches the
      // one transcript it actually shows.
      return reply.code(200).send({ sessions: sessions.map(summariseConversation) });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent sessions error', 'Failed to list sessions');
    }
  }));

  app.post('/agents/:agentId/sessions', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;

      const body = readJsonBody<Record<string, unknown>>(request);

      // Session context is stamped with the dashboard user's identity the same
      // way a per-message one is — `userId`/`source` stay server-owned, so a
      // client cannot start a session that claims to be someone else.
      const sessionContext = body.context && typeof body.context === 'object'
        ? buildRuntimeContextFromRequest(body.context, request.headers, {
          userId: session.userId,
          source: 'playground',
        })
        : undefined;

      const created = await createConversation(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        agent.key,
        typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined,
        { source: 'console', ...(sessionContext ? { runtimeContext: sessionContext } : {}) },
      );
      return reply.code(201).send({ session: created });
    } catch (error) {
      return sendRouteError(reply, error, 'Create agent session error', 'Failed to create session');
    }
  }));

  app.get('/agents/:agentId/sessions/:sessionId', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const { sessionId } = request.params as { sessionId: string };

      const found = await getConversationById(session.tenantDbName, sessionId);
      // Scope check, not just existence — a session id valid for a sibling
      // agent (or project) in the same tenant must 404 here too.
      if (!found || found.agentKey !== agent.key || found.projectId !== projectId) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      return reply.code(200).send({ session: found });
    } catch (error) {
      return sendRouteError(reply, error, 'Get agent session error', 'Failed to load session');
    }
  }));

  app.delete('/agents/:agentId/sessions/:sessionId', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const { sessionId } = request.params as { sessionId: string };

      const found = await getConversationById(session.tenantDbName, sessionId);
      if (!found || found.agentKey !== agent.key || found.projectId !== projectId) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      await deleteConversation(session.tenantDbName, sessionId);
      return reply.code(200).send({ success: true });
    } catch (error) {
      return sendRouteError(reply, error, 'Delete agent session error', 'Failed to delete session');
    }
  }));

  /**
   * The same run as `/chat`, reported as it happens.
   *
   * A playground that says only "working…" for forty seconds is asking the
   * operator to trust it. Tool calls are the interesting part of an agent
   * run — which tool, with what argument, how long — and they are precisely
   * what a request/response POST cannot show until it is too late to matter.
   *
   * SSE over POST (rather than EventSource, which is GET-only) because the
   * body carries the message, the session and the runtime context. The final
   * `result` event repeats what `/chat` would have returned, so the client's
   * completed-turn rendering is identical either way — this endpoint adds
   * visibility, it does not fork the contract.
   *
   * `executePlaygroundChatLocal` is called directly, NOT the queue-routing
   * `executePlaygroundChat`: the progress callback is a function and cannot
   * cross the job queue. A run that would have been routed to another node
   * runs here instead, which is the right trade for a dashboard-only debug
   * surface and the reason this is not the path production traffic takes.
   */
  app.post('/agents/:agentId/chat/stream', withApiRequestContext(async (request, reply) => {
    const turn = await prepareDashboardTurn(request, reply);
    if (!turn) return reply;

    applyStreamHeaders(reply);
    reply.raw.flushHeaders?.();

    let closed = false;
    reply.raw.on('close', () => { closed = true; });
    const send = (event: string, data: unknown) => {
      if (closed) return;
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        closed = true;
      }
    };

    try {
      const result = await executePlaygroundChatLocal({
        ...turn.run,
        onToolEvent: (event) => send('tool', event),
        onTextChunk: (text) => send('text', { text }),
        // The agent summarized its context mid-run: shown in the transcript
        // as it happens, not only once the turn is over.
        onCompaction: (compaction) => send('summary', compaction),
      });

      send('result', result);
    } catch (error) {
      // The status line is long gone by now, so the error travels as an
      // event. A client that only listened for `result` would otherwise hang
      // until the socket closed and call it a network fault.
      if (error instanceof AgentGuardrailBlockedError) {
        logger.info('Agent playground stream blocked by guardrail', {
          guardrailKey: error.guardrailKey,
          hook: error.hook,
        });
        send('error', { error: error.message, type: 'guardrail_block' });
      } else {
        logger.error('Agent playground stream error', { error });
        const classified = classifyAgentRunError(error, { exposeInternal: true });
        send('error', { error: classified.error.message, type: classified.error.type, code: classified.error.code });
      }
    } finally {
      await turn.reservation?.release();
      if (!closed) reply.raw.end();
    }
    return reply;
  }));

  app.post('/agents/:agentId/chat', withApiRequestContext(async (request, reply) => {
    try {
      const turn = await prepareDashboardTurn(request, reply);
      if (!turn) return reply;
      const { body } = turn;

      let result: Awaited<ReturnType<typeof executePlaygroundChat>>;
      try {
        result = await executePlaygroundChat({
          ...turn.run,
          // Ignored server-side when conversationId is set (history loads from
          // the session instead) — still parsed so a stateless call (no
          // conversationId) keeps working exactly as before.
          history: Array.isArray(body.history)
            ? (body.history as Array<{ content?: unknown; role?: unknown } | null>).flatMap((item) => (
              typeof item?.content === 'string' && typeof item.role === 'string'
                ? [{ content: item.content, role: item.role }]
                : []
            ))
            : undefined,
        });
      } finally {
        await turn.reservation?.release();
      }

      return reply.code(200).send(result);
    } catch (error) {
      // A guardrail block is logged at info, not error: it is the configured
      // outcome, and an error-level line per refused prompt would page for
      // policy working as written.
      if (error instanceof AgentGuardrailBlockedError) {
        logger.info('Agent playground chat blocked by guardrail', {
          guardrailKey: error.guardrailKey,
          hook: error.hook,
        });
      } else {
        logger.error('Agent playground chat error', { error });
      }
      const classified = classifyAgentRunError(error, { exposeInternal: true });
      return sendAgentGuardrailBlock(reply, error)
        ?? sendProjectContextError(reply, error)
        ?? reply.code(classified.status).send({
          error: classified.error.message,
          type: classified.error.type,
          code: classified.error.code,
        });
    }
  }));
};
