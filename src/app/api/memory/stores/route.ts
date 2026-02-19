import { NextRequest, NextResponse } from 'next/server';
import {
  createMemoryStore,
  listMemoryStores,
} from '@/lib/services/memory/memoryService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

import type { MemoryStoreStatus } from '@/lib/database';

export const runtime = 'nodejs';

/** GET /api/memory/stores — List memory stores for dashboard */
export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const { searchParams } = request.nextUrl;
    const status = searchParams.get('status') as MemoryStoreStatus | null;
    const search = searchParams.get('search') || undefined;

    const stores = await listMemoryStores(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      { status: status || undefined, search },
    );

    return NextResponse.json({ stores });
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[dashboard:memory:stores:list]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** POST /api/memory/stores — Create memory store */
export async function POST(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const body = await request.json();

    if (!body.name || !body.vectorProviderKey || !body.embeddingModelKey) {
      return NextResponse.json(
        { error: 'name, vectorProviderKey, and embeddingModelKey are required' },
        { status: 400 },
      );
    }

    const store = await createMemoryStore(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      {
        name: body.name,
        description: body.description,
        vectorProviderKey: body.vectorProviderKey,
        embeddingModelKey: body.embeddingModelKey,
        config: body.config,
        createdBy: userId,
      },
    );

    return NextResponse.json(store, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[dashboard:memory:stores:create]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
