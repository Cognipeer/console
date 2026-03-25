import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  getConfigItemById,
  updateConfigItem,
  deleteConfigItem,
  listConfigAuditLogs,
} from '@/lib/services/config/configService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('config-item-detail');

/** GET /api/config/items/[itemId] — Get config item */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  try {
    const { itemId } = await params;
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

    const item = await getConfigItemById(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      itemId,
    );

    if (!item) {
      return NextResponse.json({ error: 'Config item not found' }, { status: 404 });
    }

    // Get audit logs
    const auditLogs = await listConfigAuditLogs(
      tenantDbName,
      tenantId,
      item.key,
      { limit: 20 },
    );

    return NextResponse.json({ item, auditLogs });
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Get config item error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** PATCH /api/config/items/[itemId] — Update config item */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  try {
    const { itemId } = await params;
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

    const item = await updateConfigItem(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      itemId,
      {
        name: body.name,
        description: body.description,
        value: body.value !== undefined ? String(body.value) : undefined,
        valueType: body.valueType,
        isSecret: body.isSecret,
        tags: body.tags,
        metadata: body.metadata,
        updatedBy: userEmail || userId,
      },
    );

    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Update config item error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** DELETE /api/config/items/[itemId] — Delete config item */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  try {
    const { itemId } = await params;
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

    await deleteConfigItem(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      itemId,
      userEmail || userId,
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Delete config item error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
