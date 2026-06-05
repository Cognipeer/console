/**
 * Shared helpers for the client PII route handlers.
 *
 * Every detection endpoint on the client surface is **policy-based**: the caller
 * must pass a `policy_key`, and the enabled categories, custom regex patterns,
 * languages and severities all come from that stored policy. The named
 * endpoints (detect/redact/mask/tokenize) simply pin the action; `/scan` lets
 * the caller override it. This keeps all PII behaviour controllable per policy.
 */

import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import type { PiiAction, PiiLanguage } from '@/lib/database';
import { scanWithPolicy } from '@/lib/services/pii';
import type { PiiScanResult } from '@/lib/services/pii';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-pii');

const VALID_LANGS: PiiLanguage[] = ['global', 'en', 'tr', 'de', 'fr', 'es', 'it', 'pt', 'ar', 'ja', 'zh'];
export const VALID_ACTIONS: PiiAction[] = ['detect', 'redact', 'mask', 'block', 'tokenize'];

export function parseLocale(value: unknown): PiiLanguage {
  if (typeof value === 'string' && (VALID_LANGS as string[]).includes(value)) {
    return value as PiiLanguage;
  }
  return 'en';
}

/** Shape the internal (camelCase) scan result into the snake_case client response. */
export function toClientResult(result: PiiScanResult): Record<string, unknown> {
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

/**
 * Build a POST handler that scans `text` against a stored policy.
 *
 * @param fixedAction When set, the endpoint always applies this action and
 *   ignores any `action` in the body (used by detect/redact/mask/tokenize).
 *   When omitted, the caller may override via `body.action` (used by `/scan`).
 */
export function makePiiScanRoute(fixedAction?: PiiAction) {
  const _POST = async (request: NextRequest) => {
    try {
      const ctx = await requireApiToken(request);
      const body = await request.json();

      const policyKey = (body.policy_key ?? body.policyKey) as unknown;
      if (typeof policyKey !== 'string') {
        return NextResponse.json({ error: 'policy_key is required' }, { status: 400 });
      }
      if (typeof body.text !== 'string') {
        return NextResponse.json({ error: 'text is required' }, { status: 400 });
      }

      let actionOverride: PiiAction | undefined = fixedAction;
      if (!fixedAction && body.action !== undefined) {
        if (!VALID_ACTIONS.includes(body.action as PiiAction)) {
          return NextResponse.json(
            { error: 'action must be detect, redact, mask, block, or tokenize' },
            { status: 400 },
          );
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

      return NextResponse.json({
        policy_key: result.policyKey,
        policy_name: result.policyName,
        ...toClientResult(result),
      });
    } catch (error) {
      if (error instanceof ApiTokenAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      const message = error instanceof Error ? error.message : 'Internal error';
      logger.error('PII scan error', { error, action: fixedAction });
      return NextResponse.json(
        { error: message },
        { status: message.toLowerCase().includes('not found') ? 404 : 500 },
      );
    }
  };

  return withRequestContext(_POST);
}
