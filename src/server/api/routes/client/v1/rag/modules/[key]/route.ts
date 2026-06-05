
import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { deleteRagModule, getRagModule } from '@/lib/services/rag/ragService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-rag');

/**
 * GET /api/client/v1/rag/modules/:key
 * Get a single RAG module by key
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const ctx = await requireApiToken(request);
    const { key } = await params;
    // Tenant-wide lookup — key is unique per tenant; token auth validates tenant access
    const ragModule = await getRagModule(ctx.tenantDbName, key);

    if (!ragModule) {
      return NextResponse.json({ error: 'RAG module not found' }, { status: 404 });
    }

    return NextResponse.json({ module: ragModule });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Get RAG module error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/client/v1/rag/modules/:key
 * Delete a RAG module
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const ctx = await requireApiToken(request);
    const { key } = await params;

    // Tenant-wide lookup — key is unique per tenant; token auth validates tenant access
    const ragModule = await getRagModule(ctx.tenantDbName, key);
    if (!ragModule) {
      return NextResponse.json({ error: 'RAG module not found' }, { status: 404 });
    }

    const deleted = await deleteRagModule(ctx.tenantDbName, String(ragModule._id));
    if (!deleted) {
      return NextResponse.json({ error: 'RAG module not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Delete RAG module error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
