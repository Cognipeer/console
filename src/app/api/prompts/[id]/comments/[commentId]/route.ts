import { NextRequest, NextResponse } from 'next/server';
import { deletePromptComment } from '@/lib/services/prompts';

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
    console.error('[API] Error deleting prompt comment:', error);
    return NextResponse.json(
      { error: 'Failed to delete comment' },
      { status: 500 },
    );
  }
}
