import { NextResponse, type NextRequest } from '@/server/api/http';
import crypto from 'crypto';
import type { LicenseType } from '@/lib/license/license-manager';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { handleTranscriptionRequest } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import {
  checkBudget,
  checkPerRequestLimits,
  checkRateLimit,
} from '@/lib/quota/quotaGuard';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';
import type { SttResponseFormat, SttTranslateInput } from '@/lib/providers';

const logger = createLogger('client-stt-translate');

function unauthorized(message = 'Invalid API token') {
  return NextResponse.json(
    { error: { message, type: 'invalid_request_error' } },
    { status: 401 },
  );
}

function badRequest(message: string) {
  return NextResponse.json(
    { error: { message, type: 'invalid_request_error' } },
    { status: 400 },
  );
}

function quotaExceeded(message = 'Quota exceeded') {
  return NextResponse.json(
    { error: { message, type: 'rate_limit_error' } },
    { status: 429 },
  );
}

interface ParsedInput {
  modelKey: string;
  input: SttTranslateInput;
}

async function parseRequest(request: NextRequest): Promise<ParsedInput> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.startsWith('multipart/form-data')) {
    if (!request.formData) {
      throw new Error('multipart/form-data is not supported by this transport.');
    }
    const form = await request.formData();
    const modelKey = String(form.get('model') ?? '').trim();
    if (!modelKey) throw new Error('`model` field is required.');
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      throw new Error('`file` field is required.');
    }
    const blob = file as Blob & { name?: string };
    const data = Buffer.from(await blob.arrayBuffer());
    const responseFormatRaw = form.get('response_format');
    return {
      modelKey,
      input: {
        audio: { data, fileName: blob.name, contentType: blob.type || undefined },
        prompt: form.get('prompt') ? String(form.get('prompt')) : undefined,
        responseFormat:
          typeof responseFormatRaw === 'string' && responseFormatRaw
            ? (responseFormatRaw as SttResponseFormat)
            : undefined,
        temperature: form.get('temperature')
          ? Number(form.get('temperature'))
          : undefined,
      },
    };
  }

  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, unknown>;
    const modelKey = typeof body.model === 'string' ? body.model : '';
    if (!modelKey) throw new Error('`model` field is required.');
    const audio = body.audio as Record<string, unknown> | undefined;
    if (!audio || typeof audio.data !== 'string') {
      throw new Error('`audio.data` must be a base64-encoded string.');
    }
    return {
      modelKey,
      input: {
        audio: {
          data: Buffer.from(audio.data, 'base64'),
          fileName: typeof audio.fileName === 'string' ? audio.fileName : undefined,
          contentType: typeof audio.contentType === 'string' ? audio.contentType : undefined,
        },
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        responseFormat:
          typeof body.response_format === 'string'
            ? (body.response_format as SttResponseFormat)
            : undefined,
        temperature:
          typeof body.temperature === 'number' ? body.temperature : undefined,
      },
    };
  }

  throw new Error('Content-Type must be multipart/form-data or application/json.');
}

const _POST = async (request: NextRequest) => {
  const startedAt = Date.now();

  let auth: Awaited<ReturnType<typeof requireApiToken>>;
  try {
    auth = await requireApiToken(request);
  } catch (error) {
    if (error instanceof ApiTokenAuthError) return unauthorized(error.message);
    logger.error('Translation auth error', { error });
    return unauthorized();
  }

  let parsed: ParsedInput;
  try {
    parsed = await parseRequest(request);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid request payload',
    );
  }
  const { modelKey, input } = parsed;

  try {
    const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
    const quotaContext = {
      tenantDbName: auth.tenantDbName,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      licenseType: auth.tenant.licenseType as LicenseType,
      userId: auth.tokenRecord.userId,
      tokenId,
      domain: 'stt' as const,
      resourceKey: modelKey,
    };

    const perRequest = await checkPerRequestLimits(quotaContext, {});
    if (!perRequest.allowed) return quotaExceeded(perRequest.reason || 'Quota exceeded');

    const rateLimit = await checkRateLimit(quotaContext, { requests: 1 });
    if (!rateLimit.allowed) return quotaExceeded(rateLimit.reason || 'Rate limit exceeded');

    const budget = await checkBudget(quotaContext);
    if (!budget.allowed) return quotaExceeded(budget.reason || 'Budget exceeded');
  } catch (error) {
    logger.error('Quota check error', { error });
    return NextResponse.json(
      { error: { message: 'Quota check failed', type: 'server_error' } },
      { status: 500 },
    );
  }

  try {
    const result = await handleTranscriptionRequest({
      tenantDbName: auth.tenantDbName,
      modelKey,
      projectId: auth.projectId,
      input,
      translate: true,
    });

    return NextResponse.json(
      { ...result.response, request_id: result.requestId },
      { status: 200 },
    );
  } catch (error: unknown) {
    logger.error('Translation error', { error });
    try {
      const model = await getModelByKey(auth.tenantDbName, modelKey, auth.projectId);
      if (model) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logModelUsage(auth.tenantDbName, model, {
          requestId: crypto.randomUUID(),
          route: 'audio.translations',
          status: 'error',
          providerRequest: { model: modelKey },
          providerResponse: { error: errorMessage },
          errorMessage,
          latencyMs: Date.now() - startedAt,
          usage: {},
        });
      }
    } catch (logError) {
      logger.error('Failed to log translation error', { error: logError });
    }
    const errorMessage = error instanceof Error ? error.message : 'Inference error';
    return NextResponse.json(
      { error: { message: errorMessage, type: 'server_error' } },
      { status: 500 },
    );
  }
};

export const POST = withRequestContext(_POST);
