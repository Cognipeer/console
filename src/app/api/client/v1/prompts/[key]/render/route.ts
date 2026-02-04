import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { getPromptByKey, renderPromptTemplate } from '@/lib/services/prompts';

export const runtime = 'nodejs';

function handleError(error: unknown, scope: string) {
  if (error instanceof ApiTokenAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error(`${scope} error`, error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Internal server error' },
    { status: 500 },
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { tenantDbName, projectId } = await requireApiToken(request);
    const { key } = await params;

    if (!key) {
      return NextResponse.json({ error: 'Prompt key is required' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    
    // Check for optional version in body or query
    const { searchParams } = new URL(request.url);
    const versionParam = searchParams.get('version') || body?.version;
    const version = versionParam ? parseInt(String(versionParam), 10) : undefined;

    if (versionParam && (Number.isNaN(version) || version === undefined || version < 1)) {
      return NextResponse.json({ error: 'Invalid version number' }, { status: 400 });
    }

    const prompt = await getPromptByKey(tenantDbName, projectId, key, version);
    if (!prompt) {
      return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
    }

    const data = body?.data && typeof body.data === 'object' ? body.data : body?.variables;

    const rendered = renderPromptTemplate(prompt.template, data ?? {});

    return NextResponse.json(
      {
        prompt: {
          key: prompt.key,
          name: prompt.name,
          description: prompt.description,
          version: prompt.currentVersion,
        },
        rendered,
      },
      { status: 200 },
    );
  } catch (error) {
    return handleError(error, 'Client render prompt');
  }
}
