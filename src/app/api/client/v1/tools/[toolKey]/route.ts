/**
 * Client API – Tool Detail
 *
 * GET /api/client/v1/tools/[toolKey] → Get tool details by key
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { getToolByKey } from '@/lib/services/tools';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-tool-detail');

export const runtime = 'nodejs';

export const GET = withRequestContext(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ toolKey: string }> },
  ) => {
    try {
      const ctx = await requireApiToken(request);
      const { tenantDbName, projectId } = ctx;
      const { toolKey } = await params;

      const tool = await getToolByKey(tenantDbName, toolKey, projectId);
      if (!tool) {
        return NextResponse.json({ error: 'Tool not found' }, { status: 404 });
      }

      return NextResponse.json({
        tool: {
          key: tool.key,
          name: tool.name,
          description: tool.description,
          type: tool.type,
          status: tool.status,
          actions: tool.actions.map((a) => ({
            key: a.key,
            name: a.name,
            description: a.description,
            inputSchema: a.inputSchema,
          })),
          createdAt: tool.createdAt,
        },
      });
    } catch (error) {
      if (error instanceof ApiTokenAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      logger.error('Failed to get tool', { error });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
);
