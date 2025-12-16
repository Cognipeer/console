import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    // Get tenant and user info from headers
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const userId = request.headers.get('x-user-id');
    const userRole = request.headers.get('x-user-role');

    if (!tenantDbName) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 });
    }

    // Only owners and admins can delete users
    if (userRole !== 'owner' && userRole !== 'admin') {
      return NextResponse.json(
        { error: 'Only owners and admins can delete users' },
        { status: 403 },
      );
    }

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    // Check if user is trying to delete themselves
    if (id === userId) {
      return NextResponse.json(
        { error: 'You cannot delete your own account' },
        { status: 400 },
      );
    }

    // Get user to check if they are an owner
    const userToDelete = await db.findUserById(id);
    if (!userToDelete) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Cannot delete owner
    if (userToDelete.role === 'owner') {
      return NextResponse.json(
        { error: 'Cannot delete the owner account' },
        { status: 403 },
      );
    }

    // Delete user
    const deleted = await db.deleteUser(id);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Failed to delete user' },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { message: 'User deleted successfully' },
      { status: 200 },
    );
  } catch (error) {
    console.error('Delete user error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
