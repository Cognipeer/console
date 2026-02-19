import { NextRequest, NextResponse } from 'next/server';
import { comparePromptVersions } from '@/lib/services/prompts';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const fromVersionId = searchParams.get('fromVersionId')?.trim();
    const toVersionId = searchParams.get('toVersionId')?.trim();

    if (!fromVersionId || !toVersionId) {
      return NextResponse.json({ error: 'fromVersionId and toVersionId are required' }, { status: 400 });
    }

    const comparison = await comparePromptVersions(
      tenantDbName,
      projectContext.projectId,
      id,
      fromVersionId,
      toVersionId,
    );

    if (!comparison) {
      return NextResponse.json({ error: 'Prompt or versions not found' }, { status: 404 });
    }

    return NextResponse.json({ comparison }, { status: 200 });
  } catch (error: unknown) {
    console.error('Compare prompt versions error', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
