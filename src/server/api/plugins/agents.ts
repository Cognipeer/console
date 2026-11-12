import type { FastifyPluginAsync } from 'fastify';
import { registerAgentsCrudRoutes } from './agents/agentsCrudRoutes';
import { registerAgentsMetaRoutes } from './agents/agentsMetaRoutes';
import { registerAgentsSessionRoutes } from './agents/agentsSessionRoutes';
import { registerAgentsFeedbackRoutes } from './agents/agentsFeedbackRoutes';
import { registerAgentsSessionActionRoutes } from './agents/agentsSessionActionRoutes';
import { registerAgentsChatRoutes } from './agents/agentsChatRoutes';

export { requireScopedAgent, requireScopedSession } from './agents/agentsRouteHelpers';

export const agentsApiPlugin: FastifyPluginAsync = async (app) => {
  registerAgentsCrudRoutes(app);
  registerAgentsMetaRoutes(app);
  registerAgentsSessionRoutes(app);
  registerAgentsFeedbackRoutes(app);
  registerAgentsSessionActionRoutes(app);
  registerAgentsChatRoutes(app);
};
