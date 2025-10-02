import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';
import crypto from 'crypto';

export async function GET(request: NextRequest) {
  try {
    // Get tenant and user info from headers
    const tenantSlug = request.headers.get('x-tenant-slug');
    const userId = request.headers.get('x-user-id');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantSlug || !userId || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await getDatabase();
    // No need to switch to tenant - tokens are in main DB

    // Get all tokens for the user
    const tokens = await db.listApiTokens(userId);

    return NextResponse.json({ tokens }, { status: 200 });
  } catch (error) {
    console.error('List tokens error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { label } = await request.json();

    // Get tenant and user info from headers
    const tenantSlug = request.headers.get('x-tenant-slug');
    const userId = request.headers.get('x-user-id');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantSlug || !userId || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Validation
    if (!label || label.length < 3) {
      return NextResponse.json(
        { error: 'Label must be at least 3 characters' },
        { status: 400 },
      );
    }

    const db = await getDatabase();
    // No need to switch to tenant - tokens are in main DB

    // Generate a secure random token
    const token = `cgate_${crypto.randomBytes(32).toString('hex')}`;

    // Create token in database
    const apiToken = await db.createApiToken({
      userId,
      tenantId,
      label,
      token,
    });

    // Return the full token only once
    return NextResponse.json(
      {
        message: 'API token created successfully',
        token: token, // Full token returned only once
        id: apiToken._id,
        label: apiToken.label,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('Create token error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
