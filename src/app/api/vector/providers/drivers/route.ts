import { NextRequest, NextResponse } from 'next/server';
import { providerRegistry } from '@/lib/providers';
import type { ProviderDomain } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('vector-drivers');

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
  const domainParam = searchParams.get('domain');
  const domain = (domainParam as ProviderDomain | null) ?? 'vector';
  const drivers = providerRegistry.listDescriptors(domain);
    return NextResponse.json({ drivers }, { status: 200 });
  } catch (error) {
    logger.error('List vector provider drivers error', { error });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
