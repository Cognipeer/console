import { NextRequest, NextResponse } from 'next/server';
import { deleteVectors } from '@/lib/services/vector';
import { ProjectContextError, requireProjectContext } from '@/lib/services/projects/projectContext';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkRateLimit } from '@/lib/quota/quotaGuard';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('vector-vectors');

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

    const rateLimitResult = await checkRateLimit(quotaContext, {
      requests: 1,
      vectors: ids.length,
    });

    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { error: rateLimitResult.reason || 'Rate limit exceeded' },
        { status: 429 },
      );
    }

    await deleteVectors(tenantDbName, tenantId, projectId, {
      providerKey,
      indexExternalId: externalId,
      ids,
      updatedBy: userId,
    });

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    await db.incrementProjectVectorCountApprox(projectId, -ids.length);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('Delete vector items error', { error });
    if (isNotFoundError(error)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
