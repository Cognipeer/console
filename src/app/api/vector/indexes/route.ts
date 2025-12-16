import { NextRequest, NextResponse } from 'next/server';
import {
  createVectorIndex,
  listVectorIndexes,
} from '@/lib/services/vector';
import { ProjectContextError, requireProjectContext } from '@/lib/services/projects/projectContext';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let projectId: string;
    try {
      const projectContext = await requireProjectContext(request, {
        tenantDbName,
        tenantId,
        userId,
      });
      projectId = projectContext.projectId;
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const { searchParams } = new URL(request.url);
    const providerKey = searchParams.get('providerKey');

    if (!providerKey) {
      return NextResponse.json(
        { error: 'providerKey query parameter is required' },
        { status: 400 },
      );
    }

    const indexes = await listVectorIndexes(
      tenantDbName,
      tenantId,
      projectId,
      providerKey,
    );

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
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const licenseType = request.headers.get('x-license-type') as LicenseType | null;

    if (!tenantDbName || !tenantId || !userId || !licenseType) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let projectId: string;
    try {
      const projectContext = await requireProjectContext(request, {
        tenantDbName,
        tenantId,
        userId,
      });
      projectId = projectContext.projectId;
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
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

    const existingIndexes = await listVectorIndexes(
      tenantDbName,
      tenantId,
      projectId,
      body.providerKey,
    );

    const normalizedName = String(body.name).trim().toLowerCase();
    const matchingIndex = existingIndexes.find(
      (item) => item.name.trim().toLowerCase() === normalizedName,
    );

    if (matchingIndex) {
      return NextResponse.json({ index: matchingIndex, reused: true }, { status: 200 });
    }

    const rateLimitResult = await checkRateLimit(
      {
        tenantDbName,
        tenantId,
        projectId,
        licenseType,
        userId,
        domain: 'vector',
        providerKey: body.providerKey,
      },
      { requests: 1 },
    );
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { error: rateLimitResult.reason || 'Rate limit exceeded' },
        { status: 429 },
      );
    }

    const resourceCheck = await checkResourceQuota(
      {
        tenantDbName,
        tenantId,
        projectId,
        licenseType,
        userId,
        domain: 'vector',
        providerKey: body.providerKey,
      },
      'vectorIndexes',
      existingIndexes.length,
    );

    if (!resourceCheck.allowed) {
      return NextResponse.json(
        { error: resourceCheck.reason || 'Vector index quota exceeded' },
        { status: 429 },
      );
    }

    const index = await createVectorIndex(tenantDbName, tenantId, projectId, {
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
