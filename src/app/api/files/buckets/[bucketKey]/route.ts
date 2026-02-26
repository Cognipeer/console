import { NextRequest, NextResponse } from 'next/server';
import { deleteFileBucket, getFileBucket } from '@/lib/services/files';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('file-buckets');

export const runtime = 'nodejs';

export async function GET(request: NextRequest, context: { params: Promise<{ bucketKey: string }> }) {
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

    const { bucketKey } = await context.params;
    const bucket = await getFileBucket(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      bucketKey,
    );

    return NextResponse.json({ bucket }, { status: 200 });
  } catch (error) {
    logger.error('Get file bucket error', { error });

    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof Error && error.message === 'File bucket not found.') {
      return NextResponse.json({ error: 'Bucket not found' }, { status: 404 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ bucketKey: string }> }) {
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

    const { searchParams } = new URL(request.url);
    const force = searchParams.get('force') === 'true';
    const { bucketKey } = await context.params;

    const deleted = await deleteFileBucket(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      bucketKey,
      { force },
    );
    if (!deleted) {
      return NextResponse.json({ error: 'Bucket not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('Delete file bucket error', { error });

    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof Error && error.message === 'Bucket contains files. Remove files or use force delete.') {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
