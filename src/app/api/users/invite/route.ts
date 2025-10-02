import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getDatabase } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';

export async function POST(request: NextRequest) {
  try {
    const { name, email, role } = await request.json();

    // Get tenant and user info from headers
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');
    const inviterId = request.headers.get('x-user-id');
    const inviterRole = request.headers.get('x-user-role');

    if (!tenantSlug || !tenantId) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 });
    }

    // Only owners and admins can invite users
    if (inviterRole !== 'owner' && inviterRole !== 'admin') {
      return NextResponse.json(
        { error: 'Only owners and admins can invite users' },
        { status: 403 },
      );
    }

    // Validation
    if (!name || !email || !role) {
      return NextResponse.json(
        { error: 'Name, email, and role are required' },
        { status: 400 },
      );
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 },
      );
    }

    // Role validation
    if (!['user', 'admin'].includes(role)) {
      return NextResponse.json(
        { error: 'Invalid role. Must be user or admin' },
        { status: 400 },
      );
    }

    const db = await getDatabase();

    // Get tenant info
    const tenant = await db.findTenantById(tenantId);
    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // Switch to tenant database
    await db.switchToTenant(`tenant_${tenantSlug}`);

    // Check if user already exists
    const existingUser = await db.findUserByEmail(email);
    if (existingUser) {
      return NextResponse.json(
        { error: 'User with this email already exists in your organization' },
        { status: 409 },
      );
    }

    // Generate a temporary password (user will need to reset it)
    const tempPassword = Math.random().toString(36).slice(-12);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Create user with invited status
    const user = await db.createUser({
      email,
      password: hashedPassword,
      name,
      tenantId,
      role: role as 'user' | 'admin',
      licenseId: tenant.licenseType,
      features: [], // Will inherit from tenant
      invitedBy: inviterId!,
      invitedAt: new Date(),
    });

    // Send invitation email
    sendEmail(email, 'user-invitation', {
      name,
      companyName: tenant.companyName,
      slug: tenant.slug,
      tempPassword,
      inviterName: inviterRole, // You might want to fetch the actual inviter's name
    }).catch((err: Error) =>
      console.error('Failed to send invitation email:', err),
    );

    return NextResponse.json(
      {
        message: 'User invited successfully',
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('Invite user error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
