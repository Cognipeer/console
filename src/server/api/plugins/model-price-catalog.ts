/**
 * Model price catalog API plugin — market reference prices (LiteLLM feed).
 *
 * Serves the in-memory model price catalog to the dashboard: the Cost →
 * Pricing "match from catalog" flow and the Model Hub "fill from catalog"
 * affordance. The catalog is process-global market data (not tenant data);
 * project context is required for authentication only.
 *
 *   GET  /model-price-catalog          – status; `?entries=1` adds a paged,
 *                                        key-sorted slice (`offset`, `limit`,
 *                                        `q` substring filter)
 *   POST /model-price-catalog/refresh  – force a refetch of the source file
 *   GET  /model-price-catalog/suggest  – `?names=a,b,c` → per-name pricing
 *                                        suggestions with confidence tiers
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { OutboundNetworkError } from '@/lib/security/outboundFetch';
import {
  getCatalogStatus,
  listCatalogEntries,
  refreshCatalog,
  suggestPricing,
} from '@/lib/services/modelPriceCatalog/modelPriceCatalog';
import {
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:model-price-catalog');

const MAX_SUGGEST_NAMES = 200;

/** Catalog-source failures surface as 502 — the upstream feed is at fault. */
function sendCatalogError(reply: FastifyReply, error: unknown) {
  if (error instanceof OutboundNetworkError || (error instanceof Error && /catalog fetch failed/i.test(error.message))) {
    return reply.code(502).send({ error: error.message });
  }
  return sendProjectContextError(reply, error)
    ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
}

export const modelPriceCatalogApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/model-price-catalog', withApiRequestContext(async (request, reply) => {
    try {
      await requireProjectContextForRequest(request);
      const query = request.query as {
        entries?: string;
        offset?: string;
        limit?: string;
        q?: string;
      };
      if (query.entries === '1' || query.entries === 'true') {
        const { total, entries } = await listCatalogEntries({
          offset: Number(query.offset) || 0,
          limit: Number(query.limit) || 50,
          search: query.q,
        });
        return reply.code(200).send({ status: getCatalogStatus(), total, entries });
      }
      return reply.code(200).send({ status: getCatalogStatus() });
    } catch (error) {
      logger.error('Model price catalog status error', { error });
      return sendCatalogError(reply, error);
    }
  }));

  app.post('/model-price-catalog/refresh', withApiRequestContext(async (request, reply) => {
    try {
      await requireProjectContextForRequest(request);
      const status = await refreshCatalog();
      return reply.code(200).send({ status });
    } catch (error) {
      logger.error('Model price catalog refresh error', { error });
      return sendCatalogError(reply, error);
    }
  }));

  app.get('/model-price-catalog/suggest', withApiRequestContext(async (request, reply) => {
    try {
      await requireProjectContextForRequest(request);
      const query = request.query as { names?: string };
      const names = (query.names ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .slice(0, MAX_SUGGEST_NAMES);
      if (names.length === 0) {
        return reply.code(400).send({ error: '`names` is required (comma-separated model names)' });
      }
      const suggestions = await suggestPricing(names);
      return reply.code(200).send({ status: getCatalogStatus(), suggestions });
    } catch (error) {
      logger.error('Model price catalog suggest error', { error });
      return sendCatalogError(reply, error);
    }
  }));
};
