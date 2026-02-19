export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listRagDocuments } from '@/lib/services/rag/ragService';

/**
 * GET /api/client/v1/rag/modules/:key/documents
 * List documents in a RAG module
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const ctx = await requireApiToken(request);
    const { key } = await params;

    const documents = await listRagDocuments(ctx.tenantDbName, key, {
      projectId: ctx.projectId,
    });

    return NextResponse.json({ documents });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[client/rag/documents]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
