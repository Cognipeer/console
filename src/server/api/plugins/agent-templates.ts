/**
 * The agent templates API of the dashboard: the catalog with what each template
 * still needs from the project, one template in full, and creating an agent
 * from a template.
 *
 *   GET  /agents/templates                              the gallery (agents read)
 *   GET  /agents/templates/:templateKey                 one template (agents read)
 *   POST /agents/templates/:templateKey/instantiate     create the agent (agents write)
 *
 * All three are declared as the `agents` service (GET read, everything else
 * write), and the audit trail records the POST like any other agent write.
 * Every handler is wrapped by `withApiRequestContext`, which is what the route
 * authorization gate looks for.
 *
 * The creating itself is `agentTemplateService.instantiateTemplate`; what only
 * this layer can provide - the caller's role for guardrail lookup, the bucket
 * permission, the trigger parser - is handed to it here.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { authz } from '@/lib/iam/routeAuthz';
import {
  AgentTemplateError,
  getTemplate,
  instantiateTemplate,
  listTemplates,
  type AgentTemplateScope,
  type AgentTemplateWriteDeps,
} from '@/lib/services/agents/templates/agentTemplateService';
import { readJsonBody, requireProjectContextForRequest, sendProjectContextError, withApiRequestContext } from '../fastify-utils';
import { prepareNewAgentConfig, redactAgent } from './agent-config-write';
import { prepareTriggerWrite } from './agent-triggers';
import { requestCanNameBucket } from './files-permission';
import { requestHasConfigRead } from './config-permission';
import { guardrailByKeyInScope } from './guardrails';

const logger = createLogger('api:agent-templates');

/** A refusal of the service is answered as it says; anything else is a failure of the route. */
function sendTemplateError(reply: FastifyReply, error: unknown, logMessage: string, message: string) {
  if (error instanceof AgentTemplateError) {
    return reply.code(error.status).send({ error: error.message, code: error.code, ...error.extra });
  }
  logger.error(logMessage, { error });
  return sendProjectContextError(reply, error) ?? reply.code(500).send({ error: message });
}

type ProjectContext = Awaited<ReturnType<typeof requireProjectContextForRequest>>;

function scopeOf({ projectId, session }: ProjectContext): AgentTemplateScope {
  return { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId };
}

/** The create's API-layer pieces, bound to this request's caller. */
function writeDepsFor(request: FastifyRequest, context: ProjectContext): AgentTemplateWriteDeps {
  const scope = scopeOf(context);
  return {
    guardrailExists: async (key) => Boolean(await guardrailByKeyInScope(scope.tenantDbName, key, scope.projectId, context.user)),
    prepareAgentConfig: (config) => prepareNewAgentConfig(config, {
      ...scope,
      user: context.user,
      canNameBucket: (bucketKey) => requestCanNameBucket(request, scope, bucketKey),
      canReferenceConfig: () => requestHasConfigRead(request, scope.projectId),
    }),
    prepareTriggerWrite: ({ body, agent }) => prepareTriggerWrite({ body, agent, scope }),
  };
}

/** Declared here, not left to the path map: the gate asks `agents` read for a GET and `agents` write for the POST. */
const AGENTS_SERVICE = { config: authz.service('agents') } as const;

export const agentTemplatesApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/agents/templates', AGENTS_SERVICE, withApiRequestContext(async (request, reply) => {
    try {
      const context = await requireProjectContextForRequest(request);
      return reply.code(200).send(await listTemplates(scopeOf(context)));
    } catch (error) {
      return sendTemplateError(reply, error, 'List agent templates error', 'Failed to list agent templates');
    }
  }));

  app.get('/agents/templates/:templateKey', AGENTS_SERVICE, withApiRequestContext(async (request, reply) => {
    try {
      const context = await requireProjectContextForRequest(request);
      const { templateKey } = request.params as { templateKey: string };
      return reply.code(200).send({ template: await getTemplate(scopeOf(context), templateKey) });
    } catch (error) {
      return sendTemplateError(reply, error, 'Get agent template error', 'Failed to get agent template');
    }
  }));

  app.post('/agents/templates/:templateKey/instantiate', AGENTS_SERVICE, withApiRequestContext(async (request, reply) => {
    try {
      const context = await requireProjectContextForRequest(request);
      const { templateKey } = request.params as { templateKey: string };
      let body: unknown;
      try {
        body = readJsonBody<unknown>(request);
      } catch {
        throw new AgentTemplateError(400, 'invalid_request', 'The body must be valid JSON');
      }
      const result = await instantiateTemplate(scopeOf(context), templateKey, body, context.session.userId, writeDepsFor(request, context));
      return reply.code(201).send({ ...result, agent: redactAgent(result.agent) });
    } catch (error) {
      return sendTemplateError(reply, error, 'Create agent from template error', 'Failed to create the agent from the template');
    }
  }));
};
