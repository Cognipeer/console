import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { upsertVectors } from '@/lib/services/vector';
import { getDatabase } from '@/lib/database';
import { checkPerRequestLimits, checkRateLimit } from '@/lib/quota/quotaGuard';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-vector-upsert');

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{
    providerKey: string;
    externalId: string;
  }>;
}
function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return (
    normalized.includes('vector index record not found') ||
    normalized.includes('vector index metadata not found')
  );
}

function handleError(error: unknown, scope: string) {
  if (error instanceof ApiTokenAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  if (isNotFoundError(error)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  logger.error(`${scope} error`, { error });
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Internal server error' },
    { status: 500 },
  );
}

const _POST = async (request: NextRequest, context: RouteContext) => {
  try {
    const { providerKey, externalId } = await context.params;
    const indexKey = externalId;
    const auth = await requireApiToken(request);
    const body = await request.json();

    if (!Array.isArray(body.vectors) || body.vectors.length === 0) {
      return NextResponse.json(
        { error: 'vectors array is required' },
        { status: 400 },
      );
    }

    const invalidEntry = body.vectors.find(
      (entry: Record<string, unknown>) =>
        typeof entry?.id !== 'string' || !Array.isArray(entry?.values),
    );

    if (invalidEntry) {
      return NextResponse.json(
        { error: 'Each vector must include an id and values array.' },
        { status: 400 },
      );
    }

    const vectorCount = body.vectors.length as number;
    const firstVector = body.vectors[0];
    const vectorDimensions = Array.isArray(firstVector?.values)
      ? firstVector.values.length
      : undefined;

    const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
    const quotaResult = await checkPerRequestLimits(
      {
        tenantDbName: auth.tenantDbName,
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        licenseType: auth.tenant.licenseType as LicenseType,
        userId: auth.tokenRecord.userId,
        tokenId,
        domain: 'vector',
        providerKey,
        resourceKey: indexKey,
      },
      {
        vectorCount,
        vectorDimensions,
      },
    );

    if (!quotaResult.allowed) {
      return NextResponse.json(
        { error: quotaResult.reason || 'Quota exceeded' },
        { status: 429 },
      );
    }

    const rateLimitResult = await checkRateLimit(
      {
        tenantDbName: auth.tenantDbName,
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        licenseType: auth.tenant.licenseType as LicenseType,
        userId: auth.tokenRecord.userId,
        tokenId,
        domain: 'vector',
        providerKey,
        resourceKey: indexKey,
      },
      {
        requests: 1,
        vectors: vectorCount,
      },
    );

    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { error: rateLimitResult.reason || 'Rate limit exceeded' },
        { status: 429 },
      );
    }

    const maxVectorsTotal = quotaResult.effectiveLimits.quotas?.maxVectorsTotal;
    const db = await getDatabase();
    await db.switchToTenant(auth.tenantDbName);

    if (maxVectorsTotal !== undefined && maxVectorsTotal !== -1) {
      const currentApprox = await db.getProjectVectorCountApprox(auth.projectId);
      const projected = currentApprox + vectorCount;
      if (projected > maxVectorsTotal) {
        return NextResponse.json(
          { error: `vectorsTotal limit exceeded (${projected}/${maxVectorsTotal})` },
          { status: 429 },
        );
      }
    }

    await upsertVectors(auth.tenantDbName, auth.tenantId, auth.projectId, {
      providerKey,
      indexKey,
      vectors: body.vectors,
      updatedBy: auth.tokenRecord.userId,
    });

    await db.incrementProjectVectorCountApprox(auth.projectId, vectorCount);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client upsert vectors');
  }
};

export const POST = withRequestContext(_POST);
