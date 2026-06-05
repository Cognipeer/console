import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  listConfigItems,
} from '@/lib/services/config/configService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('config-items');

/** GET /api/config/items — List all config items (flat, across all groups) */
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
    const groupId = searchParams.get('groupId') || undefined;
    const isSecret = searchParams.get('isSecret');
    const search = searchParams.get('search') || undefined;
    const tagsParam = searchParams.get('tags');
    const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()) : undefined;

    const items = await listConfigItems(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      {
        groupId,
        isSecret: isSecret !== null ? isSecret === 'true' : undefined,
        tags,
        search,
      },
    );

    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('List config items error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

