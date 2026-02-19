import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  getMemoryStore,
  updateMemoryStore,
  deleteMemoryStore,
} from '@/lib/services/memory/memoryService';

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ storeKey: string }>;
}

/** GET /api/client/v1/memory/stores/:storeKey — Get store details */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await requireApiToken(request);
    const { storeKey } = await params;

    const store = await getMemoryStore(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      storeKey,
    );

    return NextResponse.json({ store });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const msg = error instanceof Error ? error.message : 'Internal server error';
    const status = msg.includes('not found') ? 404 : 500;
    console.error('[memory:stores:get]', error);
    return NextResponse.json({ error: msg }, { status });
  }
}

/** PATCH /api/client/v1/memory/stores/:storeKey — Update store */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await requireApiToken(request);
    const { storeKey } = await params;
    const body = await request.json();

    const store = await updateMemoryStore(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      storeKey,
      {
        name: body.name,
        description: body.description,
        config: body.config,
        status: body.status,
        updatedBy: ctx.user?.email ?? ctx.tokenRecord.userId,
      },
    );

    return NextResponse.json({ store });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[memory:stores:update]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** DELETE /api/client/v1/memory/stores/:storeKey — Delete store */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await requireApiToken(request);
    const { storeKey } = await params;

    await deleteMemoryStore(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      storeKey,
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[memory:stores:delete]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
