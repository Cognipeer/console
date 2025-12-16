import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { getFileRecord, deleteFile } from '@/lib/services/files';

export const runtime = 'nodejs';

/**
 * GET /api/client/v1/files/buckets/:bucketKey/objects/:objectKey
 * Get file details/metadata
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bucketKey: string; objectKey: string }> },
) {
  try {
    const { tenantDbName, tenantId, projectId } = await requireApiToken(request);
    const { bucketKey, objectKey } = await params;

    if (!bucketKey || !objectKey) {
      return NextResponse.json(
        { error: 'Bucket key and object key are required' },
        { status: 400 },
      );
    }

    const file = await getFileRecord(tenantDbName, tenantId, projectId, bucketKey, objectKey);

    if (!file) {
      return NextResponse.json(
        { error: 'File not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({ file });
  } catch (error) {
    console.error('[client-api:files:get]', error);

    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    const message = error instanceof Error ? error.message : 'Failed to get file';
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/client/v1/files/buckets/:bucketKey/objects/:objectKey
 * Delete a file from the bucket
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ bucketKey: string; objectKey: string }> },
) {
  try {
    const { tenantDbName, tenantId, projectId, user } = await requireApiToken(request);
    const { bucketKey, objectKey } = await params;

    if (!bucketKey || !objectKey) {
      return NextResponse.json(
        { error: 'Bucket key and object key are required' },
        { status: 400 },
      );
    }

    const deletedBy = user?._id?.toString() ?? 'api';

    await deleteFile(tenantDbName, tenantId, projectId, bucketKey, objectKey, deletedBy);

    return NextResponse.json({
      message: 'File deleted successfully',
      bucketKey,
      objectKey,
    });
  } catch (error) {
    console.error('[client-api:files:delete]', error);

    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    const message = error instanceof Error ? error.message : 'Failed to delete file';
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
