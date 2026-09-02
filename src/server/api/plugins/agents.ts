import type { FastifyPluginAsync } from 'fastify';
import type { AgentStatus, IAgent, IAgentConfig, IUser } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createAgentRecord,
  createConversation,
  deleteAgentRecord,
  executePlaygroundChat,
  getAgentById,
  getAgentVersion,
  listAgents,
  listAgentVersions,
  listConversations,
  normalizeA2aMetadataUpdate,
  prepareConnectionForStorage,
  publishAgent,
  updateAgentRecord,
} from '@/lib/services/agents';
// By path: the agents barrel does not export the error class.
import { AgentGuardrailBlockedError } from '@/lib/services/agents/agentService';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import { carriedGuardrailFields, resolveConfigGuardrailBindings } from './guardrail-bindings';

const logger = createLogger('api:agents');

/**
 * A guardrail refusal is a POLICY decision, not a server fault: answered with
 * the same `guardrail_block` envelope and status the inference routes use for
 * `GuardrailBlockError`, so a client can branch on `error.type` whether it
 * called a model or an agent. Returns null for any other error so the caller's
 * own fallback still applies.
 */
function sendAgentGuardrailBlock(
  reply: Parameters<typeof sendProjectContextError>[0],
  error: unknown,
) {
  if (!(error instanceof AgentGuardrailBlockedError)) return null;
  return reply.code(error.status).send({
    error: {
      type: 'guardrail_block',
      action: 'block',
      message: error.message,
      reason: error.reason,
      guardrail_key: error.guardrailKey ?? null,
      hook: error.hook ?? null,
    },
  });
}

/**
 * Strip secret material (encrypted inline API keys) from an agent before it
 * leaves the API. The presence of a key is surfaced as `connection.hasApiKey`.
 */
function redactAgent<T extends IAgent>(agent: T): T {
  const connection = agent.config?.connection;
  if (!connection) return agent;
  const { apiKeyEnc, ...rest } = connection;
  return {
    ...agent,
    config: {
      ...agent.config,
      connection: { ...rest, hasApiKey: Boolean(apiKeyEnc) },
    },
  } as unknown as T;
}

/**
 * Normalize an incoming agent config. For connected (external) agents the
 * connection is validated and its inline API key encrypted; native agents must
 * carry a modelKey. Throws (Error) on invalid input — callers map to 400.
 *
 * A connected agent's config is rebuilt from scratch so nothing but the
 * validated connection is stored — EXCEPT its guardrail bindings, which are
 * carried through (`carriedGuardrailFields`) and validated by
 * `applyConfigGuardrailBindings` right after. Dropping them here is what made
 * the connected-agent enforcement branch unreachable: the binding list saved
 * with a 200 and `resolveBindings` read `{ kind, connection }` as "nothing bound".
 */
function normalizeAgentConfig(rawConfig: unknown): IAgentConfig {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('Agent config is required');
  }
  const cfg = rawConfig as Record<string, unknown>;

  if (cfg.kind === 'external') {
    return {
      kind: 'external',
      connection: prepareConnectionForStorage(cfg.connection),
      ...carriedGuardrailFields(cfg),
    };
  }

  if (typeof cfg.modelKey !== 'string' || !cfg.modelKey) {
    throw new Error('Model configuration is required');
  }
  return cfg as IAgentConfig;
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
/**
 * Validate `config.guardrails` and stamp the deprecated single slots back onto
 * the config from it, in place.
 *
 * Done here rather than in `normalizeAgentConfig` because it needs the tenant
 * database and the caller's project scope, and `normalizeAgentConfig` is
 * deliberately synchronous and DB-free. Returns the 400 message, or null.
 *
 * Runs for connected (external) agents too: their `input.pre` / `output.pre`
 * bindings are enforced by `executeAgentChatLocal`'s external branch, so they
 * are validated exactly like a native agent's.
 */
