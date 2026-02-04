import { NextRequest, NextResponse } from 'next/server';
import { listPromptVersions, setPromptLatestVersion } from '@/lib/services/prompts';
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

    const versions = await listPromptVersions(
      tenantDbName,
      projectContext.projectId,
      id,
    );

    return NextResponse.json({ versions }, { status: 200 });
  } catch (error: unknown) {
    console.error('List prompt versions error', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function POST(
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
    const body = await request.json();

    if (!body.versionId) {
      return NextResponse.json({ error: 'versionId is required' }, { status: 400 });
    }

    const prompt = await setPromptLatestVersion(
      tenantDbName,
      projectContext.projectId,
      id,
      body.versionId,
      userId,
    );

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt or version not found' }, { status: 404 });
    }

    return NextResponse.json({ prompt }, { status: 200 });
  } catch (error: unknown) {
    console.error('Set prompt latest version error', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
