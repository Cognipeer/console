import { NextResponse, type NextRequest } from '@/server/api/http';
import { getPlanDefaults } from '@/lib/services/quota/quotaService';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('quota');

export async function GET(request: NextRequest) {
  try {
    const licenseTypeHeader = request.headers.get('x-license-type');

    if (!licenseTypeHeader) {
      return NextResponse.json(
        { error: 'License type not found on request' },
        { status: 400 },
      );
    }

    const licenseType = licenseTypeHeader as LicenseType;
    const defaults = await getPlanDefaults(licenseType);

    return NextResponse.json({ licenseType, defaults }, { status: 200 });
  } catch (error) {
    logger.error('Get quota defaults error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
