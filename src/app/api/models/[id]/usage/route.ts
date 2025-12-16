import { NextRequest, NextResponse } from 'next/server';
import { getModelById, getUsageAggregate } from '@/lib/services/models/modelService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    if (!tenantDbName) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const model = await getModelById(tenantDbName, id, projectContext.projectId);

    if (!model) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const groupBy = (searchParams.get('groupBy') || 'day') as 'hour' | 'day' | 'month';

    const aggregate = await getUsageAggregate(
      tenantDbName,
      model.key,
      projectContext.projectId,
      {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      groupBy,
      },
    );

    return NextResponse.json({ usage: aggregate });
  } catch (error: unknown) {
    console.error('Fetch model usage error', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal error' }, { status: 500 });
  }
}
