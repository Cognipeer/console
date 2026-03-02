import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  getConfigGroupByKey,
  createConfigItem,
  listConfigItems,
} from '@/lib/services/config/configService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-config-group-items');

export const runtime = 'nodejs';

/** GET /api/client/v1/config/groups/[groupKey]/items — List items in a group */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ groupKey: string }> },
) {
  try {
    const { groupKey } = await params;
    const ctx = await requireApiToken(request);

    const group = await getConfigGroupByKey(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      groupKey,
    );

    if (!group || !group._id) {
      return NextResponse.json({ error: 'Config group not found' }, { status: 404 });
    }

    const groupId = typeof group._id === 'string' ? group._id : String(group._id);
    const url = new URL(request.url);
    const isSecret = url.searchParams.get('isSecret');
    const search = url.searchParams.get('search') ?? undefined;
    const tagsParam = url.searchParams.get('tags');
    const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()) : undefined;

    const items = await listConfigItems(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      {
        groupId,
        isSecret: isSecret !== null ? isSecret === 'true' : undefined,
        tags,
        search,
      },
    );

    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('List group items error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** POST /api/client/v1/config/groups/[groupKey]/items — Create item in a group */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ groupKey: string }> },
) {
  try {
    const { groupKey } = await params;
    const ctx = await requireApiToken(request);

    const group = await getConfigGroupByKey(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      groupKey,
    );

    if (!group || !group._id) {
      return NextResponse.json({ error: 'Config group not found' }, { status: 404 });
    }

    const groupId = typeof group._id === 'string' ? group._id : String(group._id);
    const body = await request.json();

    if (!body.name || typeof body.name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (body.value === undefined || body.value === null) {
      return NextResponse.json({ error: 'value is required' }, { status: 400 });
    }

    const item = await createConfigItem(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
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
        createdBy: ctx.user?.email ?? ctx.tokenRecord.userId,
      },
    );

    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Create group item error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
