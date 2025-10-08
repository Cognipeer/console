import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import {
  createProviderConfig,
  listProviderConfigs,
  type CreateProviderConfigInput,
  type ProviderStatus,
} from '@/lib/services/providers/providerService';
import type { ProviderDomain } from '@/lib/database';

export const runtime = 'nodejs';

function parseStatus(value: string | null): ProviderStatus | undefined {
  if (!value) return undefined;
  if (value === 'active' || value === 'disabled' || value === 'errored') {
    return value;
  }
  return undefined;
}

export async function GET(request: NextRequest) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantSlug || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') as ProviderDomain | null;
    const driver = searchParams.get('driver');
    const status = parseStatus(searchParams.get('status'));

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const providers = await listProviderConfigs(tenantDbName, tenantId, {
      type: type ?? undefined,
      driver: driver ?? undefined,
      status,
    });

    return NextResponse.json({ providers }, { status: 200 });
  } catch (error) {
    console.error('List providers error', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

function validateCreatePayload(body: any): asserts body is CreateProviderConfigInput {
  const requiredFields = ['key', 'type', 'driver', 'label', 'credentials', 'createdBy'];
  for (const field of requiredFields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw new Error(`${field} is required`);
    }
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
    body.createdBy = userId;
    validateCreatePayload(body);

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const provider = await createProviderConfig(tenantDbName, tenantId, {
      key: body.key,
      type: body.type,
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
    if (error instanceof Error) {
      if (error.message.includes('already exists')) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      console.error('Create provider error', error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error('Create provider error', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
