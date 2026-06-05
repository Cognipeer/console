import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  listRagModules,
  createRagModule,
} from '@/lib/services/rag/ragService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('rag-modules');

export async function GET(request: NextRequest) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const projectId = request.headers.get('x-project-id') ?? undefined;
  if (!tenantDbName) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') ?? undefined;
    const status = (searchParams.get('status') as 'active' | 'disabled') ?? undefined;
    const modules = await listRagModules(tenantDbName, { projectId, status, search });
    return NextResponse.json({ modules });
  } catch (error) {
    logger.error('List error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const projectId = request.headers.get('x-project-id') ?? undefined;
  const userId = request.headers.get('x-user-id') ?? 'system';
  if (!tenantDbName || !tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { name, key, description, embeddingModelKey, vectorProviderKey, vectorIndexKey, fileBucketKey, fileProviderKey, chunkConfig, metadata } = body;

    if (!name || !embeddingModelKey || !vectorProviderKey || !vectorIndexKey || !chunkConfig) {
      return NextResponse.json(
        { error: 'name, embeddingModelKey, vectorProviderKey, vectorIndexKey, and chunkConfig are required' },
        { status: 400 },
      );
    }

    const ragModule = await createRagModule(tenantDbName, tenantId, projectId, {
      name,
      key,
      description,
      embeddingModelKey,
      vectorProviderKey,
      vectorIndexKey,
      fileBucketKey,
      fileProviderKey,
      chunkConfig,
      metadata,
      createdBy: userId,
    });

    return NextResponse.json({ module: ragModule }, { status: 201 });
  } catch (error) {
    logger.error('Create error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
