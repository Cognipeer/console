import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import {
  createVectorIndex,
  listVectorIndexes,
} from '@/lib/services/vector';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantSlug || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const providerKey = searchParams.get('providerKey');

    if (!providerKey) {
      return NextResponse.json(
        { error: 'providerKey query parameter is required' },
        { status: 400 },
      );
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const indexes = await listVectorIndexes(tenantDbName, tenantId, providerKey);

    return NextResponse.json({ indexes }, { status: 200 });
  } catch (error) {
    console.error('List vector indexes error', error);
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
    const required = ['providerKey', 'name'];
    for (const field of required) {
      if (!body[field]) {
        return NextResponse.json(
          { error: `${field} is required` },
          { status: 400 },
        );
      }
    }

    const dimensionValue =
      typeof body.dimension === 'number'
        ? body.dimension
        : Number.parseInt(body.dimension, 10);

    if (!dimensionValue || Number.isNaN(dimensionValue) || dimensionValue <= 0) {
      return NextResponse.json(
        { error: 'dimension must be a positive number' },
        { status: 400 },
      );
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);

    const existingIndexes = await listVectorIndexes(
      tenantDbName,
      tenantId,
      body.providerKey,
    );

    const normalizedName = String(body.name).trim().toLowerCase();
    const matchingIndex = existingIndexes.find(
      (item) => item.name.trim().toLowerCase() === normalizedName,
    );

    if (matchingIndex) {
      return NextResponse.json({ index: matchingIndex, reused: true }, { status: 200 });
    }

    const index = await createVectorIndex(tenantDbName, tenantId, {
      providerKey: body.providerKey,
      name: body.name,
      dimension: dimensionValue,
      metric: body.metric,
      metadata: body.metadata,
      createdBy: userId,
    });

    return NextResponse.json({ index }, { status: 201 });
  } catch (error) {
    console.error('Create vector index error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
