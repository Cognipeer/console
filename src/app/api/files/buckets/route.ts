import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import { createFileBucket, listFileBuckets } from '@/lib/services/files';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantSlug || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const buckets = await listFileBuckets(tenantDbName, tenantId);

    return NextResponse.json({ buckets }, { status: 200 });
  } catch (error) {
    console.error('List file buckets error', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantSlug || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const requiredFields = ['key', 'name', 'providerKey'];

    for (const field of requiredFields) {
      if (!body[field] || (typeof body[field] === 'string' && body[field].trim() === '')) {
        return NextResponse.json(
          { error: `${field} is required` },
          { status: 400 },
        );
      }
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const bucket = await createFileBucket(tenantDbName, tenantId, {
      key: body.key,
      name: body.name,
      providerKey: body.providerKey,
      description: body.description,
      prefix: body.prefix,
      metadata: body.metadata,
      status: body.status,
      createdBy: userId,
    });

    return NextResponse.json({ bucket }, { status: 201 });
  } catch (error) {
    console.error('Create file bucket error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
