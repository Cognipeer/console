import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';
import { ProjectContextError, requireProjectContext } from '@/lib/services/projects/projectContext';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    // Get tenant and user info from headers
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const userRole = request.headers.get('x-user-role');

    if (!tenantDbName || !tenantId || !userId || !userRole) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (userRole !== 'owner' && userRole !== 'admin' && userRole !== 'project_admin' && userRole !== 'user') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let projectId: string;
    try {
      const projectContext = await requireProjectContext(request, {
        tenantDbName,
        tenantId,
        userId,
      });
      projectId = projectContext.projectId;
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const db = await getDatabase();
    // No need to switch to tenant - tokens are in main DB

    const deleted = userRole === 'user'
      ? await (async () => {
        const ownTokens = await db.listApiTokens(userId);
        const token = ownTokens.find((t) => String(t._id) === String(id));
        if (!token) return false;
        if (String(token.tenantId) !== String(tenantId) || String(token.projectId) !== String(projectId)) {
          return false;
        }
        return db.deleteApiToken(id, userId);
      })()
      : await db.deleteProjectApiToken(id, tenantId, projectId);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Token not found' },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { message: 'API token deleted successfully' },
      { status: 200 },
    );
  } catch (error) {
    console.error('Delete token error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
