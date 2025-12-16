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

  if (ctx.userRole === 'user') {
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

    const users = await access.db.listUsers();
    const members = users.filter((user) => {
      if (user.role === 'owner' || user.role === 'admin') return true;
      const allowed = (user.projectIds ?? []).map(String);
      return allowed.includes(String(projectId));
    });

    return NextResponse.json({ users: members }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.error('List project members error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const ctx = await requireTenantContext(request);

    if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin' && ctx.userRole !== 'project_admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const access = await assertProjectAccess({ ...ctx, projectId });
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const body = (await request.json()) as { userId?: string; email?: string };
    if (!body.userId && !body.email) {
      return NextResponse.json({ error: 'userId or email is required' }, { status: 400 });
    }

    const target = body.userId
      ? await access.db.findUserById(body.userId)
      : await access.db.findUserByEmail(String(body.email));
    if (!target || String(target.tenantId) !== String(ctx.tenantId)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (target.role === 'owner' || target.role === 'admin') {
      return NextResponse.json(
        { error: 'Owners and admins are implicitly assigned to all projects' },
        { status: 400 },
      );
    }

    const set = new Set((target.projectIds ?? []).map(String));
    set.add(String(projectId));

    const updated = await access.db.updateUser(String(target._id), {
      projectIds: Array.from(set),
    });

    if (!updated) {
      return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
    }

    return NextResponse.json({ user: updated }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.error('Add project member error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const ctx = await requireTenantContext(request);

    if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin' && ctx.userRole !== 'project_admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const access = await assertProjectAccess({ ...ctx, projectId });
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const body = (await request.json()) as { userId?: string; email?: string };
    if (!body.userId && !body.email) {
      return NextResponse.json({ error: 'userId or email is required' }, { status: 400 });
    }

    const target = body.userId
      ? await access.db.findUserById(body.userId)
      : await access.db.findUserByEmail(String(body.email));
    if (!target || String(target.tenantId) !== String(ctx.tenantId)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (target.role === 'owner' || target.role === 'admin') {
      return NextResponse.json(
        { error: 'Cannot remove owners/admins from projects' },
        { status: 400 },
      );
    }

    const next = (target.projectIds ?? []).map(String).filter((id) => id !== String(projectId));

    const updated = await access.db.updateUser(String(target._id), {
      projectIds: next.length ? next : [],
    });

    if (!updated) {
      return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
    }

    return NextResponse.json({ user: updated }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.error('Remove project member error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const ctx = await requireTenantContext(request);

    if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const db = await getDatabase();
    await db.switchToTenant(ctx.tenantDbName);

    const project = await db.findProjectById(projectId);
    if (!project || String(project.tenantId) !== String(ctx.tenantId)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const body = (await request.json()) as { userId?: string; role?: string };
    if (!body.userId || !body.role) {
      return NextResponse.json({ error: 'userId and role are required' }, { status: 400 });
    }

    if (body.role !== 'user' && body.role !== 'project_admin') {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }

    const target = await db.findUserById(body.userId);
    if (!target || String(target.tenantId) !== String(ctx.tenantId)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (target.role === 'owner' || target.role === 'admin') {
      return NextResponse.json({ error: 'Cannot change role for owner/admin' }, { status: 400 });
    }

    const updated = await db.updateUser(String(target._id), {
      role: body.role as 'user' | 'project_admin',
    });

    if (!updated) {
      return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
    }

    return NextResponse.json({ user: updated }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.error('Update project member role error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
