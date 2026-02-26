import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { searchMemories } from '@/lib/services/memory/memoryService';
import type { MemorySearchRequest } from '@/lib/services/memory/types';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-memory');

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ storeKey: string }>;
}

/** POST /api/client/v1/memory/stores/:storeKey/search — Semantic search */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await requireApiToken(request);
    const { storeKey } = await params;
    const body = await request.json();

    if (!body.query || typeof body.query !== 'string') {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const searchReq: MemorySearchRequest = {
      query: body.query,
      topK: body.topK ?? body.top_k ?? 10,
      minScore: body.minScore ?? body.min_score,
      scope: body.scope,
      scopeId: body.scopeId ?? body.scope_id,
      tags: body.tags,
    };

    const result = await searchMemories(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      storeKey,
      searchReq,
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Memory search error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
