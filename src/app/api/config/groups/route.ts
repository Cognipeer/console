import { NextRequest, NextResponse } from 'next/server';
import {
  createConfigGroup,
  listConfigGroups,
} from '@/lib/services/config/configService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('config-groups');

export const runtime = 'nodejs';

/** GET /api/config/groups — List config groups */
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
    const search = searchParams.get('search') || undefined;
    const tagsParam = searchParams.get('tags');
    const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()) : undefined;

    const groups = await listConfigGroups(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      { tags, search },
    );

    return NextResponse.json({ groups });
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('List config groups error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/** POST /api/config/groups — Create config group */
export async function POST(request: NextRequest) {
  try {
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

    const group = await createConfigGroup(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      {
        key: body.key,
        name: body.name,
        description: body.description,
        tags: body.tags,
        metadata: body.metadata,
        createdBy: userEmail || userId,
      },
    );

    return NextResponse.json({ group }, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Create config group error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
