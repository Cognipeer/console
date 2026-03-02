import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  getConfigGroupByKey,
  getConfigGroupWithItems,
  updateConfigGroup,
  deleteConfigGroup,
} from '@/lib/services/config/configService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-config-group-detail');

export const runtime = 'nodejs';

/** GET /api/client/v1/config/groups/[groupKey] — Get group with items by key */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ groupKey: string }> },
) {
  try {
    const { groupKey } = await params;
    const ctx = await requireApiToken(request);

    const groupMeta = await getConfigGroupByKey(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      groupKey,
    );

    if (!groupMeta || !groupMeta._id) {
      return NextResponse.json({ error: 'Config group not found' }, { status: 404 });
    }

    const groupId = typeof groupMeta._id === 'string' ? groupMeta._id : String(groupMeta._id);
    const group = await getConfigGroupWithItems(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      groupId,
    );

    return NextResponse.json({ group });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Get config group error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** PATCH /api/client/v1/config/groups/[groupKey] — Update config group by key */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ groupKey: string }> },
) {
  try {
    const { groupKey } = await params;
    const ctx = await requireApiToken(request);

    const existing = await getConfigGroupByKey(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      groupKey,
    );

    if (!existing || !existing._id) {
      return NextResponse.json({ error: 'Config group not found' }, { status: 404 });
    }

    const body = await request.json();
    const groupId = typeof existing._id === 'string' ? existing._id : String(existing._id);

    const group = await updateConfigGroup(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      groupId,
      {
        name: body.name,
        description: body.description,
        tags: body.tags,
        metadata: body.metadata,
        updatedBy: ctx.user?.email ?? ctx.tokenRecord.userId,
      },
    );

    return NextResponse.json({ group });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Update config group error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** DELETE /api/client/v1/config/groups/[groupKey] — Delete config group (cascades items) */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ groupKey: string }> },
) {
  try {
    const { groupKey } = await params;
    const ctx = await requireApiToken(request);

    const existing = await getConfigGroupByKey(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      groupKey,
    );

    if (!existing || !existing._id) {
      return NextResponse.json({ error: 'Config group not found' }, { status: 404 });
    }

    const groupId = typeof existing._id === 'string' ? existing._id : String(existing._id);

    await deleteConfigGroup(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      groupId,
      ctx.user?.email ?? ctx.tokenRecord.userId,
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Delete config group error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
