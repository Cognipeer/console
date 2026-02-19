import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { recallForChat } from '@/lib/services/memory/memoryService';
import type { MemoryRecallRequest } from '@/lib/services/memory/types';

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ storeKey: string }>;
}

/** POST /api/client/v1/memory/stores/:storeKey/recall — Context-aware recall for chat */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await requireApiToken(request);
    const { storeKey } = await params;
    const body = await request.json();

    if (!body.query || typeof body.query !== 'string') {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const recallReq: MemoryRecallRequest = {
      query: body.query,
      topK: body.topK ?? body.top_k ?? 5,
      maxTokens: body.maxTokens ?? body.max_tokens ?? 2000,
      scope: body.scope,
      scopeId: body.scopeId ?? body.scope_id,
    };

    const result = await recallForChat(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      storeKey,
      recallReq,
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[memory:recall]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
