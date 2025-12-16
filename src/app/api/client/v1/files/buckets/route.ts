import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listFileBuckets } from '@/lib/services/files';

export const runtime = 'nodejs';

/**
 * GET /api/client/v1/files/buckets
 * List all file buckets for the tenant
 */
export async function GET(request: NextRequest) {
  try {
    const { tenantDbName, tenantId, projectId } = await requireApiToken(request);

    const buckets = await listFileBuckets(tenantDbName, tenantId, projectId);

    return NextResponse.json({
      buckets,
      count: buckets.length,
    });
  } catch (error) {
    console.error('[client-api:files:buckets:list]', error);

    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    const message = error instanceof Error ? error.message : 'Failed to list buckets';
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
