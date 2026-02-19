export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listRagModules } from '@/lib/services/rag/ragService';

/**
 * GET /api/client/v1/rag/modules
 * List RAG modules for the tenant
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireApiToken(request);
    const modules = await listRagModules(ctx.tenantDbName, { projectId: ctx.projectId });
    return NextResponse.json({ modules });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[client/rag/modules]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
