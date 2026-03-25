
import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { queryRag } from '@/lib/services/rag/ragService';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-rag');

/**
 * POST /api/client/v1/rag/modules/:key/query
 * Query a RAG module
 */
const _POST = async (
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) => {
  try {
    const ctx = await requireApiToken(request);
    const { key } = await params;
    const body = await request.json();
    const { query, topK, filter } = body;

    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    // Pass undefined for projectId so the module is resolved tenant-wide by key.
    // The key is unique within a tenant; client tokens authenticate at tenant level.
    const result = await queryRag(
      ctx.tenantDbName,
      ctx.tenantId,
      undefined,
      {
        ragModuleKey: key,
        query,
        topK,
        filter,
      },
    );

    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('RAG query error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
};

export const POST = withRequestContext(_POST);
