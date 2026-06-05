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
import { detokenizePii, scanWithPolicy } from '@/lib/services/pii';
import type { PiiScanResult, PiiVault } from '@/lib/services/pii';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-pii');

const VALID_ACTIONS: PiiAction[] = ['detect', 'redact', 'mask', 'block', 'tokenize'];
const VALID_LANGS: PiiLanguage[] = ['global', 'en', 'tr', 'de', 'fr', 'es', 'it', 'pt', 'ar', 'ja', 'zh'];

function parseLocale(value: unknown): PiiLanguage {
  if (typeof value === 'string' && (VALID_LANGS as string[]).includes(value)) {
    return value as PiiLanguage;
  }
  return 'en';
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
};
