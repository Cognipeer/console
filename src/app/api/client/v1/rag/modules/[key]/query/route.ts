export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { queryRag } from '@/lib/services/rag/ragService';

/**
 * POST /api/client/v1/rag/modules/:key/query
 * Query a RAG module
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const ctx = await requireApiToken(request);
    const { key } = await params;
    const body = await request.json();
    const { query, topK, filter } = body;

    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const result = await queryRag(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
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
    console.error('[client/rag/query]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
