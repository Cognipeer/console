import { NextResponse, type NextRequest } from '@/server/api/http';
import { evaluateGuardrail } from '@/lib/services/guardrail';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('guardrails-evaluate');

/**
 * POST /api/guardrails/evaluate
 * Dashboard-side endpoint to test a guardrail against a text input.
 */
export async function POST(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const body = await request.json();

    if (!body.guardrail_key || typeof body.guardrail_key !== 'string') {
      return NextResponse.json({ error: 'guardrail_key is required' }, { status: 400 });
    }

    if (!body.text || typeof body.text !== 'string') {
      return NextResponse.json({ error: 'text is required' }, { status: 400 });
    }

    const result = await evaluateGuardrail({
      tenantDbName,
      tenantId,
      projectId: projectContext.projectId,
      guardrailKey: body.guardrail_key,
      text: body.text,
    });

    return NextResponse.json({
      passed: result.passed,
      guardrail_key: result.guardrailKey,
      guardrail_name: result.guardrailName,
      action: result.action,
      findings: result.findings,
      message: result.passed ? null : buildUserMessage(result.findings),
    });
  } catch (error: unknown) {
    logger.error('Evaluate error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Internal error';
    const is404 = message.toLowerCase().includes('not found');
    return NextResponse.json({ error: message }, { status: is404 ? 404 : 500 });
  }
}

function buildUserMessage(findings: Array<{ category: string; message: string; block: boolean }>) {
  const blocking = findings.filter((f) => f.block);
  if (blocking.length === 0) return 'Content flagged by guardrail.';
  const lines = blocking.map((f) => {
    const cat = f.category.replace(/[_/-]+/g, ' ').replace(/(^|\s)\w/g, (c) => c.toUpperCase());
    return `• ${cat}: ${f.message}`;
  });
  return `Content blocked by guardrail:\n${lines.join('\n')}`;
}
