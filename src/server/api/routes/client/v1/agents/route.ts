/**
 * Client API – Agents
 *
 * GET  /api/client/v1/agents  → List agents for the tenant
 * POST /api/client/v1/agents  → (reserved)
 */

import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listAgents } from '@/lib/services/agents/agentService';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-agents');

export const GET = withRequestContext(async (request: NextRequest) => {
  try {
    const ctx = await requireApiToken(request);
    const { tenantDbName, projectId } = ctx;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') as 'active' | 'inactive' | 'draft' | null;

    const agents = await listAgents(tenantDbName, {
      projectId,
      ...(status ? { status } : {}),
    });

    // Strip internal fields
    const sanitized = agents.map((a) => ({
      key: a.key,
      name: a.name,
      description: a.description,
      config: {
        modelKey: a.config.modelKey,
        temperature: a.config.temperature,
        topP: a.config.topP,
        maxTokens: a.config.maxTokens,
      },
      status: a.status,
      createdAt: a.createdAt,
    }));

    return NextResponse.json({ agents: sanitized });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Failed to list agents', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
