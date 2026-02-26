import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  addMemory,
  listMemoryItems,
  deleteMemoryItemsBulk,
} from '@/lib/services/memory/memoryService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-memory');

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ storeKey: string }>;
}

/** GET /api/client/v1/memory/stores/:storeKey/memories — List memories */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await requireApiToken(request);
    const { storeKey } = await params;
    const url = new URL(request.url);

    const result = await listMemoryItems(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      storeKey,
      {
        scope: (url.searchParams.get('scope') as 'user' | 'agent' | 'session' | 'global') ?? undefined,
        scopeId: url.searchParams.get('scopeId') ?? undefined,
        tags: url.searchParams.get('tags')?.split(',').filter(Boolean),
        status: (url.searchParams.get('status') as 'active' | 'archived' | 'expired') ?? undefined,
        search: url.searchParams.get('search') ?? undefined,
        limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!) : undefined,
        skip: url.searchParams.get('skip') ? parseInt(url.searchParams.get('skip')!) : undefined,
      },
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('List memory items error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** POST /api/client/v1/memory/stores/:storeKey/memories — Add memory */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await requireApiToken(request);
    const { storeKey } = await params;
    const body = await request.json();

    if (!body.content || typeof body.content !== 'string') {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }

    const item = await addMemory(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      storeKey,
      {
        content: body.content,
        scope: body.scope,
        scopeId: body.scopeId,
        metadata: body.metadata,
        tags: body.tags,
        source: body.source,
        importance: body.importance,
      },
    );

    return NextResponse.json({ memory: item }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Add memory item error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** DELETE /api/client/v1/memory/stores/:storeKey/memories — Bulk delete */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await requireApiToken(request);
    const { storeKey } = await params;
    const url = new URL(request.url);

    const deleted = await deleteMemoryItemsBulk(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      storeKey,
      {
        scope: (url.searchParams.get('scope') as 'user' | 'agent' | 'session' | 'global') ?? undefined,
        scopeId: url.searchParams.get('scopeId') ?? undefined,
        tags: url.searchParams.get('tags')?.split(',').filter(Boolean),
      },
    );

    return NextResponse.json({ deleted });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Bulk delete memory items error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
