import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { queryVectorIndex } from '@/lib/services/vector';
import { checkPerRequestLimits, checkRateLimit } from '@/lib/quota/quotaGuard';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-vector-query');

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

    const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
    const vectorDimensions = Array.isArray(body.query?.vector)
      ? body.query.vector.length
      : undefined;
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
        queryResults: topK,
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
      },
    );

    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { error: rateLimitResult.reason || 'Rate limit exceeded' },
        { status: 429 },
      );
    }

    const result = await queryVectorIndex(
      auth.tenantDbName,
      auth.tenantId,
      auth.projectId,
      {
        providerKey,
        indexKey,
        query: {
          topK,
          vector: body.query.vector,
          filter: body.query.filter,
        },
      },
    );

    return NextResponse.json({ result }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client query vector index');
  }
};

export const POST = withRequestContext(_POST);
