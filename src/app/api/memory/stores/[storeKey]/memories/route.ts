import { NextRequest, NextResponse } from 'next/server';
import {
  listMemoryItems,
  searchMemories,
} from '@/lib/services/memory/memoryService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

import type { MemoryScope } from '@/lib/database';

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ storeKey: string }>;
}

/** GET /api/memory/stores/:storeKey/memories — List + search memories for dashboard */
export async function GET(request: NextRequest, { params }: RouteParams) {
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
    const { storeKey } = await params;
    const { searchParams } = request.nextUrl;

    const query = searchParams.get('query');
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const scope = searchParams.get('scope') || undefined;
    const scopeId = searchParams.get('scopeId') || undefined;

    // If query param present → semantic search
    if (query) {
      const result = await searchMemories(
        tenantDbName,
        tenantId,
        projectContext.projectId,
        storeKey,
        {
          query,
          topK: limit,
          scope: scope as MemoryScope | undefined,
          scopeId,
        },
      );
      return NextResponse.json(result);
    }

    // Otherwise → paginated list
    const result = await listMemoryItems(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      storeKey,
      {
        scope: scope as MemoryScope | undefined,
        scopeId,
        skip: (page - 1) * limit,
        limit,
      },
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[dashboard:memory:memories:list]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
