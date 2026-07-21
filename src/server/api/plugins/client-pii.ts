/**
 * Client PII API plugin.
 *
 * External-facing PII surface, authenticated with an API token and using the
 * `/client/v1/*` paths with snake_case request/response fields like the other
 * client modules.
 *
 * Every detection endpoint is **policy-based**: the caller must pass a
 * `policy_key`, and the enabled categories, custom regex patterns, languages
 * and severities all come from that stored policy (managed in the dashboard).
 * The named endpoints pin the action; `/scan` lets the caller override it.
 *
 *   POST /client/v1/pii/detect      – detect against a policy (no transform)
 *   POST /client/v1/pii/redact      – redact ([REDACTED_X]) against a policy
 *   POST /client/v1/pii/mask        – partial mask against a policy
 *   POST /client/v1/pii/tokenize    – reversible mask ([EMAIL_1]) + vault
 *   POST /client/v1/pii/scan        – scan with a policy, optional action override
 *   POST /client/v1/pii/detokenize  – restore originals from a vault (no policy)
 *
 * The tokenize/detokenize pair is designed for an LLM round-trip: tokenize the
 * prompt, send the tokenized text to a model, then detokenize the model's
 * response with the same vault. The vault is returned to the caller and never
 * persisted server-side.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { PiiAction, PiiLanguage } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  buildDefaultPolicyCategories,
  createPiiPolicy,
  deletePiiPolicy,
  detokenizePii,
  getPiiPolicyByKey,
  scanWithPolicy,
  updatePiiPolicy,
} from '@/lib/services/pii';
import type { PiiScanResult, PiiVault } from '@/lib/services/pii';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-pii');

const VALID_ACTIONS: PiiAction[] = ['detect', 'redact', 'mask', 'block', 'tokenize'];
const ACTIONS_HINT = 'detect, redact, mask, block, or tokenize';
const VALID_LANGS: PiiLanguage[] = ['global', 'en', 'tr', 'de', 'fr', 'es', 'it', 'pt', 'ar', 'ja', 'zh'];

function parseLocale(value: unknown): PiiLanguage {
  if (typeof value === 'string' && (VALID_LANGS as string[]).includes(value)) {
    return value as PiiLanguage;
  }
  return 'en';
}

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

/** Shape the internal (camelCase) scan result into the snake_case client response. */
function toClientResult(result: PiiScanResult): Record<string, unknown> {
  const body: Record<string, unknown> = {
    action: result.action,
    findings: result.findings,
    output_text: result.outputText,
    input_length: result.inputLength,
    has_blocking: result.hasBlocking,
    languages: result.languages,
  };
  if (result.vault) body.vault = result.vault;
  return body;
}

/** Action pinned by each named endpoint. `scan` reads it from the body. */
const FIXED_ACTION: Record<string, PiiAction | undefined> = {
  detect: 'detect',
  redact: 'redact',
  mask: 'mask',
  tokenize: 'tokenize',
  scan: undefined,
};

export const clientPiiApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Policy-based detect / redact / mask / tokenize / scan ──
  for (const op of ['detect', 'redact', 'mask', 'tokenize', 'scan'] as const) {
    app.post(`/client/v1/pii/${op}`, withClientApiRequestContext(async (request, reply) => {
      try {
        const ctx = await getApiTokenContextForRequest(request);
        const body = readJsonBody<Record<string, unknown>>(request);

        const policyKey = (body.policy_key ?? body.policyKey) as unknown;
        if (typeof policyKey !== 'string') {
          return reply.code(400).send({ error: 'policy_key is required' });
        }
        if (typeof body.text !== 'string') {
          return reply.code(400).send({ error: 'text is required' });
        }

        const fixedAction = FIXED_ACTION[op];
        let actionOverride: PiiAction | undefined = fixedAction;
        if (op === 'scan' && body.action !== undefined) {
          if (!VALID_ACTIONS.includes(body.action as PiiAction)) {
            return reply.code(400).send({ error: 'action must be detect, redact, mask, block, or tokenize' });
          }
          actionOverride = body.action as PiiAction;
        }

        const result = await scanWithPolicy({
          tenantDbName: ctx.tenantDbName,
          policyKey,
          projectId: ctx.projectId,
          text: body.text,
          actionOverride,
          locale: parseLocale(body.locale),
        });

        return reply.code(200).send({
          policy_key: result.policyKey,
          policy_name: result.policyName,
          ...toClientResult(result),
        });
      } catch (error) {
        logger.error(`Client PII ${op} error`, { error });
        const message = error instanceof Error ? error.message : 'Internal error';
        return sendApiTokenError(reply, error)
          ?? reply.code(message.toLowerCase().includes('not found') ? 404 : 500).send({ error: message });
      }
    }));
  }

  // ── Detokenize: reverse a prior tokenize using its vault (no policy needed) ──
  app.post('/client/v1/pii/detokenize', withClientApiRequestContext(async (request, reply) => {
    try {
      await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.text !== 'string') {
        return reply.code(400).send({ error: 'text is required' });
      }
      if (typeof body.vault !== 'object' || body.vault === null || Array.isArray(body.vault)) {
        return reply.code(400).send({ error: 'vault is required (object returned by /client/v1/pii/tokenize)' });
      }
      const result = detokenizePii({ text: body.text, vault: body.vault as PiiVault });
      return reply.code(200).send({ output_text: result.outputText });
    } catch (error) {
      logger.error('Client PII detokenize error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Create a PII policy definition ──
  app.post('/client/v1/pii/policies', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }
      const defaultAction = (body.defaultAction as PiiAction) ?? 'detect';
      if (!VALID_ACTIONS.includes(defaultAction)) {
        return reply.code(400).send({ error: `defaultAction must be ${ACTIONS_HINT}` });
      }
      const categories = (body.categories as Record<string, boolean> | undefined)
        ?? buildDefaultPolicyCategories();

      const policy = await createPiiPolicy(ctx.tenantDbName, ctx.tenantId, ctx.tokenRecord.userId, {
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
        projectId: ctx.projectId,
      });

      return reply.code(201).send({ policy });
    } catch (error) {
      logger.error('Client PII policy create error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Update a PII policy definition (resolve by key, scoped to project) ──
  app.patch('/client/v1/pii/policies/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (body.defaultAction !== undefined && !VALID_ACTIONS.includes(body.defaultAction as PiiAction)) {
        return reply.code(400).send({ error: `defaultAction must be ${ACTIONS_HINT}` });
      }

      const existing = await getPiiPolicyByKey(ctx.tenantDbName, key, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'PII policy not found' });
      }

      const policy = await updatePiiPolicy(ctx.tenantDbName, existing.id, ctx.tokenRecord.userId, {
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        defaultAction: body.defaultAction as PiiAction | undefined,
        categories: body.categories as Record<string, boolean> | undefined,
        customPatterns: Array.isArray(body.customPatterns) ? (body.customPatterns as never[]) : undefined,
        languages: parseLanguages(body.languages),
        enabled: body.enabled as boolean | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
      });

      if (!policy) {
        return reply.code(404).send({ error: 'PII policy not found' });
      }
      return reply.code(200).send({ policy });
    } catch (error) {
      logger.error('Client PII policy update error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Delete a PII policy definition (resolve by key, scoped to project) ──
  app.delete('/client/v1/pii/policies/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };

      const existing = await getPiiPolicyByKey(ctx.tenantDbName, key, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'PII policy not found' });
      }

      const deleted = await deletePiiPolicy(ctx.tenantDbName, existing.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'PII policy not found' });
      }
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Client PII policy delete error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
