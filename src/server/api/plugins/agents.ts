import { AgentDocumentParseError } from '@/lib/services/agents/import/document';
import {
  AgentImportError,
  applyAgentDocumentImport,
  previewAgentDocumentImport,
  type ApplyAgentDocumentImportInput,
} from '@/lib/services/agents/import/importService';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { resolveSandboxAvailability } from '@/lib/services/agents/agentSandboxTools';
import type { AgentStatus, IAgent, IAgentConfig, IAgentConversationActivityRow, IAgentRun, IAgentSessionBudget } from '@/lib/database';
import { consoleIdentityIssuerInfo } from '@/lib/iam/consoleIdentity';
import {
  createAgentRecord,
  createConversation,
  deleteAgentRecord,
  deleteConversation,
  executePlaygroundChat,
  getConversationById,
  getAgentVersion,
  listAgents,
  listAgentVersions,
  listConversations,
  updateAgentRecord,
} from '@/lib/services/agents';
import { cancelConversationTurn } from '@/lib/services/agents/turnCancellation';
import { watchTurnCancellation } from '@/lib/services/agents/turnWatch';
import { acquireAgentSessionSlot, type AgentSessionSlot } from '@/lib/services/agents/agentSessionLease';
import { isPlanLimitError, planLimitErrorBody, planLimitHeaders } from '@/lib/limits/errors';
// By path: the agents barrel does not export the error class.
import {
  AgentGuardrailBlockedError,
  checkAgentModel,
  executeAgentContinueLocal,
  // Imported BY PATH: the barrel exports the queue-routing wrapper, and the
  // streaming route deliberately needs the local one (a progress callback
  // cannot cross the job queue).
  executePlaygroundChatLocal,
} from '@/lib/services/agents/agentService';
import { parseSessionBudget } from '@/lib/services/agents/sessionBudget';
import { updateSessionBudget } from '@/lib/services/agents/sessionBudgetService';
import {
  validateAgentConfig,
  type AgentConfigIssue,
} from '@/lib/services/agents/agentConfigValidation';
import { classifyAgentRunError, logAgentRunFailure } from '@/lib/services/agents/agentErrors';
import { enforceAgentRunQuota, settleAgentRun, type AgentRunCaller } from '@/lib/services/agents/agentQuota';
import { createRunUsageSink, runWithUsageSink } from '@/lib/services/agents/runUsage';
import {
  AgentManifestError,
  manifestErrorStatus,
  applyAgentManifest,
  ConfigReferenceForbiddenError,
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
import { getDatabase } from '@/lib/database';
import {
  AGENT_RUN_TRIGGERS,
  getAgentRunStatus,
  listAgentRuns,
  requestAgentRunCancellation,
  resolveAgentRunLimits,
  runWithTenantDb,
  serializeAgentRun,
  withoutAgentRunContent,
} from '@/lib/services/agents/agentRunService';
import type { LicenseType } from '@/lib/license/license-manager';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import { sessionEventBus } from '@/lib/services/agents/sessionEvents';
import { readSessionPlan } from '@/lib/services/agents/sessionPlan';
import { DASHBOARD_AGENT_HITL_DEFAULTS } from '@/lib/services/agents/agentHumanInTheLoop';
import {
  resolveAgentPendingAction,
} from '@/lib/services/agents/agentActionResolution';
import {
  listConversationActions,
  listSessionEvents,
  streamSessionEvents,
  toPublicPendingAction,
} from './agent-session-events';
import {
  approvalAuthorizerFor,
  authorizeEndingOpenRequests,
  describeAnswerAbility,
  withAnswerAbility,
} from './agent-approval-authz';
import {
  advertisedModelsForRequest,
} from './agent-model-authz';
import {
  decideSessionAccess,
  loadSessionForPrincipal,
  sendAuthorizationUnavailable,
  sendSessionRefusal,
  sessionListScope,
  sessionStreamStillAllowed,
  runsWithHiddenContent,
  sessionsWithHiddenContent,
} from './agent-session-access';
import { resolveSessionOwners } from '@/lib/services/agents/sessionOwners';
import { decodeActivityCursor, listProjectSessions, SESSION_LIST_MAX_LIMIT } from '@/lib/services/agents/sessionList';
import { isRunInFlight, isSessionActive, isSessionOngoing } from '@/lib/services/agents/sessionActivityState';
import {
  activeRemindersBySession,
  cancelReminder,
  fireReminderNow,
  listReminders,
  reminderPlatformLimits,
  serializeReminder,
} from '@/lib/services/agents/agentReminders';
import {
  applyStreamHeaders,
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import { formatSseFrame, openLazySseStream } from '../sseWire';
import { BucketNamingForbiddenError } from '@/lib/services/agents/attachmentsBucketAccess';
import { OWNED_BY_FLOW_BODY } from './agent-owned-access';
import { isOwnedAgent } from '@/lib/utils/ownedAgents';
import { getFlowsHost } from '@/enterprise/flows';
import {
  applyConfigGuardrailBindings,
  bucketNamingForbiddenBody,
  connectedConfigForUpdate,
  prepareConnectedAgentIdentity,
  invalidAgentStatusBody,
  normalizeA2aUpdate,
  pickAgentUpdateFields,
  prepareNewAgentConfig,
  publishValidatedAgent,
  redactAgent,
  redactVersion,
  sendAgentGuardrailBlock,
  validateNativeConfigUpdate,
} from './agent-config-write';
import { requestCanNameBucket } from './files-permission';
import { configReadRequiredBody, requestHasConfigRead } from './config-permission';
import { requestHasSandboxRead, requestHasSandboxWrite } from './sandbox-permission';
import { sessionHasAgentsPermission } from './agents-permission';
import {
  FeedbackError,
  listAgentFeedback,
  listSessionFeedback,
  summarizeAgentFeedback,
  toFeedbackView,
} from '@/lib/services/agents/agentFeedback';
import {
  requireScopedAgent,
  requireScopedSession,
  logger, agentInProjectScope, AGENT_SCOPED, feedbackDays, parseFeedbackFilter, sendRouteError, openActionsOf, answerabilityOfRow, reserveDashboardSession, turnWatchFor, dashboardActor, resolveRefusal, SESSION_BUSY_BODY, readStatelessHistory, prepareDashboardTurn, openLazyEventStream, WAITING_ROWS_ANSWERABILITY_LIMIT, summariseConversation, RUN_CHANNEL_VALUES, type ActiveRunRow, activeRunsBySession, agentsOfSessions, sessionsOfTrigger, sessionTitles } from './agents/agentsRouteHelpers';
export { requireScopedAgent, requireScopedSession } from './agents/agentsRouteHelpers';

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
      const invalidStatus = invalidAgentStatusBody(body);
      if (invalidStatus) return reply.code(400).send(invalidStatus);

      if (typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'Agent name is required' });
      }

      const prepared = await prepareNewAgentConfig(body.config, {
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        user,
        canNameBucket: (bucketKey) => requestCanNameBucket(request, { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId }, bucketKey),
        canReferenceConfig: () => requestHasConfigRead(request, projectId),
        canUseSandbox: () => requestHasSandboxWrite(request, projectId),
      });
      if ('forbidden' in prepared) return reply.code(403).send(prepared.forbidden);
      if ('badRequest' in prepared) return reply.code(400).send(prepared.badRequest);

      // An agent created from the dashboard asks before its tools run unless the
      // form said otherwise. Stored explicitly so it shows (and can be changed)
      // in Configure → Approvals & questions. The client API's create route does
      // not do this: an API-created agent keeps running unattended.
      if (prepared.config.kind !== 'external' && prepared.config.kind !== 'flow' && prepared.config.humanInTheLoop === undefined) {
        prepared.config.humanInTheLoop = structuredClone(DASHBOARD_AGENT_HITL_DEFAULTS);
      }

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

  app.get('/agents/:agentId', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      // The models the playground may pick among (main + additional the caller may use).
      const models = await advertisedModelsForRequest(request, {
        agent: scoped.agent, tenantDbName: scoped.session.tenantDbName, projectId: scoped.projectId,
      }).catch(() => undefined);
      return reply.code(200).send({ agent: redactAgent(scoped.agent), ...(models ? { models } : {}) });
    } catch (error) {
      return sendRouteError(reply, error, 'Get agent error', 'Failed to get agent');
    }
  }));

  app.patch('/agents/:agentId', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent: existing, agentId, projectId, session, user } = scoped;
      const body = readJsonBody<Record<string, unknown>>(request);
      const invalidStatus = invalidAgentStatusBody(body);
      if (invalidStatus) return reply.code(400).send(invalidStatus);
      let warnings: AgentConfigIssue[] = [];
      if (isOwnedAgent(existing)) {
        // The owner never changes, and an owned agent stays a plain native agent that is not exposed anywhere.
        if (body.owner !== undefined) {
          return reply.code(400).send({ error: 'The owner of an agent cannot be changed', type: 'owner_immutable', code: 'owner_immutable' });
        }
        const config = body.config as Record<string, unknown> | undefined;
        if (config && typeof config === 'object' && config.kind !== undefined && config.kind !== 'native') {
          return reply.code(400).send({ error: 'An agent inside a flow must be a native agent', type: 'invalid_request', code: 'invalid_kind' });
        }
        const metadata = body.metadata as Record<string, unknown> | undefined;
        if (metadata && typeof metadata === 'object' && metadata.a2a !== undefined) {
          return reply.code(400).send({ error: 'An agent inside a flow cannot be exposed over A2A', type: 'invalid_request', code: 'a2a_not_allowed' });
        }
      }

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
          await prepareConnectedAgentIdentity(externalConfig, session.tenantDbName);
          body.config = externalConfig;
        } else if (existing.config?.kind === 'external') {
          // Guard: never let a native-shaped config silently clobber a stored
          // connected agent's connection (e.g. a stray playground auto-save).
          delete body.config;
        } else if (existing.config?.kind === 'flow' && cfg.kind !== 'flow') {
          // Same guard for a FlowBase agent: a native-shaped save must not drop its flow.
          delete body.config;
        } else {
          const checked = await validateNativeConfigUpdate(cfg, existing.key, {
            tenantDbName: session.tenantDbName,
            tenantId: session.tenantId,
            projectId,
            user,
            canNameBucket: (bucketKey) => requestCanNameBucket(request, { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId }, bucketKey),
            canReferenceConfig: () => requestHasConfigRead(request, projectId),
            canUseSandbox: () => requestHasSandboxWrite(request, projectId),
          }, existing.config);
          if ('forbidden' in checked) return reply.code(403).send(checked.forbidden);
          if ('conflict' in checked) return reply.code(409).send(checked.conflict);
          if ('badRequest' in checked) return reply.code(400).send(checked.badRequest);
          warnings = checked.warnings;
        }
      }

      normalizeA2aUpdate(body, existing);

      const agent = await updateAgentRecord(session.tenantDbName, agentId, pickAgentUpdateFields(body), session.userId);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ agent: redactAgent(agent), warnings });
    } catch (error) {
      return sendRouteError(reply, error, 'Update agent error', 'Failed to update agent');
    }
  }));

  app.delete('/agents/:agentId', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      // An owned agent is deleted only with its flow.
      const scoped = await requireScopedAgent(request, reply, { owned: 'refuse' });
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

  app.get('/agents/:agentId/versions', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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

  app.get('/agents/:agentId/export', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply, { owned: 'refuse' });
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
          // Importing is a config write like any other: naming a bucket takes the right to name it.
          canNameBucket: (bucketKey) => requestCanNameBucket(request, { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId }, bucketKey),
          canReferenceConfig: () => requestHasConfigRead(request, projectId),
        },
      );

      return reply.code(result.action === 'created' ? 201 : 200).send({
        agent: redactAgent(result.agent),
        action: result.action,
        missing: result.missing,
        warnings: result.warnings,
      });
    } catch (error) {
      if (error instanceof ConfigReferenceForbiddenError) {
        return reply.code(403).send(configReadRequiredBody(error.field));
      }
      if (error instanceof BucketNamingForbiddenError) {
        return reply.code(403).send(bucketNamingForbiddenBody(error));
      }
      if (error instanceof AgentManifestError) {
        return reply.code(manifestErrorStatus(error)).send({
          error: error.message,
          issues: error.issues,
          ...(error.code ? { type: error.code, code: error.code } : {}),
        });
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
    if (error instanceof BucketNamingForbiddenError) return reply.code(403).send(bucketNamingForbiddenBody(error));
    if (error instanceof ConfigReferenceForbiddenError) return reply.code(403).send(configReadRequiredBody(error.field));
    if (error instanceof AgentImportError) {
      return reply.code(error.status).send({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    if (error instanceof AgentManifestError) return reply.code(manifestErrorStatus(error)).send({ error: error.message, issues: error.issues, ...(error.code ? { type: error.code, code: error.code } : {}) });
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
        {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId,
          userId: String(user._id),
          canNameBucket: (bucketKey) => requestCanNameBucket(request, { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId }, bucketKey),
          canReferenceConfig: () => requestHasConfigRead(request, projectId),
        },
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

  // ── Code export ────────────────────────────────────────────────────────

  app.post('/agents/:agentId/codegen', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
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

      const agent = await agentInProjectScope(session.tenantDbName, agentId, projectId);
      if (!agent) return reply.code(404).send({ error: 'Agent not found' });
      if (agent.owner) return reply.code(409).send(OWNED_BY_FLOW_BODY);

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
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const scoped = await agentInProjectScope(session.tenantDbName, agentId, projectId);
      if (!scoped) {
        // Same failure an unknown id already raises inside publishAgent, so the
        // route cannot confirm that another project's agent exists.
        throw new Error(`Agent "${agentId}" not found`);
      }
      // An owned agent is published with its flow (flowService.publishFlow), never on its own.
      if (scoped.owner) return reply.code(409).send(OWNED_BY_FLOW_BODY);
      const published = await publishValidatedAgent(
        request,
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        scoped,
        agentId,
        session.userId,
      );
      if ('badRequest' in published) return reply.code(400).send(published.badRequest);
      return reply.code(201).send({ version: redactVersion(published.version) });
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
   * has the sandbox module, whether the tenant's license unlocks it, the
   * templates to pick from, and the project's persistent sandboxes an agent
   * can be given (`instances`, listed only to a caller with Sandbox read;
   * `canAttach` says whether the caller may choose one). Always 200 —
   * `available: false` with a `reason` is an answer the UI renders, not a
   * failure.
   */
  app.get('/agents/sandbox/capabilities', withApiRequestContext(async (request, reply) => {
    try {
      const { session, projectId } = await requireProjectContextForRequest(request);
      const availability = await resolveSandboxAvailability(session.tenantId);
      if (!availability.available) {
        return reply.code(200).send({ available: false, reason: availability.reason, templates: [], instances: [], canAttach: false });
      }
      const { runner } = availability;
      const templates = await runner.listTemplates(session.tenantDbName, session.tenantId)
        .catch((error: unknown) => {
          logger.warn('Could not list sandbox templates', { error });
          return [];
        });
      const attachSupported = Boolean(runner.listInstances && runner.describeInstance);
      const instances = attachSupported && await requestHasSandboxRead(request, projectId)
        ? await runner.listInstances!(session.tenantDbName, session.tenantId, projectId, { persist: true })
          .catch((error: unknown) => {
            logger.warn('Could not list persistent sandboxes', { error });
            return [];
          })
        : [];
      const canAttach = attachSupported && await requestHasSandboxWrite(request, projectId);
      return reply.code(200).send({
        available: true,
        templates,
        instances: instances.map(({ id, name, state, templateKey }) => ({ id, name, state, ...(templateKey ? { templateKey } : {}) })),
        canAttach,
      });
    } catch (error) {
      return sendRouteError(reply, error, 'Agent sandbox capabilities error', 'Failed to read sandbox capabilities');
    }
  }));

  // What a connected agent set up for Console identity verifies its tokens
  // against (shown on the connect and settings screens).
  app.get('/agents/console-identity', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      return reply.code(200).send(consoleIdentityIssuerInfo(session.tenantId));
    } catch (error) {
      return sendRouteError(reply, error, 'Agent Console identity error', 'Failed to read Console identity details');
    }
  }));

  // Effective run limits for this tenant/project (env ∧ quota). Agents have no
  // say in them any more; the Studio shows them for reference.
  app.get('/agents/execution/limits', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const limits = await resolveAgentRunLimits({
        quotaContext: {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId,
          licenseType: session.licenseType as LicenseType,
          userId: session.userId,
        },
      });
      return reply.code(200).send({
        syncWaitSeconds: Math.floor(limits.syncWaitMs / 1000),
        maxDurationMinutes: Math.floor(limits.maxDurationMs / 60_000),
        maxActivePerTenant: limits.maxActivePerTenant,
        maxActivePerProject: limits.maxActivePerProject,
      });
    } catch (error) {
      return sendRouteError(reply, error, 'Agent execution limits error', 'Failed to read execution limits');
    }
  }));

  // Background runs of one agent, newest first (Sessions → Background runs).
  app.get('/agents/:agentId/runs', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const query = (request.query ?? {}) as { status?: string; limit?: string; conversationId?: string; triggerId?: string; trigger?: string; channel?: string };
      const trigger = AGENT_RUN_TRIGGERS.find((value) => value === query.trigger);
      const channels = (query.channel ?? '').split(',').filter((value): value is NonNullable<IAgentRun['channel']> => (RUN_CHANNEL_VALUES as readonly string[]).includes(value));
      const allowed = new Set(['scheduled', 'queued', 'running', 'requires_action', 'succeeded', 'failed', 'canceled']);
      const status = (query.status ?? '').split(',').filter((value) => allowed.has(value)) as Array<'scheduled' | 'queued' | 'running' | 'requires_action' | 'succeeded' | 'failed' | 'canceled'>;
      // A run carries the answer of somebody's session: the caller who may not view other people's sessions of
      // this agent sees only the runs they queued, and a run of one session is the session's to read.
      const scope = await sessionListScope(request, { agent, projectId, actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId } });
      if (query.conversationId) {
        const loaded = await loadSessionForPrincipal(request, query.conversationId, {
          need: 'view',
          agentKey: agent.key,
          agent,
          projectId,
          actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
        });
        if (!loaded.ok) return sendSessionRefusal(reply, request, loaded);
      }
      const runs = await listAgentRuns(session.tenantDbName, {
        tenantId: session.tenantId,
        projectId,
        agentKey: agent.key,
        // Every run (queued or inline); a dashboard reservation is not one.
        excludeModes: ['sync'],
        ...(status.length > 0 ? { status } : {}),
        ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        // A trigger's history (Studio's Triggers list links here).
        ...(query.triggerId ? { triggerId: query.triggerId } : {}),
        ...(trigger ? { trigger } : {}),
        ...(channels.length === 1 ? { channel: channels[0] } : {}),
        ...(scope.ownOnly ? { userId: scope.userId } : {}),
        limit: Math.min(Number(query.limit) || 100, 500),
      });
      const shown = channels.length > 1 ? runs.filter((run) => run.channel && channels.includes(run.channel)) : runs;
      const hidden = await runsWithHiddenContent(request, { tenantDbName: session.tenantDbName, userId: session.userId }, shown);
      return reply.code(200).send({
        runs: shown.map((run) => (hidden.has(String(run._id)) ? withoutAgentRunContent(serializeAgentRun(run)) : serializeAgentRun(run))),
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent runs error', 'Failed to list runs');
    }
  }));

  app.post('/agents/:agentId/runs/:runId/cancel', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const { runId } = request.params as { runId: string };
      // Ownership first: the run must belong to THIS agent, not merely to the project.
      const existing = await getAgentRunStatus(session.tenantDbName, session.tenantId, projectId, runId);
      if (!existing || existing.agentKey !== agent.key || existing.mode === 'sync') {
        return reply.code(404).send({ error: 'Run not found' });
      }
      // Cancelling a run is acting on its session: the session's owner always may, anybody else needs
      // `agent.session_manage_others`.
      const conversation = await getConversationById(session.tenantDbName, existing.conversationId);
      if (conversation && conversation.projectId === projectId) {
        const access = await decideSessionAccess(request, conversation, {
          need: 'manage',
          agent,
          actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
          alsoOwnedBy: [existing.userId],
        });
        if (!access.ok) return sendSessionRefusal(reply, request, access);
      }
      // A run paused on an approval is ended by cancelling it, which answers the open request with "no".
      if (existing.status === 'requires_action') {
        if (conversation && conversation.projectId === projectId) {
          const verdict = await authorizeEndingOpenRequests(request, { tenantDbName: session.tenantDbName, conversation, agent });
          if (!verdict.allowed && verdict.unavailable) {
            return sendAuthorizationUnavailable(reply, request, 'dashboard', { action: 'agent.approve', level: 'write', decisionId: verdict.decisionId });
          }
          if (!verdict.allowed) {
            return reply.code(403).send({
              error: 'This run is waiting for an approval or an answer. You are not allowed to answer it, so you cannot cancel it.',
              code: 'forbidden',
              ...(verdict.decisionId ? { decisionId: verdict.decisionId } : {}),
            });
          }
        }
      }
      if (existing.channel === 'reminder' && existing.status === 'scheduled') {
        const canceled = await cancelReminder(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
          runId,
          { agentKey: agent.key, actor: { userId: session.userId, via: 'dashboard' } },
        );
        if (canceled.kind === 'canceled') return reply.code(200).send({ run: serializeAgentRun(canceled.run) });
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

  // A reminder that has not fired yet, started now (Sessions → Reminders "Fire now").
  app.post('/agents/:agentId/runs/:runId/fire', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const { runId } = request.params as { runId: string };
      const existing = await getAgentRunStatus(session.tenantDbName, session.tenantId, projectId, runId);
      if (!existing || existing.agentKey !== agent.key || existing.channel !== 'reminder') {
        return reply.code(404).send({ error: 'Reminder not found' });
      }
      // Firing a reminder runs a turn in its session: the session's owner always may, anybody else needs
      // `agent.session_manage_others`.
      const conversation = await getConversationById(session.tenantDbName, existing.conversationId);
      if (!conversation || conversation.projectId !== projectId) return reply.code(404).send({ error: 'Reminder not found' });
      const access = await decideSessionAccess(request, conversation, {
        need: 'manage',
        agent,
        actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
        alsoOwnedBy: [existing.userId],
      });
      if (!access.ok) return sendSessionRefusal(reply, request, access);
      const outcome = await fireReminderNow(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        runId,
        { agentKey: agent.key, actor: { userId: session.userId, via: 'dashboard' } },
      );
      if (outcome.kind === 'not_found') return reply.code(404).send({ error: 'Reminder not found' });
      if (outcome.kind === 'not_scheduled') return reply.code(409).send({ error: `The reminder is already ${outcome.run.status}` });
      if (outcome.kind === 'busy') return reply.code(409).send({ error: outcome.message });
      return reply.code(200).send({ run: serializeAgentRun(outcome.run), reminder: serializeReminder(outcome.run) });
    } catch (error) {
      return sendRouteError(reply, error, 'Fire agent reminder error', 'Failed to fire the reminder');
    }
  }));

  // The reminders the agent set itself, newest first (Sessions → Reminders; a session's own with `sessionId`).
  app.get('/agents/:agentId/reminders', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const query = (request.query ?? {}) as { status?: string; limit?: string; sessionId?: string };
      const actor = { tenantDbName: session.tenantDbName, projectId, userId: session.userId };
      const reminderScope = { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId };
      const scope = await sessionListScope(request, { agent, projectId, actor });
      if (query.sessionId) {
        const loaded = await loadSessionForPrincipal(request, query.sessionId, { need: 'view', agentKey: agent.key, agent, projectId, actor });
        if (!loaded.ok) return sendSessionRefusal(reply, request, loaded);
      }
      // Somebody who may not view other people's sessions sees the reminders of their own (one session they may view: all of it).
      const ownOnly = !query.sessionId && scope.ownOnly ? { userId: scope.userId } : {};
      const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
      const [runs, active] = await Promise.all([
        listReminders(reminderScope, {
          agentKey: agent.key,
          ...(query.sessionId ? { conversationId: query.sessionId } : {}),
          active: query.status !== 'all',
          ...ownOnly,
          limit,
        }),
        listReminders(reminderScope, { agentKey: agent.key, ...(query.sessionId ? { conversationId: query.sessionId } : {}), active: true, ...ownOnly, limit: 500 }),
      ]);
      const owners = await resolveSessionOwners(runs.map((run) => run.userId));
      const titles = await sessionTitles(session.tenantDbName, projectId, runs.map((run) => run.conversationId));
      // A reminder of a session that drew on knowledge base documents the viewer may not read: when and whose, not what.
      const hidden = await runsWithHiddenContent(request, actor, runs);
      return reply.code(200).send({
        reminders: runs.map((run) => {
          const owner = run.userId ? owners.get(run.userId) : undefined;
          const reminder = serializeReminder(run);
          if (hidden.has(String(run._id))) {
            return {
              ...reminder,
              message: null,
              reason: null,
              error: reminder.error ? { type: reminder.error.type, message: null } : null,
              restricted: true,
              ...(owner ? { owner } : {}),
            };
          }
          const title = titles.get(run.conversationId);
          return { ...reminder, ...(owner ? { owner } : {}), ...(title ? { session_title: title } : {}) };
        }),
        summary: { active: active.length },
        scope: { viewOthers: !scope.ownOnly },
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent reminders error', 'Failed to list reminders');
    }
  }));

  // The platform ceilings of agent reminders (env), for the Configure hints.
  app.get('/agents/reminder-limits', withApiRequestContext(async (request, reply) => {
    try {
      await requireProjectContextForRequest(request);
      return reply.code(200).send({ limits: reminderPlatformLimits() });
    } catch (error) {
      return sendRouteError(reply, error, 'Agent reminder limits error', 'Failed to read reminder limits');
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
  app.post('/agents/:agentId/validate', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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

  // ── Sessions ─────────────────────────────────────────────────────────
  //
  // A Session is the conversation record, presented under the name the
  // Sessions page uses.

  // Every agent's sessions of the project in one list (Agents → Sessions): `view=active` holds the ones in
  // progress or waiting on someone (running ones first; `hasMore` without a cursor says some were left out),
  // `view=all` pages through everything by last activity. Static, so it wins over `/agents/:agentId`.
  app.get('/agents/sessions', withApiRequestContext(async (request, reply) => {
    try {
      const query = (request.query ?? {}) as { view?: unknown; limit?: unknown; cursor?: unknown };
      const view = query.view ?? 'all';
      if (view !== 'active' && view !== 'all') return reply.code(400).send({ error: 'view must be "active" or "all"' });
      const limit = query.limit === undefined ? 50 : typeof query.limit === 'string' && /^\d+$/.test(query.limit) ? Number(query.limit) : 0;
      if (limit < 1 || limit > SESSION_LIST_MAX_LIMIT) {
        return reply.code(400).send({ error: `limit must be an integer between 1 and ${SESSION_LIST_MAX_LIMIT}` });
      }
      // The Active list is not paged, so it has no cursor to follow.
      let before: { updatedAt: Date; id: string } | undefined;
      if (view === 'all' && query.cursor !== undefined && query.cursor !== '') {
        const decoded = typeof query.cursor === 'string' ? decodeActivityCursor(query.cursor) : null;
        if (!decoded) return reply.code(400).send({ error: 'cursor is not valid' });
        before = decoded;
      }

      const { projectId, session } = await requireProjectContextForRequest(request);
      const actor = { tenantDbName: session.tenantDbName, projectId, userId: session.userId };
      // Without an agent: the viewer's scope across the project's agents (their own sessions, plus every
      // session of the agents they may view), applied in the database before the page is cut.
      const scope = await sessionListScope(request, { projectId, actor });

      const reminderScope = { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId };
      // What each row is waiting on or running, best effort: the list itself never fails over it.
      const decoration = <T,>(what: string) => (error: unknown): Map<string, T> => {
        logger.warn(`Project sessions list: ${what} not shown`, { error: error instanceof Error ? error.message : String(error) });
        return new Map();
      };
      const [activeRuns, reminders] = await Promise.all([
        activeRunsBySession(session.tenantDbName, { tenantId: session.tenantId, projectId })
          .catch(decoration<ActiveRunRow>('active runs')),
        activeRemindersBySession(reminderScope)
          .catch(decoration<{ active: number; nextAt: Date }>('reminders')),
      ]);

      // Sessions with a run queued or running: their "running" status is not questioned (no stale-run lookup per row).
      const knownInFlight = new Set([...activeRuns].filter(([, run]) => isRunInFlight(run)).map(([id]) => id));

      let rows: IAgentConversationActivityRow[];
      let hasMore = false;
      let nextCursor: string | undefined;
      if (view === 'all') {
        ({ sessions: rows, hasMore, nextCursor } = await listProjectSessions(session.tenantDbName, { projectId, ownOnly: scope.ownOnly, limit, before, knownInFlight }));
      } else {
        // Running sessions and waiting ones are asked apart, so a crowd of waiting sessions (a status flip does not
        // bump `updatedAt`) cannot push a running one out of its query; plus the sessions with a run queued or
        // running that has not marked its session yet. A session whose turn died is read as idle and falls out below.
        const common = { projectId, ownOnly: scope.ownOnly, limit: SESSION_LIST_MAX_LIMIT, knownInFlight };
        const [running, waiting] = await Promise.all([
          listProjectSessions(session.tenantDbName, { ...common, runtimeStatuses: ['running'] }),
          listProjectSessions(session.tenantDbName, { ...common, runtimeStatuses: ['requires_action', 'budget_paused'] }),
        ]);
        const listed = new Set([...running.sessions, ...waiting.sessions].map((entry) => String(entry._id)));
        const unlisted = [...knownInFlight].filter((id) => !listed.has(id));
        const byRun = unlisted.length > 0
          ? await listProjectSessions(session.tenantDbName, { ...common, ids: unlisted.slice(0, SESSION_LIST_MAX_LIMIT) })
          : { sessions: [], hasMore: false };
        const stamp = (entry: IAgentConversationActivityRow) => new Date(entry.updatedAt ?? 0).getTime();
        const newestFirst = (a: IAgentConversationActivityRow, b: IAgentConversationActivityRow) => stamp(b) - stamp(a) || (String(a._id) < String(b._id) ? 1 : -1);
        const seen = new Set<string>();
        const active = [...running.sessions, ...byRun.sessions, ...waiting.sessions].filter((entry) => {
          const id = String(entry._id);
          if (seen.has(id)) return false;
          seen.add(id);
          return isSessionActive({ runtimeStatus: entry.runtimeStatus, activeRun: activeRuns.get(id) });
        });
        const isOngoing = (entry: IAgentConversationActivityRow) => isSessionOngoing({ runtimeStatus: entry.runtimeStatus, activeRun: activeRuns.get(String(entry._id)) });
        // Ongoing sessions are kept before waiting ones when the cap cuts, then everything is shown newest first.
        const ranked = [...active.filter(isOngoing).sort(newestFirst), ...active.filter((entry) => !isOngoing(entry)).sort(newestFirst)];
        rows = ranked.slice(0, SESSION_LIST_MAX_LIMIT).sort(newestFirst);
        // No cursor: the Active list is not paged, but it says when sessions were left out.
        hasMore = running.hasMore || waiting.hasMore || byRun.hasMore || unlisted.length > SESSION_LIST_MAX_LIMIT || ranked.length > SESSION_LIST_MAX_LIMIT;
      }

      const agents = await agentsOfSessions(session.tenantDbName, projectId, rows);
      rows = rows.filter((entry) => agents.has(entry.agentKey));
      const owners = await resolveSessionOwners(rows.map((entry) => entry.createdBy));
      const hidden = await sessionsWithHiddenContent(request, actor, rows);
      // The "waiting for you" state is per viewer: asked of the engine for the sessions that wait, not guessed.
      const waiting = rows.filter((entry) => entry.runtimeStatus === 'requires_action').slice(0, WAITING_ROWS_ANSWERABILITY_LIMIT);
      const answerable = new Map<string, Awaited<ReturnType<typeof answerabilityOfRow>>>();
      for (const entry of waiting) {
        answerable.set(String(entry._id), await answerabilityOfRow(request, session.tenantDbName, agents.get(entry.agentKey)!, entry, actor));
      }
      return reply.code(200).send({
        sessions: rows.map((entry) => {
          const id = String(entry._id);
          const agent = agents.get(entry.agentKey)!;
          const run = activeRuns.get(id);
          const due = reminders.get(id);
          return {
            ...summariseConversation(entry, owners.get(entry.createdBy), answerable.get(id), session.userId, hidden.has(id)),
            agentId: String(agent._id),
            agentKey: agent.key,
            agentName: agent.name,
            ...(run ? { activeRun: run } : {}),
            ...(due ? { reminders: { active: due.active, nextAt: due.nextAt.toISOString() } } : {}),
          };
        }),
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
        // Everybody's sessions or only the caller's own; `partial` = their own plus those of the agents they may view.
        scope: {
          viewOthers: !scope.ownOnly,
          ...(scope.ownOnly && (scope.ownOnly.viewableAgentKeys?.length ?? 0) > 0 ? { partial: true } : {}),
        },
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List project sessions error', 'Failed to list sessions');
    }
  }));

  app.get('/agents/:agentId/sessions', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;

      // Somebody who may not view other people's sessions of this agent lists only their own - cut in the
      // database, before the page, so a busy teammate cannot push theirs off it (one decision per request).
      const scope = await sessionListScope(request, { agent, projectId, actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId } });
      const { triggerId } = (request.query ?? {}) as { triggerId?: string };
      const sessions = triggerId
        ? await sessionsOfTrigger(session.tenantDbName, { tenantId: session.tenantId, projectId, agentKey: agent.key, triggerId, ...(scope.ownOnly ? { createdBy: scope.userId } : {}) })
        : await listConversations(session.tenantDbName, agent.key, {
          limit: 100,
          projectId,
          ...(scope.ownOnly ? { createdBy: scope.userId } : {}),
        });
      const reminderScope = { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId };
      // What each row is waiting on or running, best effort: the list itself never fails over it.
      const decoration = <T,>(what: string) => (error: unknown): Map<string, T> => {
        logger.warn(`Sessions list: ${what} not shown`, { agentKey: agent.key, error: error instanceof Error ? error.message : String(error) });
        return new Map();
      };
      const [activeRuns, reminders] = await Promise.all([
        activeRunsBySession(session.tenantDbName, { tenantId: session.tenantId, projectId, agentKey: agent.key })
          .catch(decoration<ActiveRunRow>('active runs')),
        activeRemindersBySession(reminderScope, agent.key)
          .catch(decoration<{ active: number; nextAt: Date }>('reminders')),
      ]);
      const owners = await resolveSessionOwners(sessions.map((entry) => entry.createdBy));
      const hidden = await sessionsWithHiddenContent(request, { tenantDbName: session.tenantDbName, userId: session.userId }, sessions);
      // The "waiting for you" state is per viewer: asked of the engine for the sessions that wait, not guessed.
      const waiting = sessions.filter((entry) => entry.runtimeStatus === 'requires_action').slice(0, WAITING_ROWS_ANSWERABILITY_LIMIT);
      const answerable = new Map<string, Awaited<ReturnType<typeof answerabilityOfRow>>>();
      for (const entry of waiting) {
        answerable.set(String(entry._id), await answerabilityOfRow(request, session.tenantDbName, agent, entry, { tenantDbName: session.tenantDbName, projectId, userId: session.userId }));
      }
      // Summarised here rather than shipped whole: every record carries its
      // full transcript, and a hundred of those is megabytes of tool payloads
      // sent so the list can render a row count. The session PAGE fetches the
      // one transcript it actually shows.
      return reply.code(200).send({
        sessions: sessions.map((entry) => {
          const id = String(entry._id);
          const run = activeRuns.get(id);
          const due = reminders.get(id);
          return {
            ...summariseConversation(entry, owners.get(entry.createdBy), answerable.get(id), session.userId, hidden.has(id)),
            ...(run ? { activeRun: run } : {}),
            ...(due ? { reminders: { active: due.active, nextAt: due.nextAt.toISOString() } } : {}),
          };
        }),
        // Whether this is everybody's sessions of the agent or only the caller's own.
        scope: { viewOthers: !scope.ownOnly },
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent sessions error', 'Failed to list sessions');
    }
  }));

  app.post('/agents/:agentId/sessions', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
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

      // Optional spend budget for this session (`null` = none); absent = the agent's default.
      let budget: IAgentSessionBudget | null | undefined;
      if (body.budget === null) budget = null;
      else if (body.budget !== undefined) {
        const parsed = parseSessionBudget(body.budget);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.message });
        budget = parsed.budget;
      }

      const created = await createConversation(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        agent.key,
        typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined,
        { source: 'console', ...(sessionContext ? { runtimeContext: sessionContext } : {}) },
        budget,
      );
      return reply.code(201).send({ session: created });
    } catch (error) {
      return sendRouteError(reply, error, 'Create agent session error', 'Failed to create session');
    }
  }));

  app.get('/agents/:agentId/sessions/:sessionId', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      // Scope check, not just existence - a session id valid for a sibling agent (or project) in the same
      // tenant must 404 here too - and the caller's right to read what somebody else started.
      const scoped = await requireScopedSession(request, reply, { need: 'view' });
      if (!scoped) return reply;
      const { agent, session } = scoped;
      const found = scoped.conversation;

      // Whose it is, and which of its open requests THIS caller could answer (the page shows the server's
      // verdict instead of deriving one from the agent's setting and the viewer's role).
      const [owners, actions, plan] = await Promise.all([
        resolveSessionOwners([found.createdBy]),
        openActionsOf(session.tenantDbName, String(found._id)),
        // Where the agent's plan stands now (the newest version its turns recorded, else the carried state); null when it has none.
        runWithTenantDb(session.tenantDbName, (db) => readSessionPlan(db, found, agent.config)).catch(() => null),
      ]);
      const ability = await describeAnswerAbility(request, { tenantDbName: session.tenantDbName, conversation: found, actions, agent, actor: { tenantDbName: session.tenantDbName, projectId: scoped.projectId, userId: session.userId } });
      return reply.code(200).send({
        session: found,
        plan,
        owner: owners.get(found.createdBy) ?? null,
        // The caller started it: nothing more than the route's own check was needed.
        ownSession: scoped.owner,
        pendingActions: withAnswerAbility(actions.map(toPublicPendingAction), ability),
      });
    } catch (error) {
      return sendRouteError(reply, error, 'Get agent session error', 'Failed to load session');
    }
  }));

  // ── Session spend budget ──
  //
  // `{ budget: { maxCostUsd, onReach } | null }` adds, changes or removes the
  // session's budget. A paused session is continued with `…/continue` (Studio
  // calls this, then that).
  app.patch('/agents/:agentId/sessions/:sessionId', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'manage' });
      if (!scoped) return reply;
      const body = readJsonBody<Record<string, unknown>>(request);
      if (body.budget === undefined) {
        return reply.code(400).send({ error: 'budget is required: { maxCostUsd, onReach }, or null to remove it' });
      }
      const outcome = await updateSessionBudget({
        tenantDbName: scoped.session.tenantDbName,
        projectId: scoped.projectId,
        conversationId: String(scoped.conversation._id),
        budget: body.budget,
      });
      if (outcome.kind === 'not_found') return reply.code(404).send({ error: 'Session not found' });
      if (outcome.kind === 'invalid') return reply.code(400).send({ error: outcome.message });
      // `continuable`: the session was waiting on its budget with a turn left to carry on, so
      // `…/continue` now makes sense. False for a budget that stops (raise it and send a message),
      // for a session whose turn already ended with its answer, and for one that was not stopped.
      return reply.code(200).send({ session: outcome.conversation, continuable: outcome.wasBudgetPaused });
    } catch (error) {
      return sendRouteError(reply, error, 'Update session budget error', 'Failed to update the session budget');
    }
  }));

  /**
   * Stop: ends the session's running turn (what it had streamed is kept as the
   * answer, `cancelled`) and cancels the approvals/questions of a paused one.
   * Works for a turn started from anywhere — the playground, the API, a portal
   * — and on any node. Nothing to stop is a 200 with `cancelled: false`.
   */
  app.post('/agents/:agentId/sessions/:sessionId/cancel', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'manage' });
      if (!scoped) return reply;
      // Ending an open approval is answering it "no": without that right the turn still stops, the approval stays.
      const verdict = await authorizeEndingOpenRequests(request, {
        tenantDbName: scoped.session.tenantDbName,
        conversation: scoped.conversation,
        agent: scoped.agent,
      });
      if (!verdict.allowed && verdict.unavailable) {
        return sendAuthorizationUnavailable(reply, request, 'dashboard', { action: 'agent.approve', level: 'write', decisionId: verdict.decisionId });
      }
      const outcome = await cancelConversationTurn({
        tenantDbName: scoped.session.tenantDbName,
        tenantId: scoped.session.tenantId,
        projectId: scoped.projectId,
        conversationId: String(scoped.conversation._id),
        agentKey: scoped.agent.key,
        requestedBy: scoped.session.userId,
        cancelActions: verdict.allowed,
      });
      return reply.code(200).send(outcome);
    } catch (error) {
      return sendRouteError(reply, error, 'Cancel session turn error', 'Failed to stop the turn');
    }
  }));

  /**
   * Continue a session that stopped on its spend budget (after the budget was
   * raised): the agent carries on from where it stopped, with no new user
   * message. Without `?stream=1` the call returns when the turn has finished
   * (JSON); with it, the turn is an SSE stream in the same event format as
   * `/chat/stream`. A refusal (402, 409, 404) is a normal JSON response either
   * way: the stream only opens once there is a turn to report.
   */
  app.post('/agents/:agentId/sessions/:sessionId/continue', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    let scoped: Awaited<ReturnType<typeof requireScopedSession>>;
    try {
      // A turn in the session: its owner always may; anybody else must be allowed to change AND to view it.
      scoped = await requireScopedSession(request, reply, { need: 'continue' });
    } catch (error) {
      return sendRouteError(reply, error, 'Continue session error', 'Failed to continue the session');
    }
    if (!scoped) return reply;
    const conversationId = String(scoped.conversation._id);
    const source = scoped.conversation.metadata?.source;
    if (typeof source === 'string' && source !== 'console') {
      return reply.code(409).send({ error: `This session came in via ${source} and is read-only. Start a new session to test the agent.` });
    }
    const query = (request.query ?? {}) as Record<string, unknown>;
    const wantsStream = query.stream === '1' || query.stream === 'true';
    const body = readJsonBody<Record<string, unknown>>(request);

    const reservation = await reserveDashboardSession({
      session: scoped.session,
      projectId: scoped.projectId,
      agentKey: scoped.agent.key,
      conversationId,
      userMessage: '',
    });
    if (reservation === null) return reply.code(409).send(SESSION_BUSY_BODY);

    const stream = openLazyEventStream(reply, wantsStream);
    const unsubscribe = wantsStream
      ? sessionEventBus.subscribe(conversationId, (frame) => {
        if (frame.type === 'action.required') stream.send('action', frame.data, frame.seq);
        else if (frame.type.startsWith('session.status_')) stream.send('status', { type: frame.type, ...frame.data }, frame.seq);
      })
      : undefined;

    const watch = reservation
      ? watchTurnCancellation({
        tenantDbName: scoped.session.tenantDbName,
        tenantId: scoped.session.tenantId,
        projectId: scoped.projectId,
        conversationId,
        runId: String(reservation.run._id),
      })
      : undefined;

    // Plan limit (agent sessions): a continued dashboard turn is console-originated and takes a slot like a new one.
    let slot: AgentSessionSlot | undefined;
    try {
      slot = await acquireAgentSessionSlot({
        tenantId: scoped.session.tenantId,
        holderId: reservation ? String(reservation.run._id) : undefined,
        origin: 'console',
        signal: watch?.signal,
        onQueued: stream.live('run.queued', (info) => info),
        onStarted: () => stream.send('run.started', {}),
      });
      const continued = await executeAgentContinueLocal({
        ...(watch ? { signal: watch.signal } : {}),
        tenantDbName: scoped.session.tenantDbName,
        tenantId: scoped.session.tenantId,
        projectId: scoped.projectId,
        agentKey: scoped.agent.key,
        conversationId,
        userId: scoped.session.userId,
        runtimeContext: buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
          userId: scoped.session.userId,
          source: 'playground',
        }),
        continuation: {
          source: 'agent-playground',
          ...(typeof body.version === 'number' ? { version: body.version } : {}),
        },
        ...(wantsStream
          ? {
            onToolEvent: stream.live('tool', (event) => event),
            onTextChunk: stream.live('text', (text: string) => ({ text })),
            onReasoningChunk: stream.live('reasoning', (text: string) => ({ text })),
            onCompaction: stream.live('summary', (compaction) => compaction),
            onPlan: stream.live('plan', (plan) => plan),
            onSubagent: stream.live('subagent', (event) => event),
          }
          : {}),
      });
      if (wantsStream) {
        stream.start();
        stream.send('result', continued.result);
        stream.end();
        return reply;
      }
      return reply.code(200).send({ status: 'continued', result: continued.result });
    } catch (error) {
      const classified = classifyAgentRunError(error, { exposeInternal: true });
      const resumeStatus = (error as { status?: unknown })?.status;
      if (stream.started()) {
        // The status line is long gone; the error travels as an event, like `/chat/stream`.
        stream.send('error', isPlanLimitError(error) ? planLimitErrorBody(error) : { error: classified.error.message, type: classified.error.type, code: classified.error.code });
        stream.end();
        return reply;
      }
      if (error instanceof AgentGuardrailBlockedError) {
        return sendAgentGuardrailBlock(reply, error);
      }
      if (isPlanLimitError(error)) return reply.headers(planLimitHeaders(error)).code(error.status).send(planLimitErrorBody(error));
      if (classified.status >= 500) logger.error('Continue session error', { error });
      return sendProjectContextError(reply, error) ?? reply.code(
        typeof resumeStatus === 'number' && (error as Error).name === 'AgentResumeError' ? resumeStatus : classified.status,
      ).send({
        error: classified.error.message,
        type: classified.error.type,
        code: classified.error.code,
        ...(classified.error.spentUsd !== undefined ? { spentUsd: classified.error.spentUsd } : {}),
        ...(classified.error.maxCostUsd !== undefined ? { maxCostUsd: classified.error.maxCostUsd } : {}),
      });
    } finally {
      watch?.stop();
      unsubscribe?.();
      await slot?.release();
      await reservation?.release();
    }
  }));

  app.delete('/agents/:agentId/sessions/:sessionId', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      // Deleting somebody else's session is acting on it: the owner always may, anybody else needs
      // `agent.session_manage_others`.
      const scoped = await requireScopedSession(request, reply, { need: 'manage' });
      if (!scoped) return reply;
      await deleteConversation(scoped.session.tenantDbName, String(scoped.conversation._id));
      return reply.code(200).send({ success: true });
    } catch (error) {
      return sendRouteError(reply, error, 'Delete agent session error', 'Failed to delete session');
    }
  }));

  // ── Session event log + pending actions ──

  app.get('/agents/:agentId/sessions/:sessionId/events', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'view' });
      if (!scoped) return reply;
      const body = await listSessionEvents(
        scoped.session.tenantDbName,
        String(scoped.conversation._id),
        (request.query ?? {}) as Record<string, unknown>,
      );
      return reply.code(200).send(body);
    } catch (error) {
      return sendRouteError(reply, error, 'List session events error', 'Failed to list session events');
    }
  }));

  app.get('/agents/:agentId/sessions/:sessionId/events/stream', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    let scoped: Awaited<ReturnType<typeof requireScopedSession>>;
    try {
      scoped = await requireScopedSession(request, reply, { need: 'view' });
    } catch (error) {
      return sendRouteError(reply, error, 'Session event stream error', 'Failed to open the event stream');
    }
    if (!scoped) return reply;
    const conversationId = String(scoped.conversation._id);
    return streamSessionEvents(request, reply, scoped.session.tenantDbName, conversationId, 'dashboard', () => sessionStreamStillAllowed(request, conversationId, {
      agentKey: scoped.agent.key,
      agent: scoped.agent,
      projectId: scoped.projectId,
    }));
  }));

  // ── Feedback: what people said about this agent's answers ──
  //
  // Counts and reasons are for everyone who can read agents; the words people wrote (and
  // who wrote them) only for those who can change them (`canReadComments` says which).

  app.get('/agents/:agentId/sessions/:sessionId/feedback', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'view' });
      if (!scoped) return reply;
      const canReadComments = await sessionHasAgentsPermission(scoped.session, 'write');
      const rows = await listSessionFeedback({
        tenantDbName: scoped.session.tenantDbName,
        projectId: scoped.projectId,
        conversationId: String(scoped.conversation._id),
        agentKey: scoped.agent.key,
      });
      return reply.code(200).send({
        feedback: rows.map((row) => {
          const view = toFeedbackView(row, { includeComment: canReadComments });
          return canReadComments ? view : { ...view, userId: undefined };
        }),
        canReadComments,
      });
    } catch (error) {
      if (error instanceof FeedbackError) return reply.code(error.status).send({ error: error.message, code: error.code });
      return sendRouteError(reply, error, 'List session feedback error', 'Failed to list feedback');
    }
  }));

  app.get('/agents/:agentId/feedback', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const filter = parseFeedbackFilter(request.query, agent.key, projectId);
      if ('error' in filter) return reply.code(400).send({ error: filter.error });
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const canReadComments = await sessionHasAgentsPermission(session, 'write');
      const page = await listAgentFeedback(session.tenantDbName, filter, {
        limit: Math.min(Math.max(Number(query.limit) || 25, 1), 100),
        skip: Math.max(Number(query.skip) || 0, 0),
      });
      return reply.code(200).send({
        items: page.items.map((row) => ({
          ...toFeedbackView(row, { includeComment: canReadComments }),
          conversationId: row.conversationId,
          agentVersion: row.agentVersion ?? null,
          ...(canReadComments ? {} : { userId: undefined }),
        })),
        total: page.total,
        canReadComments,
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent feedback error', 'Failed to list feedback');
    }
  }));

  app.get('/agents/:agentId/feedback/summary', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const filter = parseFeedbackFilter(request.query, agent.key, projectId);
      if ('error' in filter) return reply.code(400).send({ error: filter.error });
      const summary = await summarizeAgentFeedback(session.tenantDbName, filter);
      return reply.code(200).send({ summary, days: feedbackDays(request.query) });
    } catch (error) {
      return sendRouteError(reply, error, 'Summarize agent feedback error', 'Failed to summarize feedback');
    }
  }));

  app.get('/agents/:agentId/sessions/:sessionId/actions', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'view' });
      if (!scoped) return reply;
      const body = await listConversationActions(
        scoped.session.tenantDbName,
        String(scoped.conversation._id),
        (request.query ?? {}) as Record<string, unknown>,
      );
      // What THIS caller could do with each open request, decided by the engine's own rule - the page shows it
      // instead of guessing from the agent's setting and the viewer's role.
      const ability = await describeAnswerAbility(request, {
        tenantDbName: scoped.session.tenantDbName,
        conversation: scoped.conversation,
        actions: await openActionsOf(scoped.session.tenantDbName, String(scoped.conversation._id)),
        agent: scoped.agent,
        actor: { tenantDbName: scoped.session.tenantDbName, projectId: scoped.projectId, userId: scoped.session.userId },
      });
      return reply.code(200).send({ actions: withAnswerAbility(body.actions, ability) });
    } catch (error) {
      return sendRouteError(reply, error, 'List session actions error', 'Failed to list session actions');
    }
  }));

  /**
   * Answer a pending approval / question and let the paused turn continue.
   *
   * Without `?stream=1` the call returns when the continuation has finished
   * (JSON). With it, the continuation is an SSE stream in the SAME event format
   * as `/chat/stream` (`tool`, `text`, `summary`, `result`, `error`, plus the
   * additive `action` / `status`), so a client renders it like any other turn.
   * A refusal (404, 403, 409, 410, 400) is a normal JSON response either way:
   * the stream only opens once there is a continuation to report.
   */
  app.post('/agents/:agentId/sessions/:sessionId/actions/:actionId/resolve', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    let scoped: Awaited<ReturnType<typeof requireScopedSession>>;
    try {
      // Who may answer is asked below, of the request itself: `agent.approve` for a tool approval, the session's
      // ownership for a question - not the "view / change somebody else's session" pair this loader asks.
      scoped = await requireScopedSession(request, reply, { need: 'none' });
    } catch (error) {
      return sendRouteError(reply, error, 'Resolve action error', 'Failed to resolve the request');
    }
    if (!scoped) return reply;

    const { actionId } = request.params as { actionId: string };
    const conversationId = String(scoped.conversation._id);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const wantsStream = query.stream === '1' || query.stream === 'true';
    const body = readJsonBody<Record<string, unknown>>(request);

    // The stream opens lazily; the continuation's first event starts it.
    const stream = openLazySseStream(reply, wantsStream);
    const { send, live } = stream;
    const startStream = stream.start;

    const unsubscribe = wantsStream
      ? sessionEventBus.subscribe(conversationId, (frame) => {
        if (frame.type === 'action.required') send('action', frame.data, frame.seq);
        else if (frame.type.startsWith('session.status_')) send('status', { type: frame.type, ...frame.data }, frame.seq);
      })
      : undefined;

    try {
      const outcome = await resolveAgentPendingAction({
        tenantDbName: scoped.session.tenantDbName,
        tenantId: scoped.session.tenantId,
        projectId: scoped.projectId,
        conversationId,
        actionId,
        agentKey: scoped.agent.key,
        body,
        actor: dashboardActor(scoped),
        authorize: approvalAuthorizerFor(request, scoped.session.tenantDbName),
        mode: 'sync',
        runtimeContext: buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
          userId: scoped.session.userId,
          source: 'playground',
        }),
        ...(wantsStream
          ? {
            stream: {
              onToolEvent: live('tool', (event) => event),
              onTextChunk: live('text', (text: string) => ({ text })),
              onReasoningChunk: live('reasoning', (text: string) => ({ text })),
              onCompaction: live('summary', (compaction) => compaction),
              onPlan: live('plan', (plan) => plan),
              onSubagent: live('subagent', (event) => event),
              onRunQueued: live('run.queued', (info) => info),
              onRunStarted: () => send('run.started', {}),
            },
          }
          : {}),
        audit: {
          ipAddress: request.ip,
          userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
        },
      });

      // The engine could not decide who may answer: 503 (never a 403), nothing was recorded.
      if (outcome.kind === 'unavailable') {
        return sendAuthorizationUnavailable(reply, request, 'dashboard', { action: 'agent.approve', level: 'write', decisionId: outcome.decisionId });
      }
      const refusal = resolveRefusal(outcome);
      if (refusal) return reply.code(refusal.status).send(refusal.body);

      if (outcome.kind === 'pending') {
        return reply.code(200).send({ status: 'requires_action', pendingActions: outcome.pendingActions });
      }
      if (outcome.kind === 'resumed') {
        // A flow step waiting on this agent's answer continues now (the sweeper would find it within a minute).
        if (isOwnedAgent(scoped.agent)) {
          await getFlowsHost()?.wakeAgentActionWaits(
            { tenantDbName: scoped.session.tenantDbName, tenantId: scoped.session.tenantId, projectId: scoped.projectId },
            { flowId: scoped.agent.owner.flowId, sessionId: conversationId },
          ).catch((error) => logger.warn('Could not wake the flow run waiting on the agent', { error: error instanceof Error ? error.message : String(error) }));
        }
        if (wantsStream) {
          startStream();
          send('result', outcome.result);
          stream.end();
          return reply;
        }
        return reply.code(200).send({ status: 'resumed', result: outcome.result });
      }
      return reply.code(500).send({ error: 'Unexpected resolution outcome' });
    } catch (error) {
      const classified = classifyAgentRunError(error, { exposeInternal: true });
      const resumeStatus = (error as { status?: unknown })?.status;
      if (stream.started()) {
        // The status line is long gone; the error travels as an event, like `/chat/stream`.
        send('error', isPlanLimitError(error) ? planLimitErrorBody(error) : { error: classified.error.message, type: classified.error.type, code: classified.error.code });
        stream.end();
        return reply;
      }
      if (error instanceof AgentGuardrailBlockedError) {
        return sendAgentGuardrailBlock(reply, error);
      }
      if (isPlanLimitError(error)) return reply.headers(planLimitHeaders(error)).code(error.status).send(planLimitErrorBody(error));
      logger.error('Resolve action error', { error });
      return sendProjectContextError(reply, error) ?? reply.code(
        typeof resumeStatus === 'number' && (error as Error).name === 'AgentResumeError' ? resumeStatus : classified.status,
      ).send({
        error: classified.error.message,
        type: classified.error.type,
        code: classified.error.code,
      });
    } finally {
      unsubscribe?.();
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
  app.post('/agents/:agentId/chat/stream', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    const turn = await prepareDashboardTurn(request, reply);
    if (!turn) return reply;

    // Agent-run quota (domain `agent`). This route runs the playground runtime
    // directly (below), bypassing the `executePlaygroundChat` wrapper that
    // counts every other caller, so it counts here — before the stream opens,
    // which lets an exhausted caller get a real 429 instead of an error event.
    const quotaCaller: AgentRunCaller = {
      tenantDbName: turn.run.tenantDbName,
      tenantId: turn.run.tenantId,
      projectId: turn.run.projectId,
      agentKey: turn.run.agentKey,
      userId: turn.run.runtimeContext?.userId,
      tokenId: turn.run.runtimeContext?.tokenId,
    };
    try {
      await enforceAgentRunQuota(quotaCaller);
    } catch (error) {
      await turn.reservation?.release();
      const classified = classifyAgentRunError(error, { exposeInternal: true });
      return reply.code(classified.status).send({
        error: classified.error.message,
        type: classified.error.type,
        code: classified.error.code,
      });
    }

    applyStreamHeaders(reply);
    reply.raw.flushHeaders?.();

    // A stateless turn (no Session) has no run record for `…/cancel` to point at, so the client's
    // Stop is closing the stream: the run ends with what it had streamed. A Session turn keeps
    // running after a tab closes and is stopped through the session instead (`turnWatchFor`).
    const disconnect = typeof turn.run.conversationId === 'string' ? undefined : new AbortController();
    let closed = false;
    reply.raw.on('close', () => {
      closed = true;
      if (!reply.raw.writableEnded) disconnect?.abort();
    });
    const send = (event: string, data: unknown, id?: number) => {
      if (closed) return;
      try {
        reply.raw.write(formatSseFrame(event, data, id));
      } catch {
        closed = true;
      }
    };

    // A run that fails or is aborted late has still spent its tokens (see runUsage.ts).
    const usage = createRunUsageSink();

    // Additive events for a Session turn, taken from the same log the
    // `/events` endpoints serve (`id:` = the event's seq): `action` when the
    // agent pauses for an approval or a question, `status` as the turn starts
    // and stops. The events above are unchanged; an older client ignores these.
    const unsubscribeSessionEvents = typeof turn.run.conversationId === 'string'
      ? sessionEventBus.subscribe(turn.run.conversationId, (frame) => {
        if (frame.type === 'action.required') send('action', frame.data, frame.seq);
        else if (frame.type.startsWith('session.status_')) send('status', { type: frame.type, ...frame.data }, frame.seq);
      })
      : undefined;

    const watch = turnWatchFor(turn);
    // Plan limit (agent sessions): a dashboard turn is console-originated, so it takes a slot,
    // waits up to 15 s for one and tells the page (`run.queued`, `run.started`). Released in `finally`.
    let slot: AgentSessionSlot | undefined;
    try {
      slot = await acquireAgentSessionSlot({
        tenantId: turn.run.tenantId,
        holderId: turn.reservation ? String(turn.reservation.run._id) : undefined,
        origin: 'console',
        signal: watch?.signal ?? disconnect?.signal,
        onQueued: (info) => send('run.queued', info),
        onStarted: () => send('run.started', {}),
      });
      const result = await runWithUsageSink(usage, () => executePlaygroundChatLocal({
        ...turn.run,
        ...(watch ? { signal: watch.signal } : disconnect ? { signal: disconnect.signal } : {}),
        // A stateless call (Compare versions) carries its own earlier messages.
        history: readStatelessHistory(turn.body),
        onToolEvent: (event) => send('tool', event),
        onTextChunk: (text) => send('text', { text }),
        // The model's thinking as it happens (additive event: older clients ignore it).
        onReasoningChunk: (text) => send('reasoning', { text }),
        // The agent summarized its context mid-run: shown in the transcript
        // as it happens, not only once the turn is over.
        onCompaction: (compaction) => send('summary', compaction),
        // The agent's plan and its sub-agents' lifecycle (additive events: older clients ignore them).
        onPlan: (plan) => send('plan', plan),
        onSubagent: (event) => send('subagent', event),
      }));

      settleAgentRun(quotaCaller, usage, result.usage?.totalTokens);
      send('result', result);
    } catch (error) {
      settleAgentRun(quotaCaller, usage);
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
        logAgentRunFailure(logger, 'Agent playground stream error', error);
        const classified = classifyAgentRunError(error, { exposeInternal: true });
        send('error', isPlanLimitError(error) ? planLimitErrorBody(error) : { error: classified.error.message, type: classified.error.type, code: classified.error.code });
      }
    } finally {
      watch?.stop();
      unsubscribeSessionEvents?.();
      await slot?.release();
      await turn.reservation?.release();
      if (!closed) reply.raw.end();
    }
    return reply;
  }));

  app.post('/agents/:agentId/chat', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const turn = await prepareDashboardTurn(request, reply);
      if (!turn) return reply;
      const { body } = turn;

      let result: Awaited<ReturnType<typeof executePlaygroundChat>>;
      const watch = turnWatchFor(turn);
      let slot: AgentSessionSlot | undefined;
      try {
        // Plan limit (agent sessions): console-originated, waits up to 15 s; a refusal is a 429 below.
        slot = await acquireAgentSessionSlot({
          tenantId: turn.run.tenantId,
          holderId: turn.reservation ? String(turn.reservation.run._id) : undefined,
          origin: 'console',
          signal: watch?.signal,
        });
        result = await executePlaygroundChat({
          ...turn.run,
          ...(watch ? { signal: watch.signal } : {}),
          // Ignored server-side when conversationId is set (history loads from
          // the session instead) — still parsed so a stateless call (no
          // conversationId) keeps working exactly as before.
          history: readStatelessHistory(body),
        });
      } finally {
        watch?.stop();
        await slot?.release();
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
        logAgentRunFailure(logger, 'Agent playground chat error', error);
      }
      const classified = classifyAgentRunError(error, { exposeInternal: true });
      if (isPlanLimitError(error)) return reply.headers(planLimitHeaders(error)).code(error.status).send(planLimitErrorBody(error));
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
