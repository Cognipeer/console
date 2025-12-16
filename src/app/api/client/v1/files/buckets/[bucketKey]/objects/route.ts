import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { uploadFile, listFiles } from '@/lib/services/files';
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';
import type { LicenseType } from '@/lib/license/license-manager';

export const runtime = 'nodejs';

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

/**
 * POST /api/client/v1/files/buckets/:bucketKey/objects
 * Upload a file to the specified bucket
 * 
 * Request body (JSON):
 * {
 *   "fileName": "document.pdf",
 *   "contentType": "application/pdf",
 *   "data": "base64-encoded-data or data:mime;base64,data",
 *   "metadata": { "key": "value" },
 *   "convertToMarkdown": false,
 *   "keyHint": "optional-custom-key"
 * }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bucketKey: string }> },
) {
  try {
    const { tenantDbName, tenantId, tenant, token, tokenRecord, user, projectId } =
      await requireApiToken(request);
    const { bucketKey } = await params;

    if (!bucketKey) {
      return NextResponse.json(
        { error: 'Bucket key is required' },
        { status: 400 },
      );
    }

    const body = await request.json();
    const {
      fileName,
      contentType,
      data,
      metadata,
      convertToMarkdown,
      keyHint,
    } = body;

    if (!fileName) {
      return NextResponse.json(
        { error: 'fileName is required' },
        { status: 400 },
      );
    }

    if (!data) {
      return NextResponse.json(
        { error: 'data is required (base64 or data URL)' },
        { status: 400 },
      );
    }

    const tokenId = tokenRecord._id?.toString() ?? token;
    const estimatedFileBytes = estimateBase64Bytes(data);
    const quotaContext = {
      tenantDbName,
      tenantId,
      projectId,
      licenseType: tenant.licenseType as LicenseType,
      userId: user?._id?.toString(),
      tokenId,
      domain: 'file' as const,
      resourceKey: bucketKey,
    };

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
      storageBytes: estimatedFileBytes ?? 0,
    });

    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { error: rateLimitResult.reason || 'Rate limit exceeded' },
        { status: 429 },
      );
    }

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const currentFilesTotal = await db.countFileRecords({ projectId });
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
      const currentBytes = await db.sumFileRecordBytes({ projectId });
      const projected = currentBytes + (estimatedFileBytes ?? 0);

      if (projected > storageLimit) {
        return NextResponse.json(
          { error: `storageBytes limit exceeded (${projected}/${storageLimit})` },
          { status: 429 },
        );
      }
    }

    const createdBy = user?._id?.toString() ?? 'api';

    const result = await uploadFile(tenantDbName, tenantId, projectId, {
      bucketKey,
      fileName,
      contentType,
      data,
      metadata,
      convertToMarkdown: convertToMarkdown ?? false,
      keyHint,
      createdBy,
    });

    return NextResponse.json({
      file: result.record,
      message: 'File uploaded successfully',
    }, { status: 201 });
  } catch (error) {
    console.error('[client-api:files:upload]', error);

    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    const message = error instanceof Error ? error.message : 'Failed to upload file';
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}

/**
 * GET /api/client/v1/files/buckets/:bucketKey/objects
 * List files in the specified bucket
 * 
 * Query params:
 * - search: string (optional)
 * - limit: number (optional, default 50)
 * - cursor: string (optional, for pagination)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bucketKey: string }> },
) {
  try {
    const { tenantDbName, tenantId, projectId } = await requireApiToken(request);
    const { bucketKey } = await params;

    if (!bucketKey) {
      return NextResponse.json(
        { error: 'Bucket key is required' },
        { status: 400 },
      );
    }

    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') ?? undefined;
    const limit = parseInt(searchParams.get('limit') ?? '50', 10);
    const cursor = searchParams.get('cursor') ?? undefined;

    const result = await listFiles(tenantDbName, tenantId, projectId, {
      bucketKey,
      search,
      limit,
      cursor,
    });

    return NextResponse.json({
      files: result.items,
      count: result.items.length,
      nextCursor: result.nextCursor,
    });
  } catch (error) {
    console.error('[client-api:files:list]', error);

    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    const message = error instanceof Error ? error.message : 'Failed to list files';
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
