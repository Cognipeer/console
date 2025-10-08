import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import {
  deleteProviderConfig,
  getProviderConfigById,
  updateProviderConfig,
  type UpdateProviderConfigInput,
} from '@/lib/services/providers/providerService';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{
    id: string;
  }>;
}

function sanitizeUpdatePayload(body: unknown): UpdateProviderConfigInput {
  const payload: UpdateProviderConfigInput = {};

  if (typeof body !== 'object' || body === null) {
    return payload;
  }

  const record = body as Record<string, unknown>;

  if (typeof record.label === 'string') {
    payload.label = record.label;
  }

  if (typeof record.description === 'string' || record.description === null) {
    payload.description = (record.description ?? undefined) as string | undefined;
  }

  if (
    record.status === 'active' ||
    record.status === 'disabled' ||
    record.status === 'errored'
  ) {
    payload.status = record.status;
  }

  if (typeof record.settings === 'object' && record.settings !== null) {
    payload.settings = record.settings as Record<string, unknown>;
  }

  if (
    Array.isArray(record.capabilitiesOverride) &&
    record.capabilitiesOverride.every((item) => typeof item === 'string')
  ) {
    payload.capabilitiesOverride = record.capabilitiesOverride as string[];
  }

  if (typeof record.metadata === 'object' && record.metadata !== null) {
    payload.metadata = record.metadata as Record<string, unknown>;
  }

  if (typeof record.credentials === 'object' && record.credentials !== null) {
    payload.credentials = record.credentials as Record<string, unknown>;
  }

  return payload;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantSlug || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const provider = await getProviderConfigById(tenantDbName, id);

    if (!provider || provider.tenantId !== tenantId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ provider }, { status: 200 });
  } catch (error) {
    console.error('Get provider config error', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantSlug || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const existing = await getProviderConfigById(tenantDbName, id);

    if (!existing || existing.tenantId !== tenantId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = await request.json();
    const payload = sanitizeUpdatePayload(body);
    payload.updatedBy = userId;

    const updated = await updateProviderConfig(tenantDbName, id, payload);

    if (!updated) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ provider: updated }, { status: 200 });
  } catch (error) {
    console.error('Update provider config error', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantSlug || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const existing = await getProviderConfigById(tenantDbName, id);

    if (!existing || existing.tenantId !== tenantId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const deleted = await deleteProviderConfig(tenantDbName, id);

    if (!deleted) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('Delete provider config error', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
