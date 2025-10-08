import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  createVectorProvider,
  listVectorProviders,
} from '@/lib/services/vector';
import type { ProviderStatus } from '@/lib/services/providers/providerService';

export const runtime = 'nodejs';

function handleError(error: unknown, scope: string) {
  if (error instanceof ApiTokenAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error(`${scope} error`, error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Internal server error' },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  try {
    const { tenantId, tenantDbName } = await requireApiToken(request);
    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');
    const driver = searchParams.get('driver') ?? undefined;

    const providers = await listVectorProviders(tenantDbName, tenantId, {
      status: statusParam as ProviderStatus | undefined,
      driver: driver ?? undefined,
    });

    return NextResponse.json({ providers }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client list vector providers');
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireApiToken(request);
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

    const provider = await createVectorProvider(context.tenantDbName, context.tenantId, {
      key: body.key,
      driver: body.driver,
      label: body.label,
      description: body.description,
      status: body.status,
      credentials: body.credentials,
      settings: body.settings,
      capabilitiesOverride: body.capabilitiesOverride,
      metadata: body.metadata,
      createdBy: context.tokenRecord.userId,
    });

    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    return handleError(error, 'Client create vector provider');
  }
}
