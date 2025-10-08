import { NextRequest, NextResponse } from 'next/server';
import { providerRegistry } from '@/lib/providers';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{
    driverId: string;
  }>;
}

export async function GET(
  _request: NextRequest,
  context: RouteContext,
) {
  try {
    const { driverId } = await context.params;
    const schema = providerRegistry.getFormSchema(driverId);
    const descriptor = providerRegistry
      .listDescriptors()
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
    console.error('Get provider driver form error', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to load form schema',
      },
      { status: 404 },
    );
  }
}
