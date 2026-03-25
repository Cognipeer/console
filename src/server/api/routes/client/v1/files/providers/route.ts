import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { createFileProvider, listFileProviders } from '@/lib/services/files';
import type { ProviderStatus } from '@/lib/services/providers/providerService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-file-providers');

function handleError(error: unknown, scope: string) {
  if (error instanceof ApiTokenAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  logger.error(`${scope} error`, { error });
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Internal server error' },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  try {
    const { tenantId, tenantDbName, projectId } = await requireApiToken(request);
    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');
    const driver = searchParams.get('driver') ?? undefined;

    const providers = await listFileProviders(tenantDbName, tenantId, projectId, {
      status: statusParam as ProviderStatus | undefined,
      driver,
    });

    return NextResponse.json({ providers }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client list file providers');
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

    const provider = await createFileProvider(
      context.tenantDbName,
      context.tenantId,
      context.projectId,
      {
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
      },
    );

    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    return handleError(error, 'Client create file provider');
  }
}
