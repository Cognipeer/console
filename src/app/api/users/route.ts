import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';

export async function GET(request: NextRequest) {
  try {
    // Get tenant info from headers (injected by middleware)
    const tenantSlug = request.headers.get('x-tenant-slug');
    const userId = request.headers.get('x-user-id');

    if (!tenantSlug) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 });
    }

    const db = await getDatabase();
    await db.switchToTenant(`tenant_${tenantSlug}`);

    // Get all users in the tenant
    const users = await db.listUsers();

    return NextResponse.json({ users }, { status: 200 });
  } catch (error) {
    console.error('List users error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
