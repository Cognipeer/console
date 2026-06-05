/**
 * Dashboard API – Tool Detail
 *
 * GET    /api/tools/[toolId]  → Get tool details (with optional aggregate)
 * PUT    /api/tools/[toolId]  → Update tool
 * DELETE /api/tools/[toolId]  → Delete tool
 */

import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  getTool,
  updateTool,
  deleteTool,
  syncToolActions,
  serializeTool,
  aggregateToolRequestLogs,
} from '@/lib/services/tools';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('api:tools:detail');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ toolId: string }> },
) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    if (!tenantDbName)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { toolId } = await params;
    const tool = await getTool(tenantDbName, toolId);
    if (!tool)
      return NextResponse.json({ error: 'Tool not found' }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const includeAggregate = searchParams.get('includeAggregate') === 'true';

    const payload: Record<string, unknown> = { tool: serializeTool(tool) };

    if (includeAggregate) {
      const aggregate = await aggregateToolRequestLogs(tenantDbName, tool.key, { groupBy: 'day' });
      payload.aggregate = aggregate;
    }

    return NextResponse.json(payload);
  } catch (error) {
    logger.error('Failed to get tool', { error });
    return NextResponse.json({ error: 'Failed to get tool' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ toolId: string }> },
) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const userId = request.headers.get('x-user-id');
    if (!tenantDbName || !userId)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { toolId } = await params;
    const body = await request.json();

    // If sync=true is passed, re-sync actions from source
    if (body.sync === true) {
      const synced = await syncToolActions(tenantDbName, toolId, userId);
      if (!synced)
        return NextResponse.json({ error: 'Tool not found' }, { status: 404 });
      return NextResponse.json({ tool: serializeTool(synced) });
    }

    const tool = await updateTool(tenantDbName, toolId, userId, body);
    if (!tool)
      return NextResponse.json({ error: 'Tool not found' }, { status: 404 });

    return NextResponse.json({ tool: serializeTool(tool) });
  } catch (error) {
    logger.error('Failed to update tool', { error });
    const message = error instanceof Error ? error.message : 'Failed to update tool';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ toolId: string }> },
) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    if (!tenantDbName)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { toolId } = await params;
    const deleted = await deleteTool(tenantDbName, toolId);
    if (!deleted)
      return NextResponse.json({ error: 'Tool not found' }, { status: 404 });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete tool', { error });
    return NextResponse.json({ error: 'Failed to delete tool' }, { status: 500 });
  }
}
