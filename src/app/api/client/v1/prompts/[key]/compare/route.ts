import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { comparePromptVersions, getPromptByKey } from '@/lib/services/prompts';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-prompts');

export const runtime = 'nodejs';

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { tenantDbName, projectId } = await requireApiToken(request);
    const { key } = await params;

    if (!key) {
      return NextResponse.json({ error: 'Prompt key is required' }, { status: 400 });
    }

    const prompt = await getPromptByKey(tenantDbName, projectId, key);
    if (!prompt) {
      return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const fromVersionId = searchParams.get('fromVersionId')?.trim();
    const toVersionId = searchParams.get('toVersionId')?.trim();

    if (!fromVersionId || !toVersionId) {
      return NextResponse.json({ error: 'fromVersionId and toVersionId are required' }, { status: 400 });
    }

    const comparison = await comparePromptVersions(
      tenantDbName,
      projectId,
      prompt.id,
      fromVersionId,
      toVersionId,
    );

    if (!comparison) {
      return NextResponse.json({ error: 'Prompt or versions not found' }, { status: 404 });
    }

    return NextResponse.json({
      prompt: {
        id: prompt.id,
        key: prompt.key,
        name: prompt.name,
      },
      comparison,
    }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client compare prompt versions');
  }
}
