import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';
import crypto from 'crypto';
import { ProjectContextError, requireProjectContext } from '@/lib/services/projects/projectContext';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';

export async function GET(request: NextRequest) {
  try {
    const userId = request.headers.get('x-user-id');
    const tenantId = request.headers.get('x-tenant-id');
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const userRole = request.headers.get('x-user-role');

    if (!userId || !tenantId || !tenantDbName || !userRole) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (userRole !== 'owner' && userRole !== 'admin' && userRole !== 'project_admin' && userRole !== 'user') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let projectId: string;
    try {
      const projectContext = await requireProjectContext(request, {
        tenantDbName,
        tenantId,
        userId,
      });
      projectId = projectContext.projectId;
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const db = await getDatabase();
    // No need to switch to tenant - tokens are in main DB

    const allTokens = await db.listProjectApiTokens(tenantId, projectId);

    const canDeleteAll = userRole === 'owner' || userRole === 'admin' || userRole === 'project_admin';
    const tokens = allTokens.map((token) => ({
      _id: token._id,
      label: token.label,
      userId: token.userId,
      lastUsed: token.lastUsed,
      createdAt: token.createdAt,
      canDelete: canDeleteAll || String(token.userId) === String(userId),
    }));

    return NextResponse.json({ tokens }, { status: 200 });
  } catch (error) {
    console.error('List tokens error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { label?: string };

    // Get tenant and user info from headers
    const userId = request.headers.get('x-user-id');
    const tenantId = request.headers.get('x-tenant-id');
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const userRole = request.headers.get('x-user-role');
    const licenseType = request.headers.get('x-license-type') as LicenseType | null;

    if (!userId || !tenantId || !tenantDbName || !userRole || !licenseType) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (userRole !== 'owner' && userRole !== 'admin' && userRole !== 'project_admin' && userRole !== 'user') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let projectId: string;
    try {
      const projectContext = await requireProjectContext(request, {
        tenantDbName,
        tenantId,
        userId,
      });
      projectId = projectContext.projectId;
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    // Validation
    if (!body.label || body.label.length < 3) {
      return NextResponse.json(
        { error: 'Label must be at least 3 characters' },
        { status: 400 },
      );
    }

    const db = await getDatabase();
    // No need to switch to tenant - tokens are in main DB

    const existingTokens = await db.listProjectApiTokens(tenantId, projectId);
    const quotaCheck = await checkResourceQuota(
      {
        tenantDbName,
        tenantId,
        projectId,
        licenseType,
        userId,
        domain: 'global',
      },
      'apiTokens',
      existingTokens.length,
    );

    if (!quotaCheck.allowed) {
      return NextResponse.json(
        { error: quotaCheck.reason || 'API token quota exceeded' },
        { status: 429 },
      );
    }

    // Generate a secure random token
    const token = `cpeer_${crypto.randomBytes(32).toString('hex')}`;

    // Create token in database
    const apiToken = await db.createApiToken({
      userId,
      tenantId,
      projectId,
      label: body.label,
      token,
    });

    // Return the full token only once
    return NextResponse.json(
      {
        message: 'API token created successfully',
        token: token, // Full token returned only once
        id: apiToken._id,
        label: apiToken.label,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('Create token error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
