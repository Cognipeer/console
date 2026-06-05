import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  getConfigItem,
  updateConfigItem,
  deleteConfigItem,
} from '@/lib/services/config/configService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-config-detail');

/** GET /api/client/v1/config/items/[key] — Get config item by key */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { key } = await params;
    const ctx = await requireApiToken(request);

    const item = await getConfigItem(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      key,
    );

    if (!item) {
      return NextResponse.json({ error: 'Config item not found' }, { status: 404 });
    }

    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Get config item error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** PATCH /api/client/v1/config/items/[key] — Update config item by key */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { key } = await params;
    const ctx = await requireApiToken(request);

    const existing = await getConfigItem(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      key,
    );

    if (!existing || !existing._id) {
      return NextResponse.json({ error: 'Config item not found' }, { status: 404 });
    }

    const body = await request.json();
    const itemId = typeof existing._id === 'string' ? existing._id : String(existing._id);

    const item = await updateConfigItem(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      itemId,
      {
        name: body.name,
        description: body.description,
        value: body.value !== undefined ? String(body.value) : undefined,
        valueType: body.valueType,
        isSecret: body.isSecret,
        tags: body.tags,
        metadata: body.metadata,
        updatedBy: ctx.user?.email ?? ctx.tokenRecord.userId,
      },
    );

    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Update config item error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** DELETE /api/client/v1/config/items/[key] — Delete config item by key */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { key } = await params;
    const ctx = await requireApiToken(request);

    const existing = await getConfigItem(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      key,
    );

    if (!existing || !existing._id) {
      return NextResponse.json({ error: 'Config item not found' }, { status: 404 });
    }

    const itemId = typeof existing._id === 'string' ? existing._id : String(existing._id);

    await deleteConfigItem(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      itemId,
      ctx.user?.email ?? ctx.tokenRecord.userId,
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Delete config item error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
