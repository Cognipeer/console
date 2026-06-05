/**
 * Dashboard API – Execute Tool Action
 *
 * POST /api/tools/[toolId]/actions/[actionKey]/execute → Test execute a tool action
 */

import { NextResponse, type NextRequest } from '@/server/api/http';
import { getTool, executeToolAction, logToolRequest } from '@/lib/services/tools';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('api:tools:execute');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ toolId: string; actionKey: string }> },
) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    if (!tenantDbName || !tenantId)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { toolId, actionKey } = await params;
    const body = await request.json();
    const args = body.arguments ?? body.args ?? {};

    const tool = await getTool(tenantDbName, toolId);
    if (!tool)
      return NextResponse.json({ error: 'Tool not found' }, { status: 404 });

    if (tool.status !== 'active')
      return NextResponse.json({ error: 'Tool is disabled' }, { status: 400 });

    const action = tool.actions.find((a) => a.key === actionKey);
    const actionName = action?.name ?? actionKey;

    try {
      const { result, latencyMs } = await executeToolAction(tool, actionKey, args);

      // Log success (fire-and-forget)
      logToolRequest(
        tenantDbName, tenantId, tool.projectId,
        tool.key, actionKey, actionName,
        'success', latencyMs,
        args,
        typeof result === 'object' ? (result as Record<string, unknown>) : { value: result },
        undefined,
        'dashboard',
      );

      return NextResponse.json({ result, latencyMs });
    } catch (execError) {
      const errorMessage = execError instanceof Error ? execError.message : 'Execution failed';

      // Log error (fire-and-forget)
      logToolRequest(
        tenantDbName, tenantId, tool.projectId,
        tool.key, actionKey, actionName,
        'error', 0,
        args,
        undefined,
        errorMessage,
        'dashboard',
      );

      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
  } catch (error) {
    logger.error('Failed to execute tool action', { error });
    const message = error instanceof Error ? error.message : 'Execution failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
