import type {
  OcrRuntime,
  OcrExtractInput,
  OcrResult,
  OcrPageResult,
  OcrUsage,
} from '../domains/ocr';
import type {
  ModelProviderRuntime,
  ModelRuntimeConfig,
  NativeChatClient,
  NativeChatRequest,
} from '../domains/model';
import type { ChatCompletionResponse } from '@cognipeer/agent-sdk';
import type { IModel } from '@/lib/database';
import { imageUrlToPart } from './nativeParts';
import { looksLikePdf, renderPdfToPngDataUrls } from './pdfRender';
import { createLogger } from '@/lib/core/logger';
import { withResilience } from '@/lib/core/resilience';
import { safeFetch } from '@/lib/security/outboundFetch';
import { stripInlineReasoning } from '@/lib/shared/inlineReasoning';
import { toGatewayUsage } from '@/lib/services/models/gatewayUsage';
import { NON_STREAM_DEFAULT_CAP, modelMaxOutputTokens } from '@/lib/services/models/outputLimits';

const logger = createLogger('vlm-ocr');

const DEFAULT_OCR_PROMPT = `You are an OCR engine. Extract every visible textual element from the provided document image(s) and return the result as STRICT JSON matching this TypeScript type:

type OcrJson = {
  text: string;                  // full document text in natural reading order
  language?: string;             // ISO 639-1 if detectable
  pages?: Array<{
    pageNumber: number;
    text: string;
  }>;
};

Rules:
- Preserve original line breaks and paragraph spacing.
- Do not translate or summarize.
- Do not add commentary outside the JSON.
- If the document is empty, return {"text": ""}.

Respond with JSON only.`;

function stripJsonFence(text: string): string {
  let trimmed = stripInlineReasoning(text).trim();
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '');
    const fenceEnd = trimmed.lastIndexOf('```');
    if (fenceEnd >= 0) trimmed = trimmed.slice(0, fenceEnd);
  }
  return trimmed.trim();
}

function tryParseJson(text: string): { text: string; pages?: OcrPageResult[]; language?: string } {
  const stripped = stripJsonFence(text);
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    if (typeof parsed.text === 'string') {
      const pages = Array.isArray(parsed.pages)
        ? (parsed.pages as Record<string, unknown>[]).map((p, idx) => ({
            pageNumber: typeof p.pageNumber === 'number' ? p.pageNumber : idx + 1,
            text: typeof p.text === 'string' ? p.text : '',
          }))
        : undefined;
      return {
        text: parsed.text,
        pages,
        language: typeof parsed.language === 'string' ? parsed.language : undefined,
      };
    }
  } catch {
    // not valid JSON — fall through and treat the whole response as plain text
  }
  return { text };
}

function toDataUrl(input: OcrExtractInput): string {
  if (input.document.kind === 'url') return input.document.url;
  const contentType = input.document.contentType || 'application/octet-stream';
  const base64 = input.document.data.toString('base64');
  return `data:${contentType};base64,${base64}`;
}

/** Canonical gateway usage of one VLM call (inputTokens already includes cache read/write). */
interface UsageMeta {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cachedWriteTokens: number;
  reasoningTokens: number;
}

function emptyUsage(): UsageMeta {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cachedWriteTokens: 0, reasoningTokens: 0 };
}

/** Optional cache/reasoning keys appear on the result only when positive. */
function usageResult(u: UsageMeta): Pick<
  OcrUsage,
  'inputTokens' | 'outputTokens' | 'totalTokens' | 'cachedInputTokens' | 'cachedWriteTokens' | 'reasoningTokens'
> {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    ...(u.cachedInputTokens > 0 ? { cachedInputTokens: u.cachedInputTokens } : {}),
    ...(u.cachedWriteTokens > 0 ? { cachedWriteTokens: u.cachedWriteTokens } : {}),
    ...(u.reasoningTokens > 0 ? { reasoningTokens: u.reasoningTokens } : {}),
  };
}

/**
 * Canonical usage of one response, converted once with the client's driver: anthropic/bedrock input excludes the
 * cache read/write, vertex output excludes thinking tokens.
 */
function responseUsage(driver: string | undefined, response: ChatCompletionResponse): UsageMeta {
  const canonical = toGatewayUsage(driver, response.usage);
  return {
    inputTokens: canonical.inputTokens ?? 0,
    outputTokens: canonical.outputTokens ?? 0,
    totalTokens: canonical.totalTokens ?? 0,
    cachedInputTokens: canonical.cachedInputTokens ?? 0,
    cachedWriteTokens: canonical.cachedWriteTokens ?? 0,
    reasoningTokens: canonical.reasoningTokens ?? 0,
  };
}

function addUsage(total: UsageMeta, add: UsageMeta): void {
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
  total.totalTokens += add.totalTokens;
  total.cachedInputTokens += add.cachedInputTokens;
  total.cachedWriteTokens += add.cachedWriteTokens;
  total.reasoningTokens += add.reasoningTokens;
}

