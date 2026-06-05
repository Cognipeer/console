import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listPrompts } from '@/lib/services/prompts';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-prompts');

function handleError(error: unknown, scope: string) {
  if (error instanceof ApiTokenAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  logger.error(`${scope} error`, { error });
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Internal server error' },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  try {
    const { tenantDbName, projectId } = await requireApiToken(request);
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') ?? undefined;

    const prompts = await listPrompts(tenantDbName, projectId, { search });
    return NextResponse.json({ prompts }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client list prompts');
  }
}
