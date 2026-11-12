import type { FastifyPluginAsync } from 'fastify';
import { registerIngestRoutes } from './client-tracing/ingestRoutes';
import { registerStreamRoutes } from './client-tracing/streamRoutes';
import { registerThreadRoutes } from './client-tracing/threadRoutes';

export { extractTraceDiagnostics } from './client-tracing/eventSections';

export const clientTracingApiPlugin: FastifyPluginAsync = async (app) => {
  registerIngestRoutes(app);
  registerStreamRoutes(app);
  registerThreadRoutes(app);
};
