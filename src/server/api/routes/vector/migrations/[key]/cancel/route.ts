import { NextResponse, type NextRequest } from '@/server/api/http';
import { cancelVectorMigration } from '@/lib/services/vector';
import { ProjectContextError, requireProjectContext } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('vector-migrations');

interface RouteContext {
  params: Promise<{ key: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
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

    const migration = await cancelVectorMigration(tenantDbName, key);

    return NextResponse.json({ migration }, { status: 200 });
  } catch (error) {
    logger.error('Cancel vector migration error', { error });
    if (error instanceof Error && error.message.includes('not found')) {
      return NextResponse.json({ error: 'Migration not found' }, { status: 404 });
    }
    if (error instanceof Error && error.message.includes('not running')) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
