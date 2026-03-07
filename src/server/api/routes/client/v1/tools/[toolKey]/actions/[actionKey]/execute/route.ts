/**
 * Client API – Execute Tool Action
 *
 * POST /api/client/v1/tools/[toolKey]/actions/[actionKey]/execute
 *
 * Executes a specific action on a tool with the provided arguments.
 */

import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { getToolByKey, executeToolAction, logToolRequest } from '@/lib/services/tools';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-tool-execute');

export const POST = withRequestContext(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ toolKey: string; actionKey: string }> },
  ) => {
    try {
      const ctx = await requireApiToken(request);
      const { tenantDbName, tenantId, projectId, tokenRecord } = ctx;
      const callerTokenId = String(tokenRecord._id ?? '');
      const { toolKey, actionKey } = await params;

      const tool = await getToolByKey(tenantDbName, toolKey, projectId);
      if (!tool) {
        return NextResponse.json({ error: 'Tool not found' }, { status: 404 });
      }

      if (tool.status !== 'active') {
        return NextResponse.json({ error: 'Tool is disabled' }, { status: 403 });
      }

      const body = await request.json().catch(() => ({}));
      const args = body.arguments ?? body.args ?? {};

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
          'api',
          callerTokenId,
        );

        return NextResponse.json({
          result,
          latencyMs,
          toolKey: tool.key,
          actionKey,
        });
      } catch (execError) {
        const errorMessage = execError instanceof Error ? execError.message : 'Failed to execute tool action';

        // Log error (fire-and-forget)
        logToolRequest(
          tenantDbName, tenantId, tool.projectId,
          tool.key, actionKey, actionName,
          'error', 0,
          args,
          undefined,
          errorMessage,
          'api',
          callerTokenId,
        );

        return NextResponse.json({ error: errorMessage }, { status: 400 });
      }
    } catch (error) {
      if (error instanceof ApiTokenAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      logger.error('Failed to execute tool action', { error });
      const message = error instanceof Error ? error.message : 'Failed to execute tool action';
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
