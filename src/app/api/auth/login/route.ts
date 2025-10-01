import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getDatabase } from '@/lib/database';
import { TokenManager } from '@/lib/license/token-manager';
import { LicenseType } from '@/lib/license/license-manager';

export async function POST(request: NextRequest) {
  try {
    const { email, password, slug } = await request.json();

    // Validation
    if (!email || !password || !slug) {
      return NextResponse.json(
        { error: 'Email, password, and company slug are required' },
        { status: 400 }
      );
    }

    const db = await getDatabase();

    // Find tenant by slug
    const tenant = await db.findTenantBySlug(slug);
    if (!tenant) {
      return NextResponse.json(
        { error: 'Invalid company slug' },
        { status: 401 }
      );
    }

    // Switch to tenant database
    await db.switchToTenant(tenant.dbName);

    // Find user in tenant database
    const user = await db.findUserByEmail(email);
    if (!user) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // Generate JWT token with tenant and license information
    const token = await TokenManager.generateToken({
      userId: typeof user._id === 'string' ? user._id : user._id!.toString(),
      email: user.email,
      tenantId: typeof tenant._id === 'string' ? tenant._id : tenant._id!.toString(),
      tenantSlug: tenant.slug,
      role: user.role!,
      licenseId: user.licenseId,
      licenseType: user.licenseId as LicenseType,
      features: user.features || [],
    });

    // Create response
    const response = NextResponse.json(
      {
        message: 'Login successful',
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          licenseType: user.licenseId,
          features: user.features,
        },
        tenant: {
          id: tenant._id,
          companyName: tenant.companyName,
          slug: tenant.slug,
        },
      },
      { status: 200 }
    );

    // Set HTTP-only cookie
    response.cookies.set('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
