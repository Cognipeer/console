import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import { deleteFileBucket, getFileBucket } from '@/lib/services/files';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, context: { params: Promise<{ bucketKey: string }> }) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantSlug || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { bucketKey } = await context.params;
    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const bucket = await getFileBucket(tenantDbName, tenantId, bucketKey);

    return NextResponse.json({ bucket }, { status: 200 });
  } catch (error) {
    console.error('Get file bucket error', error);

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
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantSlug || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const force = searchParams.get('force') === 'true';
    const { bucketKey } = await context.params;
    const { tenantDbName } = await resolveTenantDbName(tenantSlug);

    const deleted = await deleteFileBucket(tenantDbName, tenantId, bucketKey, { force });
    if (!deleted) {
      return NextResponse.json({ error: 'Bucket not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('Delete file bucket error', error);

    if (error instanceof Error && error.message === 'Bucket contains files. Remove files or use force delete.') {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
