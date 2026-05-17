/**
 * PII service API plugin.
 *
 * Endpoints (tenant + project scoped):
 *   GET    /api/pii/categories?locale=tr&languages=tr,en   – built-in catalog
 *   GET    /api/pii/policies                              – list
 *   POST   /api/pii/policies                              – create
 *   GET    /api/pii/policies/:id                          – fetch one
 *   PATCH  /api/pii/policies/:id                          – update
 *   DELETE /api/pii/policies/:id                          – delete
 *   POST   /api/pii/detect                                – ad-hoc detection (no persistence)
 *   POST   /api/pii/redact                                – ad-hoc redact ([REDACTED_X])
 *   POST   /api/pii/mask                                  – ad-hoc partial mask
 *   POST   /api/pii/scan                                  – scan with stored policy
 */

import type { FastifyPluginAsync } from 'fastify';
import type { PiiAction, PiiLanguage } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  buildDefaultPolicyCategories,
  createPiiPolicy,
  deletePiiPolicy,
  detectPii,
  getCategoryCatalog,
  getPiiPolicy,
  listPiiPolicies,
  maskPii,
  redactPii,
  scanWithPolicy,
  updatePiiPolicy,
} from '@/lib/services/pii';
import {
  parseBooleanQuery,
  readJsonBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:pii');

const VALID_ACTIONS: PiiAction[] = ['detect', 'redact', 'mask', 'block'];
const VALID_LANGS: PiiLanguage[] = ['global', 'en', 'tr', 'de', 'fr', 'es', 'it', 'pt', 'ar', 'ja', 'zh'];

function parseLanguages(input: unknown): PiiLanguage[] | undefined {
  if (input === undefined || input === null) return undefined;
  let arr: unknown[] = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'string') arr = input.split(',').map((s) => s.trim()).filter(Boolean);
  else return undefined;
  const out: PiiLanguage[] = [];
  for (const item of arr) {
    if (typeof item === 'string' && (VALID_LANGS as string[]).includes(item)) {
      out.push(item as PiiLanguage);
    }
  }
  return out.length ? out : undefined;
}

function parseLocale(value: unknown): PiiLanguage {
  if (typeof value === 'string' && (VALID_LANGS as string[]).includes(value)) {
    return value as PiiLanguage;
  }
  return 'en';
}

export const piiApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Catalog (no project context needed; safe to expose for any session) ──
  app.get('/pii/categories', withApiRequestContext(async (request, reply) => {
    try {
      requireSessionContext(request);
      const query = (request.query ?? {}) as { locale?: string; languages?: string };
      const locale = parseLocale(query.locale);
      const languages = parseLanguages(query.languages);
      return reply.code(200).send({
        categories: getCategoryCatalog(locale, languages),
        defaults: buildDefaultPolicyCategories(),
        supportedLanguages: VALID_LANGS,
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── List policies ──
  app.get('/pii/policies', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { enabled?: string; search?: string };
      const policies = await listPiiPolicies(session.tenantDbName, {
        projectId,
        enabled: parseBooleanQuery(query.enabled),
        search: query.search,
      });
      return reply.code(200).send({ policies });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Create ──
  app.post('/pii/policies', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }
      const defaultAction = (body.defaultAction as PiiAction) ?? 'detect';
      if (!VALID_ACTIONS.includes(defaultAction)) {
        return reply.code(400).send({ error: 'defaultAction must be detect, redact, mask, or block' });
      }
      const categories = (body.categories as Record<string, boolean> | undefined)
        ?? buildDefaultPolicyCategories();
      const policy = await createPiiPolicy(
        session.tenantDbName,
        session.tenantId,
        session.userId,
        {
          name: body.name.trim(),
          description: typeof body.description === 'string' ? body.description.trim() : undefined,
          defaultAction,
          categories,
          customPatterns: Array.isArray(body.customPatterns) ? (body.customPatterns as never[]) : [],
          languages: parseLanguages(body.languages),
          enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
          metadata: typeof body.metadata === 'object' && body.metadata !== null
            ? (body.metadata as Record<string, unknown>)
            : undefined,
          projectId,
        },
      );
      return reply.code(201).send({ policy });
    } catch (error) {
      logger.error('Create PII policy error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Get one ──
  app.get('/pii/policies/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const policy = await getPiiPolicy(session.tenantDbName, id);
      if (!policy) return reply.code(404).send({ error: 'PII policy not found' });
      return reply.code(200).send({ policy });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Update ──
  app.patch('/pii/policies/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      if (body.defaultAction !== undefined && !VALID_ACTIONS.includes(body.defaultAction as PiiAction)) {
        return reply.code(400).send({ error: 'defaultAction must be detect, redact, mask, or block' });
      }
      const policy = await updatePiiPolicy(session.tenantDbName, id, session.userId, {
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        defaultAction: body.defaultAction as PiiAction | undefined,
        categories: body.categories as Record<string, boolean> | undefined,
        customPatterns: Array.isArray(body.customPatterns) ? (body.customPatterns as never[]) : undefined,
        languages: parseLanguages(body.languages),
        enabled: body.enabled as boolean | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
      });
      if (!policy) return reply.code(404).send({ error: 'PII policy not found' });
      return reply.code(200).send({ policy });
    } catch (error) {
      logger.error('Update PII policy error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Delete ──
  app.delete('/pii/policies/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const deleted = await deletePiiPolicy(session.tenantDbName, id);
      if (!deleted) return reply.code(404).send({ error: 'PII policy not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete PII policy error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Ad-hoc detect/redact/mask (no policy needed) ──
  for (const op of ['detect', 'redact', 'mask'] as const) {
    app.post(`/pii/${op}`, withApiRequestContext(async (request, reply) => {
      try {
        requireSessionContext(request);
        const body = readJsonBody<Record<string, unknown>>(request);
        if (typeof body.text !== 'string') {
          return reply.code(400).send({ error: 'text is required' });
        }
        const payload = {
          text: body.text,
          categories: typeof body.categories === 'object' && body.categories !== null
            ? (body.categories as Record<string, boolean>)
            : undefined,
          customPatterns: Array.isArray(body.customPatterns) ? (body.customPatterns as never[]) : undefined,
          languages: parseLanguages(body.languages),
          locale: parseLocale(body.locale),
        };
        const result = op === 'detect'
          ? detectPii(payload)
          : op === 'redact'
            ? redactPii(payload)
            : maskPii(payload);
        return reply.code(200).send(result);
      } catch (error) {
        logger.error(`PII ${op} error`, { error });
        return sendProjectContextError(reply, error)
          ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
      }
    }));
  }

  // ── Scan with stored policy ──
  app.post('/pii/scan', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.policy_key !== 'string' && typeof body.policyKey !== 'string') {
        return reply.code(400).send({ error: 'policy_key is required' });
      }
      if (typeof body.text !== 'string') {
        return reply.code(400).send({ error: 'text is required' });
      }
      const policyKey = (body.policy_key ?? body.policyKey) as string;
      const actionOverride = body.action as PiiAction | undefined;
      if (actionOverride !== undefined && !VALID_ACTIONS.includes(actionOverride)) {
        return reply.code(400).send({ error: 'action must be detect, redact, mask, or block' });
      }
      const result = await scanWithPolicy({
        tenantDbName: session.tenantDbName,
        policyKey,
        projectId,
        text: body.text,
        actionOverride,
        locale: parseLocale(body.locale),
      });
      return reply.code(200).send(result);
    } catch (error) {
      logger.error('PII scan error', { error });
      if (error instanceof Error && error.message.toLowerCase().includes('not found')) {
        return reply.code(404).send({ error: error.message });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
