import { NextRequest, NextResponse } from 'next/server';
import { TraceEvalService } from '@/lib/services/traceEval';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

export async function POST(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const body = await request.json().catch(() => ({}));

    const result = await TraceEvalService.generateDraftCases(
      tenantDbName,
      projectContext.projectId,
      {
        agent: body?.agent,
        status: body?.status,
        from: body?.from,
        to: body?.to,
        limit: body?.limit,
        riskFocus: body?.riskFocus,
      },
    );

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error('Generate eval drafts error:', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate eval drafts' },
      { status: 500 },
    );
  }
}
