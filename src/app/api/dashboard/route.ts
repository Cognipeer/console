import { NextRequest, NextResponse } from 'next/server';
import { getDashboardData } from '@/lib/services/dashboard/dashboardService';
import {
  requireProjectContext,
  ProjectContextError,
} from '@/lib/services/projects/projectContext';

export const runtime = 'nodejs';

/**
 * GET /api/dashboard
 * Fetches aggregated dashboard data for the current project
 */
export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const userEmail = request.headers.get('x-user-email');
    const licenseType = request.headers.get('x-license-type');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const data = await getDashboardData(
      tenantDbName,
      tenantId,
      projectContext.projectId,
    );

    return NextResponse.json({
      ...data,
      user: {
        email: userEmail,
        licenseType: licenseType || 'FREE',
      },
    });
  } catch (error: unknown) {
    console.error('Dashboard data error:', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to fetch dashboard data',
      },
      { status: 500 },
    );
  }
}