/** What every page call of one document shares. */
interface PageCall {
  /** `max_tokens` of the first attempt; undefined leaves the limit to the model's own setting. */
  maxTokens?: number;
  /** The most the model can write in one answer, when known: the one larger retry never asks for more. */
  modelMax?: number;
  /** Name of the per-page resilience wrapper (its log lines and timeout message); its circuit breaker is off. */
  resilienceKey: string;
}

/**
 * One chat call for a page, retried on a transient failure and timed per attempt (`withResilience`, the gateway's
 * own policy). The provider SDK's retries are off for this client (`maxRetries: 0`), so the attempts live HERE,
 * page by page: a failure on page 40 retries page 40, not the document - and when the attempts are spent the error
 * says so (`retryable: false`), so a caller wrapping the whole extraction in its own retry does not run pages
 * 1-39 again.
 *
 * The circuit breaker is NOT used at this level: its state is process-wide, keyed by a name, and this layer knows no
 * tenant to scope a name by (the gateway scopes its keys by tenant for that reason). One tenant's rejected key or
 * exhausted quota would otherwise open a circuit that fails every other tenant's reads of the same model. The caller's
 * own `withResilience` around the whole extraction (per provider) keeps the breaker.
 */
async function completePage(
  client: NativeChatClient,
  request: NativeChatRequest,
  resilienceKey: string,
): Promise<ChatCompletionResponse> {
  try {
    return await withResilience(
      (signal) => client.complete({ ...request, signal }),
      { key: resilienceKey, circuitBreaker: { enabled: false } },
    );
  } catch (error) {
    if (error instanceof Error && (error as { retryable?: unknown }).retryable === undefined) {
      (error as { retryable?: boolean }).retryable = false;
    }
    throw error;
  }
}

/**
 * Run the VLM on a single image data URL and parse its JSON response.
 *
 * A page that is cut off at the output limit (finish reason `length`) is asked for again ONCE with twice the limit
 * (never above the model maximum): a dense page is the usual cause, and the answer is a JSON document, so a cut-off
 * reply is unusable rather than shorter. When the retry cannot be made, or is cut off too, the page comes back
 * `truncated` instead of passing for a clean read; the usage of every attempt is summed (the provider bills them all).
 */
async function ocrSingleImage(
  client: NativeChatClient,
  prompt: string,
  imageDataUrl: string,
  call: PageCall,
): Promise<{
  parsed: { text: string; pages?: OcrPageResult[]; language?: string };
  usage: UsageMeta;
  raw: unknown;
  truncated: boolean;
}> {
  const request: NativeChatRequest = {
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }, imageUrlToPart(imageDataUrl)],
    }],
    ...(call.maxTokens !== undefined ? { maxTokens: call.maxTokens } : {}),
  };
  let response = await completePage(client, request, call.resilienceKey);
  const usage = responseUsage(client.driver, response);

  if (response.finishReason === 'length') {
    // The limit this attempt ran under: the one sent, else what the model wrote before it was cut (the limit that
    // applied, thinking included).
    const hit = call.maxTokens ?? usage.outputTokens;
    const raised = Math.min(hit * 2, call.modelMax ?? Number.POSITIVE_INFINITY);
    if (raised > hit) {
      try {
        const retry = await completePage(client, { ...request, maxTokens: raised }, call.resilienceKey);
        addUsage(usage, responseUsage(client.driver, retry));
        response = retry;
      } catch (error) {
        // Keep the first reply, flagged: a model that refuses the larger limit has said where its ceiling is.
        logger.warn('VLM OCR retry with a larger output limit failed, keeping the cut-off page', {
          limit: hit,
          retryLimit: raised,
          error,
        });
      }
    }
  }

  const truncated = response.finishReason === 'length';
  if (truncated) logger.warn('VLM OCR page was cut off at the output limit', { modelMax: call.modelMax });
  const parsed = tryParseJson(response.content ?? '');
  return { parsed, usage, raw: response.raw ?? response, truncated };
}

/** Detect whether the OCR document is a PDF (content type, URL, or magic bytes). */
function isPdfDocument(input: OcrExtractInput): boolean {
  return looksLikePdf({
    contentType: input.document.contentType,
    url: input.document.kind === 'url' ? input.document.url : undefined,
    bytes: input.document.kind === 'bytes' ? input.document.data : undefined,
  });
}

