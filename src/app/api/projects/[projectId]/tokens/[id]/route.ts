import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';

export const runtime = 'nodejs';

function requireTenantContext(request: NextRequest) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const userRole = request.headers.get('x-user-role');

  if (!tenantDbName || !tenantId || !userRole) {
    return { error: 'Unauthorized' as const, status: 401 as const };
  }

  return { tenantDbName, tenantId, userRole };
}

async function assertProjectBelongsToTenant(ctx: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
}) {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const project = await db.findProjectById(ctx.projectId);
  if (!project || String(project.tenantId) !== String(ctx.tenantId)) {
    return { ok: false as const, status: 404 as const, error: 'Project not found' };
  }

  return { ok: true as const };
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; id: string }> },
) {
  try {
    const ctx = requireTenantContext(request);
    if ('error' in ctx) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }

    if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { projectId, id } = await context.params;

    const projectAccess = await assertProjectBelongsToTenant({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId,
    });
    if (!projectAccess.ok) {
      return NextResponse.json({ error: projectAccess.error }, { status: projectAccess.status });
    }

    const db = await getDatabase();
    const deleted = await db.deleteProjectApiToken(id, ctx.tenantId, projectId);

    if (!deleted) {
      return NextResponse.json({ error: 'Token not found' }, { status: 404 });
    }

    return NextResponse.json({ message: 'API token deleted successfully' }, { status: 200 });
  } catch (error) {
    console.error('Delete project token error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
