import type { FastifyInstance } from 'fastify';
import {
  AgentDocumentParseError,
} from '@/lib/services/agents/import/document';
import {
  AgentImportError,
  applyAgentDocumentImport,
  previewAgentDocumentImport,
  type ApplyAgentDocumentImportInput,
} from '@/lib/services/agents/import/importService';
import type {
  FastifyReply,
} from 'fastify';
import type {
  AgentStatus,
  IAgent,
  IAgentConfig,
} from '@/lib/database';
import {
  createAgentRecord,
  deleteAgentRecord,
  getAgentVersion,
  listAgents,
  listAgentVersions,
  updateAgentRecord,
} from '@/lib/services/agents';
import {
  type AgentConfigIssue,
} from '@/lib/services/agents/agentConfigValidation';
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
import {
  collectManifestResources,
  parseResourceInclude,
} from '@/lib/services/agents/manifestResources';
import {
  generateAgentProject,
  type AgentCodegenTarget,
} from '@/lib/services/agents/agentCodegen';
import {
  buildPromptVariables,
  renderPromptTemplate,
} from '@/lib/services/agents/promptVariables';
import {
  getDatabase,
} from '@/lib/database';
import {
  DASHBOARD_AGENT_HITL_DEFAULTS,
} from '@/lib/services/agents/agentHumanInTheLoop';
import {
  advertisedModelsForRequest,
} from '../agent-model-authz';
import {
  readJsonBody,
  requireProjectContextForRequest,
  withApiRequestContext,
} from '../../fastify-utils';
import {
  BucketNamingForbiddenError,
} from '@/lib/services/agents/attachmentsBucketAccess';
import {
  OWNED_BY_FLOW_BODY,
} from '../agent-owned-access';
import {
  isOwnedAgent,
} from '@/lib/utils/ownedAgents';
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
  validateNativeConfigUpdate,
} from '../agent-config-write';
import {
  requestCanNameBucket,
} from '../files-permission';
import {
  configReadRequiredBody,
  requestHasConfigRead,
} from '../config-permission';
import {
  requestHasSandboxWrite,
} from '../sandbox-permission';
import {
  requireScopedAgent,
  agentInProjectScope,
  AGENT_SCOPED,
  sendRouteError,
} from './agentsRouteHelpers';

export function registerAgentsCrudRoutes(app: FastifyInstance): void {
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
}
