import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  createConfigItem,
  listConfigItems,
} from '@/lib/services/config/configService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('config-group-items');

/** GET /api/config/groups/[groupId]/items — List items in a group */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await params;
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
    logger.error('List group items error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** POST /api/config/groups/[groupId]/items — Create item in a group */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const userEmail = request.headers.get('x-user-email');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const body = await request.json();

    if (!body.name || typeof body.name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (body.value === undefined || body.value === null) {
      return NextResponse.json({ error: 'value is required' }, { status: 400 });
    }

    const item = await createConfigItem(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      groupId,
      {
        key: body.key,
        name: body.name,
        description: body.description,
        value: String(body.value),
        valueType: body.valueType,
        isSecret: body.isSecret,
        tags: body.tags,
        metadata: body.metadata,
        createdBy: userEmail || userId,
      },
    );

    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Create group item error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
