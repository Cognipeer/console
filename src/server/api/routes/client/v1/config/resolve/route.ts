import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { resolveConfigValues } from '@/lib/services/config/configService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-config-resolve');

/** POST /api/client/v1/config/resolve — Resolve config values by keys (decrypts secrets) */
export async function POST(request: NextRequest) {
  try {
    const ctx = await requireApiToken(request);
    const body = await request.json();

    if (!body.keys || !Array.isArray(body.keys) || body.keys.length === 0) {
      return NextResponse.json({ error: 'keys array is required' }, { status: 400 });
    }

    if (body.keys.length > 50) {
      return NextResponse.json({ error: 'Maximum 50 keys per request' }, { status: 400 });
    }

    const result = await resolveConfigValues(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      {
        keys: body.keys,
      },
      ctx.user?.email ?? ctx.tokenRecord.userId,
    );

    return NextResponse.json({ configs: result });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Resolve config error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
