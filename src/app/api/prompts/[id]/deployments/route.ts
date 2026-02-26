import { NextRequest, NextResponse } from 'next/server';
import {
  activatePromptDeployment,
  listPromptDeployments,
  planPromptDeployment,
  promotePromptVersion,
  rollbackPromptDeployment,
  type PromptEnvironment,
} from '@/lib/services/prompts';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('prompt-deployments');

export const runtime = 'nodejs';

function isPromptEnvironment(value: unknown): value is PromptEnvironment {
  return value === 'dev' || value === 'staging' || value === 'prod';
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const { id } = await params;
    const deployments = await listPromptDeployments(tenantDbName, projectContext.projectId, id);

    if (!deployments) {
      return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
    }

    return NextResponse.json(deployments, { status: 200 });
  } catch (error: unknown) {
    logger.error('List prompt deployments error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const { id } = await params;
    const body = await request.json().catch(() => ({} as Record<string, unknown>));

    const action = typeof body.action === 'string' ? body.action : '';
    const note = typeof body.note === 'string' ? body.note.trim() : undefined;
    const rawEnvironment = body.environment;

    if (!isPromptEnvironment(rawEnvironment)) {
      return NextResponse.json({ error: 'environment must be one of dev/staging/prod' }, { status: 400 });
    }

    let prompt = null;

    if (action === 'promote') {
      const versionId = typeof body.versionId === 'string' ? body.versionId.trim() : '';
      if (!versionId) {
        return NextResponse.json({ error: 'versionId is required for promote action' }, { status: 400 });
      }

      prompt = await promotePromptVersion(tenantDbName, projectContext.projectId, id, userId, {
        environment: rawEnvironment,
        versionId,
        note,
      });
    } else if (action === 'plan') {
      prompt = await planPromptDeployment(tenantDbName, projectContext.projectId, id, userId, {
        environment: rawEnvironment,
        note,
      });
    } else if (action === 'activate') {
      prompt = await activatePromptDeployment(
        tenantDbName,
        projectContext.projectId,
        id,
        userId,
        rawEnvironment,
        note,
      );
    } else if (action === 'rollback') {
      prompt = await rollbackPromptDeployment(
        tenantDbName,
        projectContext.projectId,
        id,
        userId,
        rawEnvironment,
        note,
      );
    } else {
      return NextResponse.json(
        { error: 'action must be one of promote, plan, activate, rollback' },
        { status: 400 },
      );
    }

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
    }

    const deployments = await listPromptDeployments(tenantDbName, projectContext.projectId, id);

    return NextResponse.json({ prompt, deployments }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Mutate prompt deployment error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
