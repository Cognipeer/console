import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  createConfigGroup,
  listConfigGroups,
} from '@/lib/services/config/configService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-config-groups');

export const runtime = 'nodejs';

/** GET /api/client/v1/config/groups — List config groups */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireApiToken(request);
    const url = new URL(request.url);
    const search = url.searchParams.get('search') ?? undefined;
    const tagsParam = url.searchParams.get('tags');
    const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()) : undefined;

    const groups = await listConfigGroups(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      { tags, search },
    );

    return NextResponse.json({ groups });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('List config groups error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** POST /api/client/v1/config/groups — Create config group */
export async function POST(request: NextRequest) {
  try {
    const ctx = await requireApiToken(request);
    const body = await request.json();

    if (!body.name || typeof body.name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const group = await createConfigGroup(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      {
        key: body.key,
        name: body.name,
        description: body.description,
        tags: body.tags,
        metadata: body.metadata,
        createdBy: ctx.user?.email ?? ctx.tokenRecord.userId,
      },
    );

    return NextResponse.json({ group }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Create config group error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
