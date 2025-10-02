import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getDatabase, ITenant } from '@/lib/database';
import { TokenManager } from '@/lib/license/token-manager';
import { LicenseType } from '@/lib/license/license-manager';

export async function POST(request: NextRequest) {
  try {
    const { email, password, slug } = await request.json();

    // Validation
    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      );
    }

    const normalizedEmail = email.trim().toLowerCase();

    const db = await getDatabase();

  let tenant: ITenant | null = null;
  let user = null;

    if (slug) {
      tenant = await db.findTenantBySlug(slug);
      if (!tenant) {
        return NextResponse.json(
          { error: 'Invalid company identifier' },
          { status: 401 }
        );
      }

      await db.switchToTenant(tenant.dbName);
      user = await db.findUserByEmail(normalizedEmail) || await db.findUserByEmail(email);

      if (!user) {
        return NextResponse.json(
          { error: 'Invalid email or password' },
          { status: 401 }
        );
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return NextResponse.json(
          { error: 'Invalid email or password' },
          { status: 401 }
        );
      }
    } else {
      const tenantEntries = await db.listTenantsForUser(normalizedEmail);
      const checkedTenantIds = new Set<string>();

      for (const entry of tenantEntries) {
        checkedTenantIds.add(entry.tenantId);
        try {
          const candidateTenant = await db.findTenantById(entry.tenantId);
          if (!candidateTenant) {
            continue;
          }

          await db.switchToTenant(candidateTenant.dbName);
          const candidateUser = await db.findUserByEmail(normalizedEmail) || await db.findUserByEmail(email);

          if (!candidateUser) {
            continue;
          }

          const isPasswordValid = await bcrypt.compare(password, candidateUser.password);
          if (!isPasswordValid) {
            continue;
          }

          tenant = candidateTenant;
          user = candidateUser;
          break;
        } catch (err) {
          console.error('Tenant lookup failed:', err);
        }
      }

      if (!tenant || !user) {
        const allTenants = await db.listTenants();
        for (const candidateTenant of allTenants) {
          const candidateTenantId = typeof candidateTenant._id === 'string'
            ? candidateTenant._id
            : candidateTenant._id?.toString();

          if (!candidateTenantId || checkedTenantIds.has(candidateTenantId)) {
            continue;
          }

          try {
            await db.switchToTenant(candidateTenant.dbName);
            const candidateUser = await db.findUserByEmail(normalizedEmail) || await db.findUserByEmail(email);

            if (!candidateUser) {
              continue;
            }

            const isPasswordValid = await bcrypt.compare(password, candidateUser.password);
            if (!isPasswordValid) {
              continue;
            }

            tenant = candidateTenant;
            user = candidateUser;

            await db.registerUserInDirectory({
              email: candidateUser.email,
              tenantId: candidateTenantId,
              tenantSlug: candidateTenant.slug,
              tenantDbName: candidateTenant.dbName,
              tenantCompanyName: candidateTenant.companyName,
            });

            break;
          } catch (err) {
            console.error('Tenant fallback lookup failed:', err);
          }
        }

        if (!tenant || !user) {
          return NextResponse.json(
            { error: 'Invalid email or password' },
            { status: 401 }
          );
        }
      }
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
