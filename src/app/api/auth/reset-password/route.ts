import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { validatePassword, BCRYPT_ROUNDS } from '@/lib/services/auth/passwordPolicy';

const logger = createLogger('auth');

export async function POST(request: NextRequest) {
  try {
    const { token, newPassword } = await request.json();

    if (!token || !newPassword) {
      return NextResponse.json(
        { error: 'Token and new password are required' },
        { status: 400 },
      );
    }

    // Validate password strength
    const pwResult = validatePassword(newPassword);
    if (!pwResult.valid) {
      return NextResponse.json(
        { error: pwResult.errors.join('. ') },
        { status: 400 },
      );
    }

    // Verify the reset token
    const cfg = getConfig();
    const secret = new TextEncoder().encode(cfg.auth.jwtSecret);

    let payload;
    try {
      const result = await jwtVerify(token, secret);
      payload = result.payload as { sub?: string; email?: string; slug?: string; purpose?: string };
    } catch {
      return NextResponse.json(
        { error: 'Invalid or expired reset token' },
        { status: 400 },
      );
    }

    if (payload.purpose !== 'password-reset' || !payload.sub || !payload.slug) {
      return NextResponse.json(
        { error: 'Invalid reset token' },
        { status: 400 },
      );
    }

    const db = await getDatabase();

    // Verify tenant exists
    const tenant = await db.findTenantBySlug(payload.slug);
    if (!tenant) {
      return NextResponse.json(
        { error: 'Invalid reset token' },
        { status: 400 },
      );
    }

    const tenantDbName = `tenant_${payload.slug}`;
    await db.switchToTenant(tenantDbName);

    // Verify user exists
    const user = await db.findUserById(payload.sub);
    if (!user) {
      return NextResponse.json(
        { error: 'Invalid reset token' },
        { status: 400 },
      );
    }

    // Hash and update password
    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const updated = await db.updateUser(payload.sub, {
      password: hashedPassword,
      mustChangePassword: false,
      updatedAt: new Date(),
    });

    if (!updated) {
      return NextResponse.json(
        { error: 'Failed to reset password' },
        { status: 500 },
      );
    }

    logger.info('Password reset successful', { userId: payload.sub });

    return NextResponse.json({ message: 'Password has been reset successfully' });
  } catch (error) {
    logger.error('Reset password error', { error });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
