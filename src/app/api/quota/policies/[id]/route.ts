import { NextRequest, NextResponse } from 'next/server';
import {
  deleteQuotaPolicy,
  updateQuotaPolicy,
} from '@/lib/services/quota/quotaService';
import type { QuotaPolicyInput } from '@/lib/quota/types';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('quota-policies');

export const runtime = 'nodejs';

function ensureTenantContext(request: NextRequest) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const userId = request.headers.get('x-user-id');
  const userRole = request.headers.get('x-user-role');

  if (!tenantDbName || !tenantId || !userId) {
    return { error: { error: 'Unauthorized' } } as const;
  }

  return {
    tenantDbName,
    tenantId,
    userId,
    userRole,
  } as const;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = ensureTenantContext(request);
    if ('error' in ctx) {
      return NextResponse.json(ctx.error, { status: 401 });
    }

    if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = (await request.json()) as Partial<QuotaPolicyInput>;

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId') ?? body.projectId;

    const policy = await updateQuotaPolicy(
      ctx.tenantDbName,
      ctx.tenantId,
      id,
      { ...body, updatedBy: ctx.userId },
      projectId ?? undefined,
    );

    if (!policy) {
      return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
    }

    return NextResponse.json({ policy }, { status: 200 });
  } catch (error) {
    logger.error('Update quota policy error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = ensureTenantContext(request);
    if ('error' in ctx) {
      return NextResponse.json(ctx.error, { status: 401 });
    }

    if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId') ?? undefined;

    const deleted = await deleteQuotaPolicy(
      ctx.tenantDbName,
      ctx.tenantId,
      id,
      projectId,
    );
    if (!deleted) {
      return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('Delete quota policy error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
