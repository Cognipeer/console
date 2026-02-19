import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  activatePromptDeployment,
  getPromptByKey,
  listPromptDeployments,
  planPromptDeployment,
  promotePromptVersion,
  rollbackPromptDeployment,
  type PromptEnvironment,
} from '@/lib/services/prompts';

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

function isPromptEnvironment(value: unknown): value is PromptEnvironment {
  return value === 'dev' || value === 'staging' || value === 'prod';
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

    const deployments = await listPromptDeployments(tenantDbName, projectId, prompt.id);

    return NextResponse.json({
      prompt: {
        id: prompt.id,
        key: prompt.key,
        name: prompt.name,
      },
      deployments,
    }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client list prompt deployments');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { tenantDbName, projectId, tokenRecord } = await requireApiToken(request);
    const { key } = await params;

    if (!key) {
      return NextResponse.json({ error: 'Prompt key is required' }, { status: 400 });
    }

    const prompt = await getPromptByKey(tenantDbName, projectId, key);
    if (!prompt) {
      return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const action = typeof body.action === 'string' ? body.action : '';
    const note = typeof body.note === 'string' ? body.note.trim() : undefined;
    const rawEnvironment = body.environment;

    if (!isPromptEnvironment(rawEnvironment)) {
      return NextResponse.json({ error: 'environment must be one of dev/staging/prod' }, { status: 400 });
    }

    let updatedPrompt = null;

    if (action === 'promote') {
      const versionId = typeof body.versionId === 'string' ? body.versionId.trim() : '';
      if (!versionId) {
        return NextResponse.json({ error: 'versionId is required for promote action' }, { status: 400 });
      }

      updatedPrompt = await promotePromptVersion(tenantDbName, projectId, prompt.id, tokenRecord.userId, {
        environment: rawEnvironment,
        versionId,
        note,
      });
    } else if (action === 'plan') {
      updatedPrompt = await planPromptDeployment(tenantDbName, projectId, prompt.id, tokenRecord.userId, {
        environment: rawEnvironment,
        note,
      });
    } else if (action === 'activate') {
      updatedPrompt = await activatePromptDeployment(
        tenantDbName,
        projectId,
        prompt.id,
        tokenRecord.userId,
        rawEnvironment,
        note,
      );
    } else if (action === 'rollback') {
      updatedPrompt = await rollbackPromptDeployment(
        tenantDbName,
        projectId,
        prompt.id,
        tokenRecord.userId,
        rawEnvironment,
        note,
      );
    } else {
      return NextResponse.json(
        { error: 'action must be one of promote, plan, activate, rollback' },
        { status: 400 },
      );
    }

    if (!updatedPrompt) {
      return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
    }

    const deployments = await listPromptDeployments(tenantDbName, projectId, prompt.id);

    return NextResponse.json({ prompt: updatedPrompt, deployments }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client mutate prompt deployment');
  }
}
