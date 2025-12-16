import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';
import { ensureDefaultProject, listAccessibleProjects } from '@/lib/services/projects/projectService';

export const runtime = 'nodejs';

function ensureTenantContext(request: NextRequest) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const userId = request.headers.get('x-user-id');

  if (!tenantDbName || !tenantId || !userId) {
    return { error: { message: 'Unauthorized' } } as const;
  }

  return { tenantDbName, tenantId, userId } as const;
}

export async function POST(request: NextRequest) {
  try {
    const ctx = ensureTenantContext(request);
    if ('error' in ctx) {
      return NextResponse.json(ctx.error, { status: 401 });
    }

    const body = (await request.json()) as { projectId?: string };
    if (!body?.projectId || typeof body.projectId !== 'string') {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    const db = await getDatabase();
    await db.switchToTenant(ctx.tenantDbName);
    const user = await db.findUserById(ctx.userId);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureDefaultProject(ctx.tenantDbName, ctx.tenantId, ctx.userId);

    const projects = await listAccessibleProjects(ctx.tenantDbName, ctx.tenantId, {
      role: user.role,
      projectIds: user.projectIds,
    });

    const allowed = projects.some((p) => String(p._id) === String(body.projectId));
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const response = NextResponse.json({ success: true }, { status: 200 });
    response.cookies.set('active_project_id', body.projectId, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Set active project error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
