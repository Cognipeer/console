import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { getPromptByKey, listPromptVersions } from '@/lib/services/prompts';
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

    // First, get the prompt to find its ID
    const prompt = await getPromptByKey(tenantDbName, projectId, key);
    if (!prompt) {
      return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
    }

    const versions = await listPromptVersions(tenantDbName, projectId, prompt.id);

    return NextResponse.json({ 
      prompt: {
        key: prompt.key,
        name: prompt.name,
      },
      versions: versions.map(v => ({
        id: v.id,
        version: v.version,
        name: v.name,
        description: v.description,
        comment: v.comment,
        isLatest: v.isLatest,
        createdAt: v.createdAt,
        createdBy: v.createdBy,
      })),
    }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client list prompt versions');
  }
}
