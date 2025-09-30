import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    
    // Get tenant and user info from headers
    const tenantSlug = request.headers.get('x-tenant-slug');
    const userId = request.headers.get('x-user-id');

    if (!tenantSlug || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await getDatabase();
    // No need to switch to tenant - tokens are in main DB

    // Delete token (ensures it belongs to the user)
    const deleted = await db.deleteApiToken(id, userId);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Token not found or does not belong to you' },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { message: 'API token deleted successfully' },
      { status: 200 }
    );
  } catch (error) {
    console.error('Delete token error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