/** Load the raw bytes of a PDF document, fetching the URL when needed. */
async function loadPdfBytes(input: OcrExtractInput): Promise<Buffer> {
  if (input.document.kind === 'bytes') return input.document.data;
  const res = await safeFetch(input.document.url);
  if (!res.ok) throw new Error(`Failed to fetch PDF document: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export function createVlmOcrRuntime(
  providerRuntime: ModelProviderRuntime,
  config: ModelRuntimeConfig,
  defaultPrompt?: string,
): OcrRuntime {
  if (!providerRuntime.createNativeChatClient) {
    throw new Error(
      'VLM-mode OCR requires a chat-capable model provider with createNativeChatClient.',
    );
  }

  // What each page call is sent with. A page of text can be long, so a model whose maximum is known (declared, or a
  // Claude the built-in table knows) is asked for that rather than the model record's small "Default max tokens"
  // - never above NON_STREAM_DEFAULT_CAP, the most a non-streaming call is given by default (the one larger retry
  // of a cut-off page goes beyond it, up to the model maximum). A configured limit that is already as large is left
  // alone rather than restated (an explicit value is a hard cap: it would drop the thinking headroom a configured
  // limit gets). An unknown maximum sends nothing: the provider's / the record's own limit applies.
  const modelSettings = (config.modelSettings ?? {}) as Record<string, unknown>;
  const modelMax = modelMaxOutputTokens({ modelId: config.modelId, settings: modelSettings } as IModel);
  const wanted = modelMax !== undefined ? Math.min(modelMax, NON_STREAM_DEFAULT_CAP) : undefined;
  const configured = [modelSettings.maxCompletionTokens, modelSettings.maxTokens].find(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
  );
  const firstMaxTokens = wanted !== undefined && !(configured !== undefined && configured >= wanted) ? wanted : undefined;

  return {
    async extract(input: OcrExtractInput): Promise<OcrResult> {
      const chatModel = await providerRuntime.createNativeChatClient!({
        ...config,
        category: 'llm',
        // The provider SDK does not retry on its own: the attempts are made per page (`completePage`), so a
        // document is never re-read from its first page because a later one failed.
        options: { ...(config.options ?? {}), maxRetries: 0 },
      });

      if (!chatModel || typeof chatModel.complete !== 'function') {
        throw new Error('Model provider returned a non-invocable chat runtime for VLM-OCR.');
      }

      const pageCall: PageCall = {
        ...(firstMaxTokens !== undefined ? { maxTokens: firstMaxTokens } : {}),
        ...(modelMax !== undefined ? { modelMax } : {}),
        resilienceKey: `vlm-ocr:${chatModel.driver ?? 'native'}:${config.modelId}`,
      };

      const prompt =
        input.prompt?.trim() ||
        defaultPrompt?.trim() ||
        DEFAULT_OCR_PROMPT;

      // PDF documents are rasterized to one PNG per page first, since vision
      // models only accept image inputs. Each page is OCR'd then merged.
      if (isPdfDocument(input)) {
        const pdfBytes = await loadPdfBytes(input);
        const rendered = await renderPdfToPngDataUrls(pdfBytes, { maxPages: input.pdfMaxPages });
        if (rendered.dataUrls.length === 0) {
          throw new Error('Failed to render any pages from the PDF document.');
        }

        const pages: OcrPageResult[] = [];
        let language: string | undefined;
        const totals = emptyUsage();
        const rawPages: unknown[] = [];

        for (let i = 0; i < rendered.dataUrls.length; i++) {
          const { parsed, usage, raw, truncated } = await ocrSingleImage(chatModel, prompt, rendered.dataUrls[i], pageCall);
          pages.push({ pageNumber: i + 1, text: parsed.text, ...(truncated ? { truncated: true } : {}) });
          if (!language && parsed.language) language = parsed.language;
          addUsage(totals, usage);
          rawPages.push(raw);
        }

        return {
          text: pages.map((p) => p.text).join('\n\n'),
          pages,
          language: language || input.language,
          usage: {
            ...usageResult(totals),
            pages: rendered.totalPages,
            inputBytes: pdfBytes.byteLength,
          },
          invokedVia: 'vlm',
          // `truncated` here is the page limit (`pdfMaxPages` cut the document); a page cut off at the output
          // limit says so on the page itself.
          raw: { pdf: true, pagesRendered: rendered.dataUrls.length, truncated: rendered.truncated, responses: rawPages },
        };
      }

      const dataUrl = toDataUrl(input);
      const { parsed, usage, raw, truncated } = await ocrSingleImage(chatModel, prompt, dataUrl, pageCall);
      // A cut-off image has no clean read: its pages say so (a reply that named no pages gets the one it is).
      const pages: OcrPageResult[] | undefined = !truncated
        ? parsed.pages
        : parsed.pages && parsed.pages.length > 0
          ? parsed.pages.map((page) => ({ ...page, truncated: true }))
          : [{ pageNumber: 1, text: parsed.text, truncated: true }];

      return {
        text: parsed.text,
        pages,
        language: parsed.language || input.language,
        usage: {
          ...usageResult(usage),
          inputBytes:
            input.document.kind === 'bytes' ? input.document.data.byteLength : undefined,
        },
        invokedVia: 'vlm',
        raw,
      };
    },
  };
}
