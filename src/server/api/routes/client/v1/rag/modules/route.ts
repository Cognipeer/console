
import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listRagModules } from '@/lib/services/rag/ragService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-rag');

/**
 * GET /api/client/v1/rag/modules
 * List RAG modules for the tenant
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireApiToken(request);
    const modules = await listRagModules(ctx.tenantDbName, {}); // tenant-wide; token auth validates tenant
    return NextResponse.json({ modules });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('List RAG modules error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
