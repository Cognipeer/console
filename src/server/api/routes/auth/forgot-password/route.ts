import { NextResponse, type NextRequest } from '@/server/api/http';
import { SignJWT } from 'jose';
import { getDatabase } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { checkRateLimit, PASSWORD_RESET_RATE_LIMIT } from '@/lib/services/auth/rateLimiter';

const logger = createLogger('auth');

const RESET_TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

function getClientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

export async function POST(request: NextRequest) {
  try {
    const { email, slug } = await request.json();

    if (!email || !slug) {
      return NextResponse.json(
        { error: 'Email and organization slug are required' },
        { status: 400 },
      );
    }

    // Rate limit per IP
    const clientIp = getClientIp(request);
    const rl = checkRateLimit(`forgot-password:${clientIp}`, PASSWORD_RESET_RATE_LIMIT);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many password reset requests. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(rl.retryAfterSeconds),
          },
        },
      );
    }

    // Always return success to prevent email enumeration
    const successResponse = NextResponse.json({
      message: 'If that email exists, a password reset link has been sent.',
    });

    const db = await getDatabase();

    // Find tenant
    const tenant = await db.findTenantBySlug(slug);
    if (!tenant) {
      logger.warn('Password reset attempted for non-existent tenant', { slug });
      return successResponse;
    }

    const tenantDbName = `tenant_${slug}`;
    await db.switchToTenant(tenantDbName);

    // Find user
    const user = await db.findUserByEmail(email);
    if (!user) {
      logger.warn('Password reset attempted for non-existent user', { email: email.substring(0, 3) + '***' });
      return successResponse;
    }

    // Generate a short-lived JWT for password reset
    const cfg = getConfig();
    const secret = new TextEncoder().encode(cfg.auth.jwtSecret);

    const resetToken = await new SignJWT({
      sub: String(user._id),
      email: user.email,
      slug,
      purpose: 'password-reset',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + RESET_TOKEN_EXPIRY_SECONDS)
      .sign(secret);

    // Build reset URL
    const baseUrl = request.headers.get('origin') || `${request.nextUrl.protocol}//${request.nextUrl.host}`;
    const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

    // Send email
    const emailSent = await sendEmail(email, 'password-reset', {
      name: user.name,
      resetUrl,
      expiryTime: '1 hour',
    });

    if (!emailSent) {
      logger.warn('Password reset email failed to send', { userId: String(user._id) });
    }

    return successResponse;
  } catch (error) {
    logger.error('Forgot password error', { error });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
