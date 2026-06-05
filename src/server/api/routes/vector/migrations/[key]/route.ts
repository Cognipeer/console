import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  getVectorMigration,
  deleteVectorMigration,
  listVectorMigrationLogs,
  countVectorMigrationLogs,
} from '@/lib/services/vector';
import { ProjectContextError, requireProjectContext } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('vector-migrations');

interface RouteContext {
  params: Promise<{ key: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { key } = await context.params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
      await requireProjectContext(request, { tenantDbName, tenantId, userId });
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const migration = await getVectorMigration(tenantDbName, key);

    if (!migration) {
      return NextResponse.json({ error: 'Migration not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const logsLimit = parseInt(searchParams.get('logsLimit') ?? '50', 10);
    const logsOffset = parseInt(searchParams.get('logsOffset') ?? '0', 10);

    const [logs, totalLogs] = await Promise.all([
      listVectorMigrationLogs(tenantDbName, key, {
        limit: logsLimit,
        offset: logsOffset,
      }),
      countVectorMigrationLogs(tenantDbName, key),
    ]);

    return NextResponse.json({ migration, logs, totalLogs }, { status: 200 });
  } catch (error) {
    logger.error('Get vector migration error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { key } = await context.params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
      await requireProjectContext(request, { tenantDbName, tenantId, userId });
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    await deleteVectorMigration(tenantDbName, key);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('Delete vector migration error', { error });
    if (error instanceof Error && error.message.includes('Cannot delete')) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message.includes('not found')) {
      return NextResponse.json({ error: 'Migration not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
