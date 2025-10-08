import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import { queryVectorIndex } from '@/lib/services/vector';

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

    if (!Array.isArray(body.query?.vector)) {
      return NextResponse.json(
        { error: 'query.vector array is required' },
        { status: 400 },
      );
    }

    const topK = body.query?.topK ?? 5;
    if (typeof topK !== 'number' || topK <= 0) {
      return NextResponse.json(
        { error: 'query.topK must be a positive number' },
        { status: 400 },
      );
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const result = await queryVectorIndex(tenantDbName, tenantId, {
      providerKey,
      indexExternalId: externalId,
      query: {
        topK,
        vector: body.query.vector,
        filter: body.query.filter,
      },
    });

    return NextResponse.json({ result }, { status: 200 });
  } catch (error) {
    console.error('Query vector index error', error);
    if (isNotFoundError(error)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
