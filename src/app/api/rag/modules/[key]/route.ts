import { NextRequest, NextResponse } from 'next/server';
import {
  getRagModule,
  updateRagModule,
  deleteRagModule as deleteRagModuleService,
} from '@/lib/services/rag/ragService';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const projectId = request.headers.get('x-project-id') ?? undefined;
  if (!tenantDbName) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { key } = await params;
    const ragModule = await getRagModule(tenantDbName, key, projectId);
    if (!ragModule) {
      return NextResponse.json({ error: 'RAG module not found' }, { status: 404 });
    }
    return NextResponse.json({ module: ragModule });
  } catch (error) {
    console.error('[rag] get error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const projectId = request.headers.get('x-project-id') ?? undefined;
  const userId = request.headers.get('x-user-id') ?? 'system';
  if (!tenantDbName) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { key } = await params;
    const ragModule = await getRagModule(tenantDbName, key, projectId);
    if (!ragModule) {
      return NextResponse.json({ error: 'RAG module not found' }, { status: 404 });
    }

    const body = await request.json();
    const updated = await updateRagModule(tenantDbName, String(ragModule._id), {
      ...body,
      updatedBy: userId,
    });

    return NextResponse.json({ module: updated });
  } catch (error) {
    console.error('[rag] update error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const projectId = request.headers.get('x-project-id') ?? undefined;
  if (!tenantDbName) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { key } = await params;
    const ragModule = await getRagModule(tenantDbName, key, projectId);
    if (!ragModule) {
      return NextResponse.json({ error: 'RAG module not found' }, { status: 404 });
    }

    await deleteRagModuleService(tenantDbName, String(ragModule._id));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[rag] delete error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
