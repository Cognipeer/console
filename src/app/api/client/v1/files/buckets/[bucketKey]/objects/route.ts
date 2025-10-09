import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { uploadFile, listFiles } from '@/lib/services/files';

export const runtime = 'nodejs';

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
    const { tenantDbName, tenantId, user } = await requireApiToken(request);
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

    const createdBy = user?._id?.toString() ?? 'api';

    const result = await uploadFile(tenantDbName, tenantId, {
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
    const { tenantDbName, tenantId } = await requireApiToken(request);
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

    const result = await listFiles(tenantDbName, tenantId, {
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
