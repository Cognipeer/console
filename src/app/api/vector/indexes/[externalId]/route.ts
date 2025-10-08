import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import {
  deleteVectorIndex,
  getVectorIndex,
  updateVectorIndex,
} from '@/lib/services/vector';

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
  return (
    normalized.includes('vector index metadata not found') ||
    normalized.includes('vector provider configuration not found')
  );
}

interface RouteContext {
  params: Promise<{
    externalId: string;
  }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
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

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const { index, provider } = await getVectorIndex(
      tenantDbName,
      tenantId,
      providerKey,
      externalId,
    );

    return NextResponse.json({ index, provider }, { status: 200 });
  } catch (error) {
    console.error('Get vector index error', error);
    if (isNotFoundError(error)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
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

    const body = await request.json();
    if (body.name !== undefined && typeof body.name !== 'string') {
      return NextResponse.json(
        { error: 'name must be a string when provided' },
        { status: 400 },
      );
    }

    if (body.metadata !== undefined && typeof body.metadata !== 'object') {
      return NextResponse.json(
        { error: 'metadata must be an object when provided' },
        { status: 400 },
      );
    }

    if (body.name === undefined && body.metadata === undefined) {
      return NextResponse.json(
        { error: 'Provide a field to update' },
        { status: 400 },
      );
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const index = await updateVectorIndex(
      tenantDbName,
      tenantId,
      providerKey,
      externalId,
      {
        name: body.name,
        metadata: body.metadata,
        updatedBy: userId,
      },
    );

    return NextResponse.json({ index }, { status: 200 });
  } catch (error) {
    console.error('Update vector index error', error);
    if (isNotFoundError(error)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
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

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    await deleteVectorIndex(
      tenantDbName,
      tenantId,
      providerKey,
      externalId,
      { updatedBy: userId },
    );

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('Delete vector index error', error);
    if (isNotFoundError(error)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
