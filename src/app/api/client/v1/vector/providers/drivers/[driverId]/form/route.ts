import { NextRequest, NextResponse } from 'next/server';
import { providerRegistry } from '@/lib/providers';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-vector');

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{
    driverId: string;
  }>;
}

function handleError(error: unknown) {
  if (error instanceof ApiTokenAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  logger.error('Get vector provider driver form error', { error });
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Failed to load form schema' },
    { status: 404 },
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await requireApiToken(request);
    const { driverId } = await context.params;
    const schema = providerRegistry.getFormSchema(driverId);
    const descriptor = providerRegistry
      .listDescriptors('vector')
      .find((item) => item.id === driverId);

    return NextResponse.json(
      {
        driverId,
        schema,
        descriptor,
      },
      { status: 200 },
    );
  } catch (error) {
    return handleError(error);
  }
}
