import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';

export const runtime = 'nodejs';

function requireTenantContext(request: NextRequest) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const userId = request.headers.get('x-user-id');
  const userRole = request.headers.get('x-user-role');
  const licenseType = request.headers.get('x-license-type') as LicenseType | null;

  if (!tenantDbName || !tenantId || !userId || !userRole || !licenseType) {
    return { error: 'Unauthorized' as const, status: 401 as const };
  }

  return { tenantDbName, tenantId, userId, userRole, licenseType };
}

async function assertProjectBelongsToTenant(ctx: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
}) {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const project = await db.findProjectById(ctx.projectId);
  if (!project || String(project.tenantId) !== String(ctx.tenantId)) {
    return { ok: false as const, status: 404 as const, error: 'Project not found' };
  }

  return { ok: true as const };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ctx = requireTenantContext(request);
    if ('error' in ctx) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }

    if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { projectId } = await context.params;

    const projectAccess = await assertProjectBelongsToTenant({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId,
    });
    if (!projectAccess.ok) {
      return NextResponse.json({ error: projectAccess.error }, { status: projectAccess.status });
    }

    const db = await getDatabase();

    const existingTokens = await db.listProjectApiTokens(ctx.tenantId, projectId);
    const quotaCheck = await checkResourceQuota(
      {
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId,
        licenseType: ctx.licenseType,
        userId: ctx.userId,
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
    const tokens = (await db.listProjectApiTokens(ctx.tenantId, projectId)).map((token) => ({
      _id: token._id,
      label: token.label,
      userId: token.userId,
      lastUsed: token.lastUsed,
      createdAt: token.createdAt,
      canDelete: true,
    }));

    return NextResponse.json({ tokens }, { status: 200 });
  } catch (error) {
    console.error('List project tokens error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ctx = requireTenantContext(request);
    if ('error' in ctx) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }

    if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = (await request.json()) as { label?: string };
    if (!body.label || body.label.trim().length < 3) {
      return NextResponse.json({ error: 'Label must be at least 3 characters' }, { status: 400 });
    }

    const { projectId } = await context.params;

    const projectAccess = await assertProjectBelongsToTenant({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId,
    });
    if (!projectAccess.ok) {
      return NextResponse.json({ error: projectAccess.error }, { status: projectAccess.status });
    }

    const db = await getDatabase();

    const token = `cgate_${crypto.randomBytes(32).toString('hex')}`;

    const apiToken = await db.createApiToken({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      projectId,
      label: body.label.trim(),
      token,
    });

    return NextResponse.json(
      {
        message: 'API token created successfully',
        token,
        id: apiToken._id,
        label: apiToken.label,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('Create project token error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
