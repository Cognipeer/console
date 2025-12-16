import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { downloadFile } from '@/lib/services/files';

export const runtime = 'nodejs';

/**
 * GET /api/client/v1/files/buckets/:bucketKey/objects/:objectKey/download
 * Download a file from the bucket
 * 
 * Query params:
 * - variant: 'original' | 'markdown' (optional, default 'original')
 * 
 * Returns the file content with appropriate headers for download
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

    const { searchParams } = new URL(request.url);
    const variant = (searchParams.get('variant') ?? 'original') as 'original' | 'markdown';

    if (variant !== 'original' && variant !== 'markdown') {
      return NextResponse.json(
        { error: 'Invalid variant. Must be "original" or "markdown"' },
        { status: 400 },
      );
    }

    const result = await downloadFile(
      tenantDbName,
      tenantId,
      projectId,
      bucketKey,
      objectKey,
      { variant },
    );

    // Set appropriate headers for file download
    const headers = new Headers();
    headers.set('Content-Type', result.contentType ?? 'application/octet-stream');
    headers.set('Content-Length', (result.size ?? result.data.length).toString());
    headers.set(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(result.fileName)}"`,
    );

    if (result.etag) {
      headers.set('ETag', result.etag);
    }

    // Add metadata as custom headers if present
    if (result.metadata) {
      try {
        headers.set('X-File-Metadata', JSON.stringify(result.metadata));
      } catch (error) {
        console.warn('[client-api:files:download] Failed to serialize metadata', error);
      }
    }

    // Convert Buffer to Uint8Array for NextResponse
    const uint8Array = new Uint8Array(result.data);
    
    return new NextResponse(uint8Array, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error('[client-api:files:download]', error);

    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    const message = error instanceof Error ? error.message : 'Failed to download file';
    
    // Check for specific error messages
    if (message.includes('not found') || message.includes('does not exist')) {
      return NextResponse.json(
        { error: 'File not found' },
        { status: 404 },
      );
    }

    if (message.includes('markdown not available') || message.includes('conversion')) {
      return NextResponse.json(
        { error: message },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
