import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listConfigAuditLogs } from '@/lib/services/config/configService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-config-audit');

/** GET /api/client/v1/config/items/[key]/audit — List audit logs for a config item */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { key } = await params;
    const ctx = await requireApiToken(request);
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const skip = parseInt(url.searchParams.get('skip') ?? '0', 10);

    const logs = await listConfigAuditLogs(
      ctx.tenantDbName,
      ctx.tenantId,
      key,
      { limit: Math.min(limit, 100), skip },
    );

    return NextResponse.json({ logs });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('List config audit logs error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
