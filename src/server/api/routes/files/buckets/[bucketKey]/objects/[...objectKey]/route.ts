import { NextResponse, type NextRequest } from '@/server/api/http';
import { deleteFile, downloadFile, getFileRecord } from '@/lib/services/files';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('file-objects');

interface RouteContext {
  params: Promise<{
    bucketKey: string;
    objectKey: string[];
  }>;
}

function normalizeObjectKey(segments: string[] | undefined): string | null {
  if (!segments || segments.length === 0) {
    return null;
  }
  const joined = segments.join('/').trim();
  return joined.length > 0 ? joined : null;
}

export async function GET(request: NextRequest, context: RouteContext) {
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

    const { bucketKey, objectKey } = await context.params;
    const key = normalizeObjectKey(objectKey);
    if (!key) {
      return NextResponse.json({ error: 'Object key is required' }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const downloadParam = searchParams.get('download');
    const variantParam = searchParams.get('variant');

    if (downloadParam) {
      const variant = downloadParam === 'markdown' || variantParam === 'markdown' ? 'markdown' : 'original';
      const result = await downloadFile(
        tenantDbName,
        tenantId,
        projectContext.projectId,
        bucketKey,
        key,
        { variant },
      );

      const buffer = result.data as unknown as Uint8Array;
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;

      const headers = new Headers();
      headers.set('Content-Type', result.contentType ?? 'application/octet-stream');
      if (typeof result.size === 'number') {
        headers.set('Content-Length', String(result.size));
      }
      headers.set(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(result.fileName)}"`,
      );

      return new NextResponse(arrayBuffer, {
        status: 200,
        headers,
      });
    }

    const record = await getFileRecord(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      bucketKey,
      key,
    );

    return NextResponse.json({ record });
  } catch (error) {
    logger.error('Get file record error', { error });
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (message === 'Markdown conversion not available for this file.') {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    if (message === 'File record not found.' || message === 'File bucket not found.') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
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

    const { bucketKey, objectKey } = await context.params;
    const key = normalizeObjectKey(objectKey);
    if (!key) {
      return NextResponse.json({ error: 'Object key is required' }, { status: 400 });
    }

    const deleted = await deleteFile(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      bucketKey,
      key,
      userId,
    );

    if (!deleted) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('Delete file error', { error });
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (message === 'File record not found.') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
