/**
 * Client API – Tools
 *
 * GET /api/client/v1/tools → List tools for the tenant
 */

import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listTools } from '@/lib/services/tools';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-tools');

export const GET = withRequestContext(async (request: NextRequest) => {
  try {
    const ctx = await requireApiToken(request);
    const { tenantDbName, projectId } = ctx;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') as 'active' | 'disabled' | null;
    const type = searchParams.get('type') as 'openapi' | 'mcp' | null;

    const tools = await listTools(tenantDbName, {
      projectId,
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
    });

    return NextResponse.json({
      tools: tools.map((t) => ({
        key: t.key,
        name: t.name,
        description: t.description,
        type: t.type,
        status: t.status,
        actions: t.actions.map((a) => ({
          key: a.key,
          name: a.name,
          description: a.description,
          inputSchema: a.inputSchema,
        })),
        createdAt: t.createdAt,
      })),
    });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Failed to list tools', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
