/**
 * Dashboard API – Tools
 *
 * GET  /api/tools  → List tools for the tenant
 * POST /api/tools  → Create a new tool
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createTool,
  listTools,
  serializeTool,
} from '@/lib/services/tools';
import {
  requireProjectContext,
  ProjectContextError,
} from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('api:tools');
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    if (!tenantDbName || !tenantId || !userId)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { projectId } = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const search = request.nextUrl.searchParams.get('search') || undefined;
    const status = (request.nextUrl.searchParams.get('status') as 'active' | 'disabled' | null) || undefined;
    const type = (request.nextUrl.searchParams.get('type') as 'openapi' | 'mcp' | null) || undefined;

    const tools = await listTools(tenantDbName, {
      projectId,
      status,
      type,
      search,
    });

    return NextResponse.json({
      tools: tools.map(serializeTool),
    });
  } catch (error) {
    if (error instanceof ProjectContextError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error('Failed to list tools', { error });
    return NextResponse.json({ error: 'Failed to list tools' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    if (!tenantDbName || !tenantId || !userId)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { projectId } = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const body = await request.json();
    const { name, description, type, openApiSpec, upstreamBaseUrl, upstreamAuth, mcpEndpoint, mcpTransport } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Tool name is required' }, { status: 400 });
    }

    if (!type || !['openapi', 'mcp'].includes(type)) {
      return NextResponse.json({ error: 'Tool type must be "openapi" or "mcp"' }, { status: 400 });
    }

    const tool = await createTool(tenantDbName, tenantId, userId, projectId, {
      name,
      description,
      type,
      openApiSpec,
      upstreamBaseUrl,
      upstreamAuth,
      mcpEndpoint,
      mcpTransport,
    });

    return NextResponse.json({ tool: serializeTool(tool) }, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectContextError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error('Failed to create tool', { error });
    const message = error instanceof Error ? error.message : 'Failed to create tool';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
