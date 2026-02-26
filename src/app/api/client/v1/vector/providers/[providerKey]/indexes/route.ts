import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  createVectorIndex,
  listVectorIndexes,
  type VectorIndexRecord,
} from '@/lib/services/vector';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-vector-indexes');

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{
    providerKey: string;
  }>;
}

function handleError(error: unknown, scope: string) {
  if (error instanceof ApiTokenAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  logger.error(`${scope} error`, { error });
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Internal server error' },
    { status: 500 },
  );
}

function serializeIndex(index: VectorIndexRecord) {
  return {
    ...index,
    metadata: index.metadata ?? {},
    indexId: index.key,
  };
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { providerKey } = await context.params;
    const { tenantId, tenantDbName, projectId } = await requireApiToken(request);

    const indexes = await listVectorIndexes(
      tenantDbName,
      tenantId,
      projectId,
      providerKey,
    );

    return NextResponse.json(
      { indexes: indexes.map(serializeIndex) },
      { status: 200 },
    );
  } catch (error) {
    return handleError(error, 'Client list vector indexes');
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { providerKey } = await context.params;
    const auth = await requireApiToken(request);
    const body = await request.json();

    const required = ['name', 'dimension'];
    for (const field of required) {
      if (body[field] === undefined || body[field] === null || body[field] === '') {
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
      auth.tenantDbName,
      auth.tenantId,
      auth.projectId,
      providerKey,
    );

    const normalizedName = String(body.name).trim().toLowerCase();
    const matchingIndex = existingIndexes.find(
      (item) => item.name.trim().toLowerCase() === normalizedName,
    );

    if (matchingIndex) {
      return NextResponse.json(
        { index: serializeIndex(matchingIndex), reused: true },
        { status: 200 },
      );
    }

    const rateLimitResult = await checkRateLimit(
      {
        tenantDbName: auth.tenantDbName,
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        licenseType: auth.tenant.licenseType as LicenseType,
        userId: auth.tokenRecord.userId,
        tokenId: auth.tokenRecord._id?.toString() ?? auth.token,
        domain: 'vector',
        providerKey,
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
        tenantDbName: auth.tenantDbName,
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        licenseType: auth.tenant.licenseType as LicenseType,
        userId: auth.tokenRecord.userId,
        tokenId: auth.tokenRecord._id?.toString() ?? auth.token,
        domain: 'vector',
        providerKey,
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

    const index = await createVectorIndex(
      auth.tenantDbName,
      auth.tenantId,
      auth.projectId,
      {
      providerKey,
      name: body.name,
      dimension: dimensionValue,
      metric: body.metric,
      metadata: body.metadata,
      createdBy: auth.tokenRecord.userId,
      },
    );

    return NextResponse.json({ index: serializeIndex(index) }, { status: 201 });
  } catch (error) {
    return handleError(error, 'Client create vector index');
  }
}
