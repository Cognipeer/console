import { NextRequest, NextResponse } from 'next/server';
import {
  createModelProvider,
  listModelProviders,
} from '@/lib/services/models/modelService';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import type { ProviderStatus } from '@/lib/services/providers/providerService';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantSlug || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');
    const driver = searchParams.get('driver') ?? undefined;

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const providers = await listModelProviders(tenantDbName, tenantId, {
      status: statusParam as ProviderStatus | undefined,
      driver,
    });

    return NextResponse.json({ providers }, { status: 200 });
  } catch (error) {
    console.error('List model providers error', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantSlug || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const requiredFields = ['key', 'driver', 'label', 'credentials'];

    for (const field of requiredFields) {
      if (body[field] === undefined || body[field] === null || body[field] === '') {
        return NextResponse.json(
          { error: `${field} is required` },
          { status: 400 },
        );
      }
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const provider = await createModelProvider(tenantDbName, tenantId, {
      key: body.key,
      driver: body.driver,
      label: body.label,
      description: body.description,
      status: body.status,
      credentials: body.credentials,
      settings: body.settings,
      capabilitiesOverride: body.capabilitiesOverride,
      metadata: body.metadata,
      createdBy: userId,
    });

    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    console.error('Create model provider error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
