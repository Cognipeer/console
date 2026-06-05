import { NextResponse, type NextRequest } from '@/server/api/http';
import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('projects');

function ensureTenantContext(request: NextRequest) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const userId = request.headers.get('x-user-id');
  const userRole = request.headers.get('x-user-role');

  if (!tenantDbName || !tenantId || !userId || !userRole) {
    return { error: { message: 'Unauthorized' } } as const;
  }

  return { tenantDbName, tenantId, userId, userRole } as const;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const ctx = ensureTenantContext(request);
    if ('error' in ctx) {
      return NextResponse.json(ctx.error, { status: 401 });
    }
    if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { projectId } = await params;
    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    const body = (await request.json()) as {
      name?: string;
      description?: string;
    };

    if (!body || (body.name === undefined && body.description === undefined)) {
      return NextResponse.json(
        { error: 'At least one field (name, description) is required' },
        { status: 400 },
      );
    }

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length < 2) {
        return NextResponse.json(
          { error: 'name must be at least 2 characters' },
          { status: 400 },
        );
      }
    }

    const db = await getDatabase();
    await db.switchToTenant(ctx.tenantDbName);

    const existing = await db.findProjectById(projectId);
    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { updatedBy: ctx.userId };
    if (body.name !== undefined) updateData.name = body.name.trim();
    if (body.description !== undefined) updateData.description = body.description;

    const updated = await db.updateProject(projectId, updateData);
    if (!updated) {
      return NextResponse.json({ error: 'Failed to update project' }, { status: 500 });
    }

    return NextResponse.json({ project: updated }, { status: 200 });
  } catch (error) {
    logger.error('Update project error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const ctx = ensureTenantContext(request);
    if ('error' in ctx) {
      return NextResponse.json(ctx.error, { status: 401 });
    }
    if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { projectId } = await params;
    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    const db = await getDatabase();
    await db.switchToTenant(ctx.tenantDbName);

    const existing = await db.findProjectById(projectId);
    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Prevent deletion of the default project
    if (existing.key === 'default') {
      return NextResponse.json(
        { error: 'Cannot delete the default project' },
        { status: 400 },
      );
    }

    const deleted = await db.deleteProject(projectId);
    if (!deleted) {
      return NextResponse.json({ error: 'Failed to delete project' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('Delete project error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
