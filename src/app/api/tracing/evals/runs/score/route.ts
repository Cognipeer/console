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

    const body = await request.json();
    if (!Array.isArray(body?.sessionIds) || body.sessionIds.length === 0) {
      return NextResponse.json({ error: 'sessionIds is required' }, { status: 400 });
    }

    const result = await TraceEvalService.scoreSessions(
      tenantDbName,
      projectContext.projectId,
      {
        sessionIds: body.sessionIds,
        thresholds: body.thresholds,
        passScore: body.passScore,
      },
    );

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error('Score eval run error:', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to score eval run' },
      { status: 500 },
    );
  }
}
