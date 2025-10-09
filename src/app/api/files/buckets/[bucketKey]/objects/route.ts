import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import { listFiles, uploadFile } from '@/lib/services/files';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{
    bucketKey: string;
  }>;
}

function parseLimit(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.min(parsed, 200);
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantSlug || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { bucketKey } = await context.params;
    const { searchParams } = new URL(request.url);

    const limit = parseLimit(searchParams.get('limit')) ?? 50;
    const cursor = searchParams.get('cursor') ?? undefined;
    const search = searchParams.get('search') ?? undefined;

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const result = await listFiles(tenantDbName, tenantId, {
      bucketKey,
      limit,
      cursor,
      search,
    });

    return NextResponse.json({
      items: result.items,
      nextCursor: result.nextCursor,
    });
  } catch (error) {
    console.error('List file objects error', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (message === 'File bucket not found.') {
      return NextResponse.json({ error: 'Bucket not found' }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantSlug || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { bucketKey } = await context.params;
    const body = await request.json();

    if (!body.fileName || typeof body.fileName !== 'string') {
      return NextResponse.json({ error: 'fileName is required' }, { status: 400 });
    }
    if (!body.data || typeof body.data !== 'string') {
      return NextResponse.json({ error: 'data is required' }, { status: 400 });
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const result = await uploadFile(tenantDbName, tenantId, {
      bucketKey,
      providerKey: body.providerKey ?? undefined,
      fileName: body.fileName,
      contentType: body.contentType,
      data: body.data,
      metadata: body.metadata,
      createdBy: userId,
      convertToMarkdown: body.convertToMarkdown !== false,
      keyHint: body.keyHint,
    });

    return NextResponse.json({ record: result.record }, { status: 201 });
  } catch (error) {
    console.error('Upload file error', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (message === 'File bucket not found.' || message === 'File bucket is not active.') {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
