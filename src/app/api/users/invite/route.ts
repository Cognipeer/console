import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getDatabase } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import { ensureDefaultProject } from '@/lib/services/projects/projectService';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('users');

export async function POST(request: NextRequest) {
  try {
    const { name, email, role, projectId } = await request.json();

    // Get tenant and user info from headers
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const inviterId = request.headers.get('x-user-id');
    const inviterRole = request.headers.get('x-user-role');

    if (!tenantDbName || !tenantId) {
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
    if (!['user', 'admin', 'project_admin'].includes(role)) {
      return NextResponse.json(
        { error: 'Invalid role. Must be user, project_admin, or admin' },
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
    await db.switchToTenant(tenantDbName);

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

    const defaultProject = await ensureDefaultProject(
      tenantDbName,
      tenantId,
      inviterId || tenantId,
    );
    const defaultProjectId = defaultProject._id
      ? String(defaultProject._id)
      : undefined;
    if (!defaultProjectId) {
      return NextResponse.json(
        { error: 'Project context is missing' },
        { status: 400 },
      );
    }

    const existingUsers = await db.listUsers();
    const userQuotaCheck = await checkResourceQuota(
      {
        tenantDbName,
        tenantId,
        projectId: defaultProjectId,
        licenseType: tenant.licenseType as LicenseType,
        userId: inviterId ?? undefined,
        domain: 'global',
      },
      'users',
      existingUsers.length,
    );

    if (!userQuotaCheck.allowed) {
      return NextResponse.json(
        { error: userQuotaCheck.reason || 'User quota exceeded' },
        { status: 429 },
      );
    }

    let initialProjectIds: string[] | undefined;
    if (role === 'user' || role === 'project_admin') {
      // Only assign a project when explicitly provided.
      if (projectId && typeof projectId === 'string') {
        initialProjectIds = [projectId];
      }
    }

    // Create user with invited status
    const user = await db.createUser({
      email,
      password: hashedPassword,
      name,
      tenantId,
      role: role as 'user' | 'admin' | 'project_admin',
      projectIds: initialProjectIds,
      licenseId: tenant.licenseType,
      features: [], // Will inherit from tenant
      invitedBy: inviterId!,
      invitedAt: new Date(),
      mustChangePassword: true,
    });

    // Send invitation email
    sendEmail(email, 'user-invitation', {
      name,
      companyName: tenant.companyName,
      slug: tenant.slug,
      tempPassword,
      inviterName: inviterRole, // You might want to fetch the actual inviter's name
    }).catch((err: Error) =>
      logger.error('Failed to send invitation email', { error: err }),
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
    logger.error('Invite user error', { error });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
