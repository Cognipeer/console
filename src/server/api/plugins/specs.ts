import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { safeFetch } from '@/lib/security/outboundFetch';
import { normalizeApiSpec, type SpecFormatHint } from '@/lib/services/specImport';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:specs');

// Cap fetched specs to a sane size to avoid pulling huge payloads server-side.
const MAX_SPEC_BYTES = 5 * 1024 * 1024; // 5 MB

export const specsApiPlugin: FastifyPluginAsync = async (app) => {
  /**
   * POST /specs/fetch
   *
   * Fetch an API specification (OpenAPI JSON/YAML or a Postman collection) from
   * a remote URL, server-side, behind the SSRF guard. Used by the "From URL"
   * import option in the MCP / Tool create dialogs so the browser does not hit
   * cross-origin CORS restrictions.
   *
   * Body: { url: string, format?: 'auto' | 'openapi' | 'postman' }
   * Returns: { content, contentType, detectedFormat }
   */
  app.post('/specs/fetch', withApiRequestContext(async (request, reply) => {
    try {
      // Auth + tenant/project binding (import is a project-scoped action).
      await requireProjectContextForRequest(request);

      const body = readJsonBody<Record<string, unknown>>(request);
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      const format = typeof body.format === 'string' ? (body.format as SpecFormatHint) : 'auto';

      if (!url) {
        return reply.code(400).send({ error: '"url" is required' });
      }

      let response: Response;
      try {
        response = await safeFetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain, */*' },
        });
      } catch (err) {
        return reply.code(400).send({
          error: `Could not fetch spec: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      if (!response.ok) {
        return reply.code(400).send({
          error: `Remote server responded with ${response.status}`,
        });
      }

      const contentType = response.headers.get('content-type') ?? '';
      const content = await response.text();

      if (content.length > MAX_SPEC_BYTES) {
        return reply.code(413).send({ error: 'Specification exceeds the 5 MB limit' });
      }

      // Best-effort validation/detection so the client can surface the format.
      let detectedFormat: string | undefined;
      try {
        detectedFormat = normalizeApiSpec(content, format).detectedFormat;
      } catch {
        // Leave detectedFormat undefined; the client still receives the raw text.
      }

      return reply.code(200).send({ content, contentType, detectedFormat });
    } catch (error) {
      logger.error('Fetch spec error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));
};
