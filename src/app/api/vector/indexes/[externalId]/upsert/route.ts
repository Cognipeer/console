import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import { upsertVectors } from '@/lib/services/vector';

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

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { externalId } = await context.params;
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantSlug || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const providerKey = requireProviderKey(request.url);
    if (!providerKey) {
      return NextResponse.json(
        { error: 'providerKey query parameter is required' },
        { status: 400 },
      );
    }

    const body = await request.json();
    if (!Array.isArray(body.vectors) || body.vectors.length === 0) {
      return NextResponse.json(
        { error: 'vectors array is required' },
        { status: 400 },
      );
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    await upsertVectors(tenantDbName, tenantId, {
      providerKey,
      indexExternalId: externalId,
      vectors: body.vectors,
      updatedBy: userId ?? undefined,
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('Upsert vectors error', error);
    if (isNotFoundError(error)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
