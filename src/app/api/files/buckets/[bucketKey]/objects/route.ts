import { NextRequest, NextResponse } from 'next/server';
import { listFiles, uploadFile } from '@/lib/services/files';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('file-objects');

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{
    bucketKey: string;
  }>;
}

function parseLimit(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.min(parsed, 200);
}

function estimateBase64Bytes(input: unknown): number | undefined {
  if (typeof input !== 'string') return undefined;
  const base64 = input.includes('base64,') ? input.split('base64,').pop() ?? '' : input;
  if (!base64) return 0;

  const normalized = base64.replace(/\s/g, '');
  const paddingMatch = normalized.match(/=+$/);
  const padding = paddingMatch ? paddingMatch[0].length : 0;
  const bytes = Math.floor((normalized.length * 3) / 4) - padding;
  return bytes > 0 ? bytes : 0;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const { bucketKey } = await context.params;
    const { searchParams } = new URL(request.url);

    const limit = parseLimit(searchParams.get('limit')) ?? 50;
    const cursor = searchParams.get('cursor') ?? undefined;
    const search = searchParams.get('search') ?? undefined;

    const scoped = await listFiles(tenantDbName, tenantId, projectContext.projectId, {
      bucketKey,
      limit,
      cursor,
      search,
    });

    return NextResponse.json({
      items: scoped.items,
      nextCursor: scoped.nextCursor,
    });
  } catch (error) {
    logger.error('List file objects error', { error });
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (message === 'File bucket not found.') {
      return NextResponse.json({ error: 'Bucket not found' }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const licenseType = request.headers.get('x-license-type') as LicenseType | null;

    if (!tenantDbName || !tenantId || !userId || !licenseType) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const { bucketKey } = await context.params;
    const body = await request.json();

    if (!body.fileName || typeof body.fileName !== 'string') {
      return NextResponse.json({ error: 'fileName is required' }, { status: 400 });
    }
    if (!body.data || typeof body.data !== 'string') {
      return NextResponse.json({ error: 'data is required' }, { status: 400 });
    }

    const quotaContext = {
      tenantDbName,
      tenantId,
      projectId: projectContext.projectId,
      licenseType,
      userId,
      domain: 'file' as const,
      providerKey: body.providerKey ?? undefined,
      resourceKey: bucketKey,
    };

    const estimatedFileBytes = estimateBase64Bytes(body.data) ?? 0;
    const quotaResult = await checkPerRequestLimits(quotaContext, {
      fileSize: estimatedFileBytes,
      filesPerRequest: 1,
    });
    if (!quotaResult.allowed) {
      return NextResponse.json(
        { error: quotaResult.reason || 'Quota exceeded' },
        { status: 429 },
      );
    }

    const rateLimitResult = await checkRateLimit(quotaContext, {
      requests: 1,
      files: 1,
      storageBytes: estimatedFileBytes,
    });
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { error: rateLimitResult.reason || 'Rate limit exceeded' },
        { status: 429 },
      );
    }

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const currentFilesTotal = await db.countFileRecords({ projectId: projectContext.projectId });
    const resourceCheck = await checkResourceQuota(
      quotaContext,
      'filesTotal',
      currentFilesTotal,
    );

    if (!resourceCheck.allowed) {
      return NextResponse.json(
        { error: resourceCheck.reason || 'File quota exceeded' },
        { status: 429 },
      );
    }

    const storageLimit = quotaResult.effectiveLimits.quotas?.maxStorageBytes;
    if (storageLimit !== undefined && storageLimit !== -1) {
      const currentBytes = await db.sumFileRecordBytes({ projectId: projectContext.projectId });
      const projected = currentBytes + estimatedFileBytes;
      if (projected > storageLimit) {
        return NextResponse.json(
          { error: `storageBytes limit exceeded (${projected}/${storageLimit})` },
          { status: 429 },
        );
      }
    }

    const result = await uploadFile(tenantDbName, tenantId, projectContext.projectId, {
      bucketKey,
      providerKey: body.providerKey ?? undefined,
      fileName: body.fileName,
      contentType: body.contentType,
      data: body.data,
      metadata: body.metadata,
      createdBy: userId,
      convertToMarkdown: body.convertToMarkdown !== false,
      keyHint: body.keyHint,
    });

    return NextResponse.json({ record: result.record }, { status: 201 });
  } catch (error) {
    logger.error('Upload file error', { error });
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (message === 'File bucket not found.' || message === 'File bucket is not active.') {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
