import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  listConfigItems,
} from '@/lib/services/config/configService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-config');

/** GET /api/client/v1/config/items — List config items (flat, optionally filtered by groupId) */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireApiToken(request);
    const url = new URL(request.url);
    const groupId = url.searchParams.get('groupId') ?? undefined;
    const isSecret = url.searchParams.get('isSecret');
    const search = url.searchParams.get('search') ?? undefined;
    const tagsParam = url.searchParams.get('tags');
    const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()) : undefined;

    const items = await listConfigItems(
      ctx.tenantDbName,
      ctx.tenantId,
      ctx.projectId,
      {
        groupId,
        isSecret: isSecret !== null ? isSecret === 'true' : undefined,
        tags,
        search,
      },
    );

    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('List config items error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

