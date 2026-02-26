import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('auth');

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const tenantSlug = request.headers.get('x-tenant-slug');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Demo account is read-only — password changes are not allowed
    if (tenantSlug === 'demo') {
      return NextResponse.json(
        { error: 'Password changes are not allowed for the demo account.' },
        { status: 403 },
      );
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
    logger.error('Change password error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
