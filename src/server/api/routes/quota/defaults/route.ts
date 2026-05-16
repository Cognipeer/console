import { NextResponse, type NextRequest } from '@/server/api/http';
import { getLicenseDefaults } from '@/lib/services/quota/quotaService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('quota');

export async function GET(request: NextRequest) {
  try {
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantId) {
      return NextResponse.json(
        { error: 'Tenant not found on request' },
        { status: 400 },
      );
    }

    const license = await getLicenseDefaults(tenantId);
    const defaults = license.limits;

    return NextResponse.json({ licenseType: license.licenseType, defaults, license }, { status: 200 });
  } catch (error) {
    logger.error('Get quota defaults error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
