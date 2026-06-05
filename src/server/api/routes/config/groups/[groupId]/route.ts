import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  getConfigGroupWithItems,
  updateConfigGroup,
  deleteConfigGroup,
} from '@/lib/services/config/configService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('config-group-detail');

/** GET /api/config/groups/[groupId] — Get group with items */
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

    const group = await getConfigGroupWithItems(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      groupId,
    );

    if (!group) {
      return NextResponse.json({ error: 'Config group not found' }, { status: 404 });
    }

    return NextResponse.json({ group });
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Get config group error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** PATCH /api/config/groups/[groupId] — Update config group */
export async function PATCH(
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

    const group = await updateConfigGroup(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      groupId,
      {
        name: body.name,
        description: body.description,
        tags: body.tags,
        metadata: body.metadata,
        updatedBy: userEmail || userId,
      },
    );

    return NextResponse.json({ group });
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Update config group error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** DELETE /api/config/groups/[groupId] — Delete config group (cascades items) */
export async function DELETE(
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

    await deleteConfigGroup(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      groupId,
      userEmail || userId,
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Delete config group error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
