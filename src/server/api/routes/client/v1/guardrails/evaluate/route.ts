import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { evaluateGuardrail } from '@/lib/services/guardrail';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-guardrails');

/**
 * POST /api/client/v1/guardrails/evaluate
 *
 * Evaluate text against a named guardrail.
 *
 * Body:
 *   - guardrail_key: string (required) - the guardrail key
 *   - text: string (required) - the text to evaluate
 *   - target?: "input" | "output" | "both" - optional target filter (default: no filter)
 */
const _POST = async (request: NextRequest) => {
  let ctx;
  try {
    ctx = await requireApiToken(request);
  } catch (err) {
    if (err instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();

    if (!body.guardrail_key || typeof body.guardrail_key !== 'string') {
      return NextResponse.json({ error: 'guardrail_key is required' }, { status: 400 });
    }

    if (!body.text || typeof body.text !== 'string') {
      return NextResponse.json({ error: 'text is required' }, { status: 400 });
    }

    const result = await evaluateGuardrail({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      guardrailKey: body.guardrail_key,
      text: body.text,
    });

    return NextResponse.json({
      passed: result.passed,
      guardrail_key: result.guardrailKey,
      guardrail_name: result.guardrailName,
      action: result.action,
      findings: result.findings,
      message: result.passed
        ? null
        : buildUserMessage(result.findings),
    });
  } catch (error: unknown) {
    logger.error('Guardrails evaluate error', { error });
    const message = error instanceof Error ? error.message : 'Internal error';
    const is404 = message.toLowerCase().includes('not found');
    return NextResponse.json({ error: message }, { status: is404 ? 404 : 500 });
  }
};

export const POST = withRequestContext(_POST);

function buildUserMessage(findings: Array<{ category: string; message: string; block: boolean }>) {
  const blocking = findings.filter((f) => f.block);
  if (blocking.length === 0) return 'Content flagged by guardrail.';
  const lines = blocking.map((f) => `• ${formatCategory(f.category)}: ${f.message}`);
  return `Content blocked by guardrail:\n${lines.join('\n')}`;
}

function formatCategory(category: string): string {
  return category
    .replace(/[_/-]+/g, ' ')
    .replace(/(^|\s)\w/g, (c) => c.toUpperCase())
    .trim();
}
