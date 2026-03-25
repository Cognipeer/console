import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  createMemoryStore,
  listMemoryStores,
} from '@/lib/services/memory/memoryService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-memory');

/** GET /api/client/v1/memory/stores — List memory stores */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireApiToken(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status') as 'active' | 'inactive' | 'error' | null;
    const search = url.searchParams.get('search') ?? undefined;

    const stores = await listMemoryStores(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      { status: status ?? undefined, search },
    );

    return NextResponse.json({ stores });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('List memory stores error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** POST /api/client/v1/memory/stores — Create memory store */
export async function POST(request: NextRequest) {
  try {
    const ctx = await requireApiToken(request);
    const body = await request.json();

    if (!body.name || typeof body.name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!body.vectorProviderKey || typeof body.vectorProviderKey !== 'string') {
      return NextResponse.json({ error: 'vectorProviderKey is required' }, { status: 400 });
    }
    if (!body.embeddingModelKey || typeof body.embeddingModelKey !== 'string') {
      return NextResponse.json({ error: 'embeddingModelKey is required' }, { status: 400 });
    }

    const store = await createMemoryStore(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      {
        name: body.name,
        description: body.description,
        vectorProviderKey: body.vectorProviderKey,
        embeddingModelKey: body.embeddingModelKey,
        config: body.config,
        createdBy: ctx.user?.email ?? ctx.tokenRecord.userId,
      },
    );

    return NextResponse.json({ store }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Create memory store error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
