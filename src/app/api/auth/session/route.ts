import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('auth');

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const role = request.headers.get('x-user-role');

    if (!tenantDbName || !tenantId || !userId || !role) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const user = await db.findUserById(userId);
    if (!user || String(user.tenantId) !== String(tenantId)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectCount = (user.projectIds ?? []).length;

    return NextResponse.json(
      {
        authenticated: true,
        role: user.role,
        mustChangePassword: Boolean(user.mustChangePassword),
        projectCount,
      },
      { status: 200 },
    );
  } catch (error) {
    logger.error('Session endpoint error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
