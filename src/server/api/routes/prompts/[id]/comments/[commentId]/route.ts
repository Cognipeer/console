import { NextResponse, type NextRequest } from '@/server/api/http';
import { deletePromptComment } from '@/lib/services/prompts';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('prompt-comments');

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; commentId: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db');
  const { commentId } = await context.params;

  if (!tenantDbName) {
    return NextResponse.json(
      { error: 'Missing tenant information' },
      { status: 400 },
    );
  }

  try {
    const deleted = await deletePromptComment(tenantDbName, commentId);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Comment not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Error deleting prompt comment', { error });
    return NextResponse.json(
      { error: 'Failed to delete comment' },
      { status: 500 },
    );
  }
}
