/**
 * Client API – Agent Responses (OpenAI Responses API compatible)
 *
 * POST /api/client/v1/responses → Invoke an agent
 *
 * The agent is identified by the `model` field in the request body (agent key).
 *
 * Request body follows OpenAI Responses API:
 *   { model, input, previous_response_id?, instructions?, temperature?, top_p?, max_output_tokens? }
 *
 * Response follows OpenAI Responses API:
 *   { id, object: "response", model, output, status, usage, created_at, previous_response_id }
 */

import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  getAgentByKey,
  executeAgentChat,
  createConversation,
  getConversationById,
} from '@/lib/services/agents/agentService';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-agent-chat');

/**
 * Extract user message text from Responses API `input` field.
 * `input` can be a plain string or an array of input items.
 */
function extractUserMessage(input: unknown): string | null {
  if (typeof input === 'string') return input;

  if (Array.isArray(input)) {
    // Find last user message in the array
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (item && typeof item === 'object') {
        // { role: "user", content: "..." }
        if (item.role === 'user' && typeof item.content === 'string') {
          return item.content;
        }
        // { type: "message", role: "user", content: [{type:"input_text", text:"..."}] }
        if (item.role === 'user' && Array.isArray(item.content)) {
          const textPart = item.content.find(
            (c: Record<string, unknown>) => c.type === 'input_text' && typeof c.text === 'string',
          );
          if (textPart) return textPart.text;
        }
      }
    }
  }

  return null;
}

/**
 * Resolve conversation ID from `previous_response_id`.
 * Response IDs follow the format `resp_{conversationId}`.
 */
function conversationIdFromResponseId(responseId: string): string | null {
  if (responseId.startsWith('resp_')) {
    return responseId.slice(5);
  }
  return null;
}

export const POST = withRequestContext(async (request: NextRequest) => {
  try {
    const ctx = await requireApiToken(request);
    const { tenantDbName, tenantId, projectId } = ctx;

    const body = await request.json();
    const { model, input, previous_response_id } = body;

    // `model` field carries the agent key
    if (!model || typeof model !== 'string') {
      return NextResponse.json(
        { error: 'model field is required and must contain the agent key' },
        { status: 400 },
      );
    }

    const agentKey = model;

    // Validate agent exists
    const agent = await getAgentByKey(tenantDbName, agentKey, projectId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    if (agent.status !== 'active') {
      return NextResponse.json({ error: 'Agent is not active' }, { status: 400 });
    }

    // Extract user message from `input` (string or array of messages)
    const userMessage = extractUserMessage(input);
    if (!userMessage) {
      return NextResponse.json(
        { error: 'input field is required (string or array of message items)' },
        { status: 400 },
      );
    }

    // Resolve or create conversation from previous_response_id
    let convId: string | undefined;
    if (previous_response_id && typeof previous_response_id === 'string') {
      const cid = conversationIdFromResponseId(previous_response_id);
      if (cid) {
        const conv = await getConversationById(tenantDbName, cid);
        if (!conv || conv.agentKey !== agent.key) {
          return NextResponse.json(
            { error: 'previous_response_id does not match a valid conversation' },
            { status: 404 },
          );
        }
        convId = cid;
      }
    }

    if (!convId) {
      const newConv = await createConversation(
        tenantDbName,
        tenantId,
        projectId,
        ctx.tokenRecord.userId,
        agent.key,
      );
      convId = String(newConv._id);
    }

    const result = await executeAgentChat({
      tenantDbName,
      tenantId,
      projectId,
      agentKey: agent.key,
      conversationId: convId,
      userMessage,
      userId: ctx.tokenRecord.userId,
    });

    // Return Responses API shape (strip internal fields)
    const responseBody = { ...result };
    delete responseBody._conversation_messages;
    return NextResponse.json(responseBody);
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Agent chat failed', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
