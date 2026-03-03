/**
 * Client API – Agent Detail
 *
 * GET /api/client/v1/agents/[agentKey] → Get agent details by key
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { getAgentByKey } from '@/lib/services/agents/agentService';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-agent-detail');

export const runtime = 'nodejs';

export const GET = withRequestContext(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ agentKey: string }> },
  ) => {
    try {
      const ctx = await requireApiToken(request);
      const { tenantDbName, projectId } = ctx;
      const { agentKey } = await params;

      const agent = await getAgentByKey(tenantDbName, agentKey, projectId);
      if (!agent) {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      }

      return NextResponse.json({
        agent: {
          key: agent.key,
          name: agent.name,
          description: agent.description,
          config: {
            modelKey: agent.config.modelKey,
            temperature: agent.config.temperature,
            topP: agent.config.topP,
            maxTokens: agent.config.maxTokens,
          },
          status: agent.status,
          createdAt: agent.createdAt,
        },
      });
    } catch (error) {
      if (error instanceof ApiTokenAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      logger.error('Failed to get agent', { error });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
);
