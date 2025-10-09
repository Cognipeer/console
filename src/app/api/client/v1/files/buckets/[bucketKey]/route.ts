import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { getFileBucket } from '@/lib/services/files';

export const runtime = 'nodejs';

/**
 * GET /api/client/v1/files/buckets/:bucketKey
 * Get file bucket details
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

    const bucket = await getFileBucket(tenantDbName, tenantId, bucketKey);

    if (!bucket) {
      return NextResponse.json(
        { error: 'Bucket not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({ bucket });
  } catch (error) {
    console.error('[client-api:files:bucket:get]', error);

    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    const message = error instanceof Error ? error.message : 'Failed to get bucket';
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
