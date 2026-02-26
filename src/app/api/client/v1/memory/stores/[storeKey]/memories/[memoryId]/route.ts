import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { updateMemoryItem, deleteMemoryItem, getMemoryItem } from '@/lib/services/memory/memoryService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-memory');

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ storeKey: string; memoryId: string }>;
}

/** GET /api/client/v1/memory/stores/:storeKey/memories/:memoryId */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await requireApiToken(request);
    const { memoryId } = await params;

    const item = await getMemoryItem(ctx.tenantDbName, memoryId);

    return NextResponse.json(item);
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Get memory item error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** PATCH /api/client/v1/memory/stores/:storeKey/memories/:memoryId */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await requireApiToken(request);
    const { storeKey, memoryId } = await params;
    const body = await request.json();

    const allowedFields = ['content', 'metadata', 'tags', 'importance', 'status'];
    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const updated = await updateMemoryItem(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      storeKey,
      memoryId,
      updates,
    );

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Update memory item error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** DELETE /api/client/v1/memory/stores/:storeKey/memories/:memoryId */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await requireApiToken(request);
    const { storeKey, memoryId } = await params;

    await deleteMemoryItem(ctx.tenantDbName, ctx.tenantId, ctx.projectId, storeKey, memoryId);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Delete memory item error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
