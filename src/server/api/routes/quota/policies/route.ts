import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  createQuotaPolicy,
  listQuotaPolicies,
} from '@/lib/services/quota/quotaService';
import type { QuotaPolicyInput, QuotaDomain, QuotaScope } from '@/lib/quota/types';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('quota-policies');

function ensureTenantContext(request: NextRequest) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const userId = request.headers.get('x-user-id');
  const userRole = request.headers.get('x-user-role');

  if (!tenantDbName || !tenantId || !userId) {
    return { error: { message: 'Unauthorized' } } as const;
  }

  return {
    tenantDbName,
    tenantId,
    userId,
    userRole,
  } as const;
}

export async function GET(request: NextRequest) {
  try {
    const ctx = ensureTenantContext(request);
    if ('error' in ctx) {
      return NextResponse.json(ctx.error, { status: 401 });
    }

    // Parse query params for filtering
    const { searchParams } = new URL(request.url);
    const domain = searchParams.get('domain') as QuotaDomain | null;
    const scope = searchParams.get('scope') as QuotaScope | null;
    const projectId = searchParams.get('projectId') ?? undefined;
    const enabledParam = searchParams.get('enabled');
    const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;

    const policies = await listQuotaPolicies(ctx.tenantDbName, ctx.tenantId, {
      domain: domain || undefined,
      scope: scope || undefined,
      enabled,
      projectId,
    });
    
    return NextResponse.json({ policies }, { status: 200 });
  } catch (error) {
    logger.error('List quota policies error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = ensureTenantContext(request);
    if ('error' in ctx) {
      return NextResponse.json(ctx.error, { status: 401 });
    }

    if (ctx.userRole !== 'owner' && ctx.userRole !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const projectIdParam = searchParams.get('projectId') ?? undefined;

    const body = (await request.json()) as Partial<QuotaPolicyInput>;

    if (!body.scope || !body.domain || !body.limits) {
      return NextResponse.json(
        { error: 'scope, domain and limits are required' },
        { status: 400 },
      );
    }

    const payload: QuotaPolicyInput = {
      projectId: projectIdParam ?? body.projectId,
      scope: body.scope,
      scopeId: body.scopeId,
      domain: body.domain,
      priority: Number(body.priority ?? 100),
      limits: body.limits,
      enabled: body.enabled ?? true,
      label: body.label ?? 'Custom policy',
      description: body.description,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };

    const policy = await createQuotaPolicy(
      ctx.tenantDbName,
      ctx.tenantId,
      payload,
    );

    return NextResponse.json({ policy }, { status: 201 });
  } catch (error) {
    logger.error('Create quota policy error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
