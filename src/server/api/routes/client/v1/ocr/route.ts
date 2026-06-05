import { NextResponse, type NextRequest } from '@/server/api/http';
import crypto from 'crypto';
import type { LicenseType } from '@/lib/license/license-manager';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { handleOcrRequest } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import {
  checkBudget,
  checkPerRequestLimits,
  checkRateLimit,
} from '@/lib/quota/quotaGuard';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';
import type { OcrExtractInput, OcrFeature } from '@/lib/providers';

const logger = createLogger('client-ocr');

const VALID_FEATURES: OcrFeature[] = [
  'text',
  'tables',
  'kv_pairs',
  'layout',
  'reading_order',
  'handwriting',
];

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
  input: OcrExtractInput;
}

function parsePages(value: unknown): number[] | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  return undefined;
}

function parseFeatures(value: unknown): OcrFeature[] | undefined {
  if (typeof value === 'string' && value.trim()) {
    const parts = value
      .split(',')
      .map((v) => v.trim())
      .filter((v): v is OcrFeature => (VALID_FEATURES as string[]).includes(v));
    return parts.length ? parts : undefined;
  }
  if (Array.isArray(value)) {
    const arr = value
      .map((v) => String(v))
      .filter((v): v is OcrFeature => (VALID_FEATURES as string[]).includes(v));
    return arr.length ? arr : undefined;
  }
  return undefined;
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
    const documentUrl = form.get('document_url');

    let document: OcrExtractInput['document'];
    if (file && typeof file !== 'string') {
      const blob = file as Blob & { name?: string };
      document = {
        kind: 'bytes',
        data: Buffer.from(await blob.arrayBuffer()),
        fileName: blob.name,
        contentType: blob.type || undefined,
      };
    } else if (typeof documentUrl === 'string' && documentUrl) {
      document = { kind: 'url', url: documentUrl };
    } else {
      throw new Error('Either `file` or `document_url` is required.');
    }

    return {
      modelKey,
      input: {
        document,
        pages: parsePages(form.get('pages')),
        language: form.get('language') ? String(form.get('language')) : undefined,
        features: parseFeatures(form.get('features')),
        prompt: form.get('prompt') ? String(form.get('prompt')) : undefined,
      },
    };
  }

  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, unknown>;
    const modelKey = typeof body.model === 'string' ? body.model : '';
    if (!modelKey) throw new Error('`model` field is required.');

    const documentField = body.document as Record<string, unknown> | undefined;
    if (!documentField || typeof documentField !== 'object') {
      throw new Error('`document` object is required.');
    }

    let document: OcrExtractInput['document'];
    if (typeof documentField.url === 'string') {
      document = {
        kind: 'url',
        url: documentField.url,
        contentType:
          typeof documentField.contentType === 'string'
            ? documentField.contentType
            : undefined,
      };
    } else if (typeof documentField.data === 'string') {
      document = {
        kind: 'bytes',
        data: Buffer.from(documentField.data, 'base64'),
        fileName:
          typeof documentField.fileName === 'string'
            ? documentField.fileName
            : undefined,
        contentType:
          typeof documentField.contentType === 'string'
            ? documentField.contentType
            : undefined,
      };
    } else {
      throw new Error('`document` must include either `url` or `data` (base64).');
    }

    return {
      modelKey,
      input: {
        document,
        pages: parsePages(body.pages),
        language: typeof body.language === 'string' ? body.language : undefined,
        features: parseFeatures(body.features),
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
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
    logger.error('OCR auth error', { error });
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
      domain: 'ocr' as const,
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
    const result = await handleOcrRequest({
      tenantDbName: auth.tenantDbName,
      modelKey,
      projectId: auth.projectId,
      input,
    });

    return NextResponse.json(
      { ...result.response, request_id: result.requestId },
      { status: 200 },
    );
  } catch (error: unknown) {
    logger.error('OCR error', { error });
    try {
      const model = await getModelByKey(auth.tenantDbName, modelKey, auth.projectId);
      if (model) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logModelUsage(auth.tenantDbName, model, {
          requestId: crypto.randomUUID(),
          route: 'ocr',
          status: 'error',
          providerRequest: {
            model: modelKey,
            documentKind: input.document.kind,
          },
          providerResponse: { error: errorMessage },
          errorMessage,
          latencyMs: Date.now() - startedAt,
          usage: {},
        });
      }
    } catch (logError) {
      logger.error('Failed to log OCR error', { error: logError });
    }
    const errorMessage = error instanceof Error ? error.message : 'Inference error';
    return NextResponse.json(
      { error: { message: errorMessage, type: 'server_error' } },
      { status: 500 },
    );
  }
};

export const POST = withRequestContext(_POST);
