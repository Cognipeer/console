import { NextResponse, type NextRequest } from '@/server/api/http';
import { providerRegistry } from '@/lib/providers';
import type { ProviderDomain } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('model-drivers');

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const domainParam = searchParams.get('domain');
    const domain = (domainParam as ProviderDomain | null) ?? 'model';
    const drivers = providerRegistry.listDescriptors(domain);
    return NextResponse.json({ drivers }, { status: 200 });
  } catch (error) {
    logger.error('List model provider drivers error', { error });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
