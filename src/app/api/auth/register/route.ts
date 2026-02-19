import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getDatabase } from '@/lib/database';
import { TokenManager } from '@/lib/license/token-manager';
import { LicenseManager, LicenseType } from '@/lib/license/license-manager';
import { sendEmail } from '@/lib/email/mailer';
import { ensureDefaultProject } from '@/lib/services/projects/projectService';

export async function POST(request: NextRequest) {
  try {
    const { email, password, name, companyName, licenseType } =
      await request.json();

    // Validation
    if (!email || !password || !name || !companyName) {
      return NextResponse.json(
        { error: 'Email, password, name, and company name are required' },
        { status: 400 },
      );
    }

    // Block registration with demo account identifiers
    const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@cognipeer.ai';
    const DEMO_SLUG = 'demo';
    if (email.trim().toLowerCase() === DEMO_EMAIL) {
      return NextResponse.json(
        { error: 'This email address is reserved for the demo account.' },
        { status: 409 },
      );
    }

    const candidateSlug = companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (candidateSlug === DEMO_SLUG) {
      return NextResponse.json(
        {
          error: 'This company name is reserved. Please choose a different name.',
        },
        { status: 409 },
      );
    }

    // Password strength validation
    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters long' },
        { status: 400 },
      );
    }

    const db = await getDatabase();

    // Generate slug from company name
    const slug = companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    // Check if slug already exists
    const existingTenant = await db.findTenantBySlug(slug);
    if (existingTenant) {
      return NextResponse.json(
        {
          error:
            'A company with this name already exists. Please choose a different name.',
        },
        { status: 409 },
      );
    }

    // Note: We don't check for existing users here because:
    // 1. Each tenant has its own database
    // 2. Users are isolated per tenant
    // 3. Same email can exist in different tenants

    // Determine license type (default to FREE for new registrations)
    const finalLicenseType: LicenseType =
      (licenseType as LicenseType) || 'FREE';
    const features = LicenseManager.getFeaturesForLicense(finalLicenseType);

    // Create tenant with dedicated database
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({
      companyName,
      slug,
      dbName,
      licenseType: finalLicenseType,
      ownerId: '', // Will be updated after user creation
    });

    // Switch to tenant database
    await db.switchToTenant(dbName);

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user as owner in tenant database
    const tenantIdStr =
      typeof tenant._id === 'string' ? tenant._id : tenant._id!.toString();

    const user = await db.createUser({
      email,
      password: hashedPassword,
      name,
      licenseId: finalLicenseType,
      features,
      tenantId: tenantIdStr,
      role: 'owner',
    });

    const userIdStr =
      typeof user._id === 'string' ? user._id : user._id!.toString();

    const defaultProject = await ensureDefaultProject(dbName, tenantIdStr, userIdStr);
    const defaultProjectId =
      typeof defaultProject._id === 'string'
        ? defaultProject._id
        : defaultProject._id?.toString();

    // Update tenant with owner ID
    await db.updateTenant(tenantIdStr, { ownerId: userIdStr });

    // Generate JWT token with tenant information
    const token = await TokenManager.generateToken({
      userId: userIdStr,
      email: user.email,
      tenantId: tenantIdStr,
      tenantSlug: tenant.slug,
      tenantDbName: tenant.dbName,
      role: user.role!,
      licenseId: user.licenseId,
      licenseType: finalLicenseType,
      features: user.features || [],
    });

    // Send welcome email (async, don't wait for it)
    sendEmail(email, 'welcome', {
      name,
      email,
      companyName,
      slug,
      licenseType: finalLicenseType,
    }).catch((err: Error) =>
      console.error('Failed to send welcome email:', err),
    );

    // Create response with cookie
    const response = NextResponse.json(
      {
        message: 'Company and user registered successfully',
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          licenseType: finalLicenseType,
          features: user.features,
        },
        tenant: {
          id: tenant._id,
          companyName: tenant.companyName,
          slug: tenant.slug,
        },
      },
      { status: 201 },
    );

    // Set HTTP-only cookie
    response.cookies.set('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    });

    if (defaultProjectId) {
      response.cookies.set('active_project_id', defaultProjectId, {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30,
        path: '/',
      });
    }

    return response;
  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
