import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  createVectorMigration,
  listVectorMigrations,
} from '@/lib/services/vector';
import { ProjectContextError, requireProjectContext } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';
import type { VectorMigrationStatus } from '@/lib/database/provider/types.base';

const logger = createLogger('vector-migrations');

export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let projectId: string;
    try {
      const projectContext = await requireProjectContext(request, {
        tenantDbName,
        tenantId,
        userId,
      });
      projectId = projectContext.projectId;
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') as VectorMigrationStatus | null;

    const migrations = await listVectorMigrations(
      tenantDbName,
      projectId,
      status ?? undefined,
    );

    return NextResponse.json({ migrations }, { status: 200 });
  } catch (error) {
    logger.error('List vector migrations error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let projectId: string;
    try {
      const projectContext = await requireProjectContext(request, {
        tenantDbName,
        tenantId,
        userId,
      });
      projectId = projectContext.projectId;
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
    }

    const {
      name,
      description,
      sourceProviderKey,
      sourceIndexKey,
      destinationProviderKey,
      destinationIndexKey,
      batchSize,
    } = body as Record<string, unknown>;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!sourceProviderKey || typeof sourceProviderKey !== 'string') {
      return NextResponse.json({ error: 'sourceProviderKey is required' }, { status: 400 });
    }
    if (!sourceIndexKey || typeof sourceIndexKey !== 'string') {
      return NextResponse.json({ error: 'sourceIndexKey is required' }, { status: 400 });
    }
    if (!destinationProviderKey || typeof destinationProviderKey !== 'string') {
      return NextResponse.json({ error: 'destinationProviderKey is required' }, { status: 400 });
    }
    if (!destinationIndexKey || typeof destinationIndexKey !== 'string') {
      return NextResponse.json({ error: 'destinationIndexKey is required' }, { status: 400 });
    }

    const migration = await createVectorMigration(
      tenantDbName,
      tenantId,
      projectId,
      userId,
      {
        name: name.trim(),
        description: typeof description === 'string' ? description.trim() : undefined,
        sourceProviderKey,
        sourceIndexKey,
        destinationProviderKey,
        destinationIndexKey,
        batchSize: typeof batchSize === 'number' ? batchSize : undefined,
        createdBy: userId,
      },
    );

    return NextResponse.json({ migration }, { status: 201 });
  } catch (error) {
    logger.error('Create vector migration error', { error });
    if (error instanceof Error && (
      error.message.includes('not found') ||
      error.message.includes('cannot be the same')
    )) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