async function applyConfigGuardrailBindings(
  config: IAgentConfig,
  tenantDbName: string,
  projectId: string,
  user?: Pick<IUser, 'role'>,
): Promise<string | null> {
  const resolved = await resolveConfigGuardrailBindings(
    tenantDbName,
    projectId,
    config.guardrails,
    user,
  );
  if (resolved.error) return resolved.error;
  if (resolved.patch) Object.assign(config, resolved.patch);
  return null;
}

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
      logger.error('List agents error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to list agents' });
    }
  }));

  app.post('/agents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session, user } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'Agent name is required' });
      }

      let config: IAgentConfig;
      try {
        config = normalizeAgentConfig(body.config);
      } catch (validationError) {
        return reply.code(400).send({
          error: validationError instanceof Error ? validationError.message : 'Invalid agent config',
        });
      }

      const bindingError = await applyConfigGuardrailBindings(
        config,
        session.tenantDbName,
        projectId,
        user,
      );
      if (bindingError) {
        return reply.code(400).send({ error: bindingError });
      }

      const agent = await createAgentRecord(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        {
          config,
          description: body.description as string | undefined,
          name: body.name,
        },
      );

      return reply.code(201).send({ agent: redactAgent(agent) });
    } catch (error) {
      logger.error('Create agent error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to create agent' });
    }
  }));

  app.get('/agents/:agentId', withApiRequestContext(async (request, reply) => {
    try {
      await requireProjectContextForRequest(request);
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const agent = await agentInProjectScope(session.tenantDbName, agentId, projectId, user);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ agent: redactAgent(agent) });
    } catch (error) {
      logger.error('Get agent error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to get agent' });
    }
  }));

  app.patch('/agents/:agentId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      if (!(await agentInProjectScope(session.tenantDbName, agentId, projectId, user))) {
        return reply.code(404).send({ error: 'Agent not found' });
      }
      const body = readJsonBody<Record<string, unknown>>(request);

      if (body.config && typeof body.config === 'object') {
        const cfg = body.config as Record<string, unknown>;
        if (cfg.kind === 'external') {
          // Connected-agent config: validate connection & preserve the stored
          // API key when the client edits without resending it.
          const conn = { ...((cfg.connection as Record<string, unknown>) ?? {}) };
          if (!conn.apiKey && !conn.apiKeyEnc) {
            const existing = await getAgentById(session.tenantDbName, agentId);
            const existingEnc = existing?.config?.connection?.apiKeyEnc;
            if (existingEnc) conn.apiKeyEnc = existingEnc;
          }
          let externalConfig: IAgentConfig;
          try {
            externalConfig = {
              kind: 'external',
              connection: prepareConnectionForStorage(conn),
              // Carried, then validated below — see `normalizeAgentConfig`.
              ...carriedGuardrailFields(cfg),
            };
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
        } else {
          // Guard: never let a native-shaped config silently clobber a stored
          // connected agent's connection (e.g. a stray playground auto-save).
          const existing = await getAgentById(session.tenantDbName, agentId);
          if (existing?.config?.kind === 'external') {
            delete body.config;
          } else {
            const resolved = await resolveConfigGuardrailBindings(
              session.tenantDbName,
              projectId,
              cfg.guardrails,
              user,
            );
            if (resolved.error) {
              return reply.code(400).send({ error: resolved.error });
            }
            // The config replaces the stored one wholesale, so the projected
            // legacy slots must be written on the SAME object — leaving them
            // out would clear the columns an older binary still reads.
            if (resolved.patch) Object.assign(cfg, resolved.patch);
          }
        }
      }

      // A2A exposure updates: whitelist fields and keep the endpoint slug
      // server-owned (existing slug is preserved, never client-chosen).
      if (body.metadata && typeof body.metadata === 'object'
        && (body.metadata as Record<string, unknown>).a2a !== undefined) {
        const metadata = body.metadata as Record<string, unknown>;
        const existing = await getAgentById(session.tenantDbName, agentId);
        metadata.a2a = normalizeA2aMetadataUpdate(metadata.a2a, existing);
      }

      const agent = await updateAgentRecord(session.tenantDbName, agentId, body, session.userId);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ agent: redactAgent(agent) });
    } catch (error) {
      logger.error('Update agent error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to update agent' });
    }
  }));

  app.delete('/agents/:agentId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      if (!(await agentInProjectScope(session.tenantDbName, agentId, projectId, user))) {
        return reply.code(404).send({ error: 'Agent not found' });
      }
      const deleted = await deleteAgentRecord(session.tenantDbName, agentId);

      if (!deleted) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete agent error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to delete agent' });
    }
  }));

  app.get('/agents/:agentId/versions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const query = (request.query ?? {}) as { limit?: string; skip?: string; version?: string };
      const agent = await agentInProjectScope(session.tenantDbName, agentId, projectId, user);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      if (query.version) {
        const version = await getAgentVersion(
          session.tenantDbName,
          agentId,
          Number.parseInt(query.version, 10),
        );

        if (!version) {
          return reply.code(404).send({ error: 'Version not found' });
        }

        return reply.code(200).send({ version });
      }

      const result = await listAgentVersions(session.tenantDbName, agentId, {
        limit: Number.parseInt(query.limit ?? '50', 10),
        skip: Number.parseInt(query.skip ?? '0', 10),
      });

      return reply.code(200).send({
        publishedVersion: agent.publishedVersion ?? null,
        total: result.total,
        versions: result.versions,
      });
    } catch (error) {
      logger.error('List agent versions error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to list agent versions' });
    }
  }));

  app.post('/agents/:agentId/publish', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      if (!(await agentInProjectScope(session.tenantDbName, agentId, projectId, user))) {
        // Same failure an unknown id already raises inside publishAgent, so the
        // route cannot confirm that another project's agent exists.
        throw new Error(`Agent "${agentId}" not found`);
      }
      const body = readJsonBody<Record<string, unknown>>(request);
      const version = await publishAgent(
        session.tenantDbName,
        agentId,
        session.userId,
        typeof body.changelog === 'string' ? body.changelog : undefined,
      );

      return reply.code(201).send({ version });
    } catch (error) {
      logger.error('Publish agent error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to publish agent',
        });
    }
  }));

  app.get('/agents/:agentId/conversations', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const agent = await agentInProjectScope(session.tenantDbName, agentId, projectId, user);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const conversations = await listConversations(session.tenantDbName, agent.key, {
        limit: 50,
        projectId,
      });

      return reply.code(200).send({ conversations });
    } catch (error) {
      logger.error('List agent conversations error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to list conversations' });
    }
  }));

  app.post('/agents/:agentId/conversations', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const agent = await agentInProjectScope(session.tenantDbName, agentId, projectId, user);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      const conversation = await createConversation(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        agent.key,
        typeof body.title === 'string' ? body.title : undefined,
      );

      return reply.code(201).send({ conversation });
    } catch (error) {
      logger.error('Create agent conversation error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to create conversation' });
    }
  }));

  app.post('/agents/:agentId/chat', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.message !== 'string') {
        return reply.code(400).send({ error: 'Message is required' });
      }

      const agent = await agentInProjectScope(session.tenantDbName, agentId, projectId, user);
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      // Playground JSON editor: caller-supplied runtime context (downstream
      // headers/metadata), stamped with the dashboard user's identity.
      const runtimeContext = buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
        userId: session.userId,
        source: 'playground',
      });

      const result = await executePlaygroundChat({
        agentKey: agent.key,
        runtimeContext,
        history: Array.isArray(body.history)
          ? body.history
            .filter((item): item is { content: string; role: string } =>
              Boolean(
                item
                && typeof item === 'object'
                && 'content' in item
                && 'role' in item
                && typeof (item as { content?: unknown }).content === 'string'
                && typeof (item as { role?: unknown }).role === 'string',
              ),
            )
            .map((item) => ({ content: item.content, role: item.role }))
          : undefined,
        projectId,
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        userMessage: body.message,
      });

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
      return sendAgentGuardrailBlock(reply, error)
        ?? sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Agent chat failed',
        });
    }
  }));
};
