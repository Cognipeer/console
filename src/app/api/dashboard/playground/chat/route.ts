import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

export const runtime = 'nodejs';

type MessageContentPart = string | { text?: string };

type ChatMessage = {
  role?: string;
  content?: string | MessageContentPart[];
};

type PlaygroundChatRequest = {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
};

function sanitize(value: unknown, max = 20000) {
  if (value === null || value === undefined) return value;
  try {
    const str = JSON.stringify(value);
    if (str.length <= max) return value;
    return { truncated: true, preview: str.slice(0, max) };
  } catch {
    return '[unserializable]';
  }
}

/**
 * POST /api/dashboard/playground/chat
 * Internal endpoint for playground chat completions.
 * Uses session cookie auth instead of API token.
 */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  // Get tenant info from middleware-injected headers
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const userId = request.headers.get('x-user-id');

  if (!tenantDbName || !tenantId || !userId) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // Get project context
  let projectId: string;
  try {
    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });
    projectId = projectContext.projectId;
  } catch (error) {
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Project context required' }, { status: 400 });
  }

  // Parse request body
  let body: PlaygroundChatRequest;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === 'object' ? (parsed as PlaygroundChatRequest) : {};
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate required fields
  if (!body.model || typeof body.model !== 'string') {
    return NextResponse.json({ error: '`model` is required' }, { status: 400 });
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: '`messages` is required' }, { status: 400 });
  }

  const modelKey = body.model;
  const requestId = crypto.randomUUID();

  try {
    // Verify model exists and is accessible
    const model = await getModelByKey(tenantDbName, modelKey, projectId);
    if (!model) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    if (model.category !== 'llm') {
      return NextResponse.json({ error: 'Model is not an LLM model' }, { status: 400 });
    }

    // Execute chat completion
    const result = await handleChatCompletion({
      tenantDbName,
      modelKey,
      projectId,
      body: {
        ...body,
        request_id: requestId,
      },
      stream: Boolean(body.stream),
    });

    if (result.stream) {
      return new Response(result.stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Request-Id': result.requestId,
        },
      });
    }

    return NextResponse.json(
      { ...result.response, request_id: result.requestId },
      { status: 200 }
    );
  } catch (error: unknown) {
    console.error('[playground/chat] Error:', error);

    // Log error for analytics
    try {
      const model = await getModelByKey(tenantDbName, modelKey, projectId);
      if (model) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logModelUsage(tenantDbName, model, {
          requestId,
          route: 'playground.chat',
          status: 'error',
          providerRequest: sanitize({ model: body.model, messages: body.messages }),
          providerResponse: sanitize({ error: errorMessage }),
          errorMessage,
          latencyMs: Date.now() - startedAt,
          usage: {},
        });
      }
    } catch (logError) {
      console.error('[playground/chat] Failed to log error:', logError);
    }

    const errorMessage = error instanceof Error ? error.message : 'Chat completion failed';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
