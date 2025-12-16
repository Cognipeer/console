import { NextRequest, NextResponse } from 'next/server';
import { getModelById, listUsageLogs } from '@/lib/services/models/modelService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

export const runtime = 'nodejs';

const MAX_LIMIT = 200;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
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

    const { id } = await params;
    const model = await getModelById(tenantDbName, id, projectContext.projectId);

    if (!model) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), MAX_LIMIT);
    const skip = parseInt(searchParams.get('skip') || '0', 10);
    const from = searchParams.get('from');
    const to = searchParams.get('to');

    const logs = await listUsageLogs(
      tenantDbName,
      model.key,
      projectContext.projectId,
      {
      limit,
      skip,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      },
    );

    return NextResponse.json({ logs });
  } catch (error: unknown) {
    console.error('Fetch model logs error', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
