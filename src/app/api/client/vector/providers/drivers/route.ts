import { NextRequest, NextResponse } from 'next/server';
import { providerRegistry } from '@/lib/providers';
import type { ProviderDomain } from '@/lib/database';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';

export const runtime = 'nodejs';

function handleError(error: unknown) {
  if (error instanceof ApiTokenAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error('Client list vector provider drivers error', error);
  return NextResponse.json(
    { error: 'Internal server error' },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  try {
    await requireApiToken(request);
    const { searchParams } = new URL(request.url);
    const domainParam = searchParams.get('domain');
    const domain = (domainParam as ProviderDomain | null) ?? 'vector';
    const drivers = providerRegistry.listDescriptors(domain);

    return NextResponse.json({ drivers }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
