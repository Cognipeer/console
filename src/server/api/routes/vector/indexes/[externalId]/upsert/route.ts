import { NextResponse, type NextRequest } from '@/server/api/http';
import { upsertVectors } from '@/lib/services/vector';
import { ProjectContextError, requireProjectContext } from '@/lib/services/projects/projectContext';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkPerRequestLimits, checkRateLimit } from '@/lib/quota/quotaGuard';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('vector-upsert');

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

    const quotaContext = {
      tenantDbName,
      tenantId,
      projectId,
      licenseType,
      userId,
      domain: 'vector' as const,
      providerKey,
      resourceKey: externalId,
    };

    const quotaResult = await checkPerRequestLimits(quotaContext, {
      vectorCount,
      vectorDimensions,
    });

    if (!quotaResult.allowed) {
      return NextResponse.json(
        { error: quotaResult.reason || 'Quota exceeded' },
        { status: 429 },
      );
    }

    const rateLimitResult = await checkRateLimit(quotaContext, {
      requests: 1,
      vectors: vectorCount,
    });

    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { error: rateLimitResult.reason || 'Rate limit exceeded' },
        { status: 429 },
      );
    }

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const maxVectorsTotal = quotaResult.effectiveLimits.quotas?.maxVectorsTotal;
    if (maxVectorsTotal !== undefined && maxVectorsTotal !== -1) {
      const currentApprox = await db.getProjectVectorCountApprox(projectId);
      const projected = currentApprox + vectorCount;
      if (projected > maxVectorsTotal) {
        return NextResponse.json(
          { error: `vectorsTotal limit exceeded (${projected}/${maxVectorsTotal})` },
          { status: 429 },
        );
      }
    }

    await upsertVectors(tenantDbName, tenantId, projectId, {
      providerKey,
      indexExternalId: externalId,
      indexKey: externalId,
      vectors: body.vectors,
      updatedBy: userId,
    });

    await db.incrementProjectVectorCountApprox(projectId, vectorCount);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('Upsert vectors error', { error });
    if (isNotFoundError(error)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
