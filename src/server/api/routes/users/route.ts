import { NextResponse, type NextRequest } from '@/server/api/http';
import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('users');

export async function GET(request: NextRequest) {
  try {
    // Get tenant info from headers (injected by middleware)
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const userRole = request.headers.get('x-user-role');

    if (!tenantDbName || !userRole) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 });
    }

    if (userRole !== 'owner' && userRole !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    // Get all users in the tenant
    const users = await db.listUsers();

    return NextResponse.json({ users }, { status: 200 });
  } catch (error) {
    logger.error('List users error', { error });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
