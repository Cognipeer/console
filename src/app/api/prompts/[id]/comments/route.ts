import { NextRequest, NextResponse } from 'next/server';
import {
  createPromptComment,
  listPromptComments,
} from '@/lib/services/prompts';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('prompt-comments');

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db');
  const projectId = request.headers.get('x-project-id');
  const { id: promptId } = await context.params;
  const { searchParams } = new URL(request.url);
  const versionId = searchParams.get('versionId') ?? undefined;

  if (!tenantDbName || !projectId) {
    return NextResponse.json(
      { error: 'Missing tenant or project information' },
      { status: 400 },
    );
  }

  try {
    const comments = await listPromptComments(
      tenantDbName,
      projectId,
      promptId,
      versionId,
    );
    return NextResponse.json({ comments });
  } catch (error) {
    logger.error('Error listing prompt comments', { error });
    return NextResponse.json(
      { error: 'Failed to list comments' },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db');
  const tenantId = request.headers.get('x-tenant-id');
  const projectId = request.headers.get('x-project-id');
  const userId = request.headers.get('x-user-id');
  const userName = request.headers.get('x-user-name') ?? 'Unknown';
  const { id: promptId } = await context.params;

  if (!tenantDbName || !tenantId || !projectId || !userId) {
    return NextResponse.json(
      { error: 'Missing tenant or user information' },
      { status: 400 },
    );
  }

  try {
    const body = await request.json();
    const { content, versionId, version } = body;

    if (!content?.trim()) {
      return NextResponse.json(
        { error: 'Comment content is required' },
        { status: 400 },
      );
    }

    const comment = await createPromptComment(
      tenantDbName,
      tenantId,
      projectId,
      promptId,
      userId,
      userName,
      { content: content.trim(), versionId, version },
    );

    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    logger.error('Error creating prompt comment', { error });
    return NextResponse.json(
      { error: 'Failed to create comment' },
      { status: 500 },
    );
  }
}
