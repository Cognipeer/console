import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getDatabase } from '@/lib/database';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as { currentPassword?: string; newPassword?: string };
    if (!body?.currentPassword || !body?.newPassword) {
      return NextResponse.json(
        { error: 'currentPassword and newPassword are required' },
        { status: 400 },
      );
    }

    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 },
      );
    }

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const user = await db.findUserById(userId);
    if (!user || String(user.tenantId) !== String(tenantId)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const ok = await bcrypt.compare(body.currentPassword, user.password);
    if (!ok) {
      return NextResponse.json({ error: 'Invalid current password' }, { status: 401 });
    }

    const hashed = await bcrypt.hash(body.newPassword, 10);
    const updated = await db.updateUser(userId, {
      password: hashed,
      mustChangePassword: false,
      updatedAt: new Date(),
    });

    if (!updated) {
      return NextResponse.json({ error: 'Failed to update password' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('Change password error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
