import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { addMemoryBatch } from '@/lib/services/memory/memoryService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-memory');

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ storeKey: string }>;
}

/** POST /api/client/v1/memory/stores/:storeKey/memories/batch — Batch add */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await requireApiToken(request);
    const { storeKey } = await params;
    const body = await request.json();

    if (!Array.isArray(body.memories) || body.memories.length === 0) {
      return NextResponse.json({ error: 'memories array is required' }, { status: 400 });
    }

    if (body.memories.length > 100) {
      return NextResponse.json(
        { error: 'Maximum batch size is 100' },
        { status: 400 },
      );
    }

    for (const mem of body.memories) {
      if (!mem.content || typeof mem.content !== 'string') {
        return NextResponse.json(
          { error: 'Each memory must have a content field' },
          { status: 400 },
        );
      }
    }

    const result = await addMemoryBatch(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      storeKey,
      body.memories,
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Batch add memory items error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
