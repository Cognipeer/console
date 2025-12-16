import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';

export const runtime = 'nodejs';

async function requireTenantContext(request: NextRequest) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const userId = request.headers.get('x-user-id');
  const userRole = request.headers.get('x-user-role');

  if (!tenantDbName || !tenantId || !userId || !userRole) {
    throw new Error('Unauthorized');
  }

  return { tenantDbName, tenantId, userId, userRole } as const;
}

async function assertProjectAccess(ctx: {
  tenantDbName: string;
  tenantId: string;
  userId: string;
  userRole: string;
  projectId: string;
}) {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const project = await db.findProjectById(ctx.projectId);
  if (!project || String(project.tenantId) !== String(ctx.tenantId)) {
    return { ok: false as const, status: 404 as const, error: 'Project not found' };
  }

  if (ctx.userRole === 'owner' || ctx.userRole === 'admin') {
    return { ok: true as const, db, project };
  }

  const user = await db.findUserById(ctx.userId);
  if (!user) {
    return { ok: false as const, status: 401 as const, error: 'Unauthorized' };
  }

  if (ctx.userRole === 'project_admin') {
    const allowed = (user.projectIds ?? []).map(String);
    if (!allowed.includes(String(ctx.projectId))) {
      return { ok: false as const, status: 403 as const, error: 'Forbidden' };
    }
    return { ok: true as const, db, project };
  }

  return { ok: false as const, status: 403 as const, error: 'Forbidden' };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const ctx = await requireTenantContext(request);

    const access = await assertProjectAccess({ ...ctx, projectId });
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const q = request.nextUrl.searchParams.get('q')?.trim().toLowerCase() ?? '';
    if (q.length < 2) {
      return NextResponse.json({ users: [] }, { status: 200 });
    }

    const users = await access.db.listUsers();
    const candidates = users
      .filter((u) => {
        if (u.role === 'owner' || u.role === 'admin') return false;
        const already = (u.projectIds ?? []).map(String).includes(String(projectId));
        return !already;
      })
      .filter((u) => {
        const email = (u.email ?? '').toLowerCase();
        const name = (u.name ?? '').toLowerCase();
        return email.includes(q) || name.includes(q);
      })
      .slice(0, 10)
      .map((u) => ({
        _id: String(u._id),
        email: u.email,
        name: u.name,
      }));

    return NextResponse.json({ users: candidates }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.error('List project member candidates error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
