import { NextRequest, NextResponse } from 'next/server';
import { getAgentById, listAgentVersions, getAgentVersion } from '@/lib/services/agents';
import {
  requireProjectContext,
  ProjectContextError,
} from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('api:agents:versions');
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    if (!tenantDbName || !tenantId || !userId)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    await requireProjectContext(request, { tenantDbName, tenantId, userId });

    const { agentId } = await params;

    // Ensure agent exists
    const agent = await getAgentById(tenantDbName, agentId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Check if a specific version is requested
    const versionParam = request.nextUrl.searchParams.get('version');
    if (versionParam) {
      const version = await getAgentVersion(tenantDbName, agentId, parseInt(versionParam, 10));
      if (!version) {
        return NextResponse.json({ error: 'Version not found' }, { status: 404 });
      }
      return NextResponse.json({ version }, { status: 200 });
    }

    // List all versions with pagination
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50', 10);
    const skip = parseInt(request.nextUrl.searchParams.get('skip') || '0', 10);

    const result = await listAgentVersions(tenantDbName, agentId, { limit, skip });

    return NextResponse.json({
      versions: result.versions,
      total: result.total,
      publishedVersion: agent.publishedVersion ?? null,
    }, { status: 200 });
  } catch (error) {
    if (error instanceof ProjectContextError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error('Failed to list agent versions', { error });
    return NextResponse.json(
      { error: 'Failed to list agent versions' },
      { status: 500 },
    );
  }
}
