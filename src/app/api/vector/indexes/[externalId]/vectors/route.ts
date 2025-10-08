import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import { deleteVectors } from '@/lib/services/vector';

export const runtime = 'nodejs';

function requireProviderKey(url: string): string | null {
  const { searchParams } = new URL(url);
  return searchParams.get('providerKey');
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return normalized.includes('vector index metadata not found');
}

interface RouteContext {
  params: Promise<{
    externalId: string;
  }>;
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { externalId } = await context.params;
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantSlug || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const providerKey = requireProviderKey(request.url);
    if (!providerKey) {
      return NextResponse.json(
        { error: 'providerKey query parameter is required' },
        { status: 400 },
      );
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Request body must be valid JSON' },
        { status: 400 },
      );
    }

    const ids = Array.isArray((payload as Record<string, unknown>)?.ids)
      ? (payload as { ids: unknown[] }).ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];

    if (ids.length === 0) {
      return NextResponse.json(
        { error: 'ids array is required' },
        { status: 400 },
      );
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    await deleteVectors(tenantDbName, tenantId, {
      providerKey,
      indexExternalId: externalId,
      ids,
      updatedBy: userId,
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('Delete vector items error', error);
    if (isNotFoundError(error)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
