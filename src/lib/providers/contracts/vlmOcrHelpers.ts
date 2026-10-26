import type {
  OcrRuntime,
  OcrExtractInput,
  OcrResult,
  OcrPageResult,
  OcrUsage,
} from '../domains/ocr';
import type { ModelProviderRuntime, ModelRuntimeConfig, NativeChatClient } from '../domains/model';
import type { ChatCompletionResponse } from '@cognipeer/agent-sdk';
import { imageUrlToPart } from './nativeParts';
import { looksLikePdf, renderPdfToPngDataUrls } from './pdfRender';
import { safeFetch } from '@/lib/security/outboundFetch';
import { stripInlineReasoning } from '@/lib/shared/inlineReasoning';
import { toGatewayUsage } from '@/lib/services/models/gatewayUsage';

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

/** Run the VLM on a single image data URL and parse its JSON response. */
async function ocrSingleImage(
  client: NativeChatClient,
  prompt: string,
  imageDataUrl: string,
): Promise<{
  parsed: { text: string; pages?: OcrPageResult[]; language?: string };
  usage: UsageMeta;
  raw: unknown;
}> {
  const response: ChatCompletionResponse = await client.complete({
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }, imageUrlToPart(imageDataUrl)],
    }],
  });
  const parsed = tryParseJson(response.content ?? '');
  // Convert once with the client's driver: anthropic/bedrock input excludes the
  // cache read/write, vertex output excludes thinking tokens.
  const canonical = toGatewayUsage(client.driver, response.usage);
  const usage: UsageMeta = {
    inputTokens: canonical.inputTokens ?? 0,
    outputTokens: canonical.outputTokens ?? 0,
    totalTokens: canonical.totalTokens ?? 0,
    cachedInputTokens: canonical.cachedInputTokens ?? 0,
    cachedWriteTokens: canonical.cachedWriteTokens ?? 0,
    reasoningTokens: canonical.reasoningTokens ?? 0,
  };
  return { parsed, usage, raw: response.raw ?? response };
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

  return {
    async extract(input: OcrExtractInput): Promise<OcrResult> {
      const chatModel = await providerRuntime.createNativeChatClient!({
        ...config,
        category: 'llm',
        options: { ...(config.options ?? {}) },
      });

      if (!chatModel || typeof chatModel.complete !== 'function') {
        throw new Error('Model provider returned a non-invocable chat runtime for VLM-OCR.');
      }

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
          const { parsed, usage, raw } = await ocrSingleImage(chatModel, prompt, rendered.dataUrls[i]);
          pages.push({ pageNumber: i + 1, text: parsed.text });
          if (!language && parsed.language) language = parsed.language;
          totals.inputTokens += usage.inputTokens;
          totals.outputTokens += usage.outputTokens;
          totals.totalTokens += usage.totalTokens;
          totals.cachedInputTokens += usage.cachedInputTokens;
          totals.cachedWriteTokens += usage.cachedWriteTokens;
          totals.reasoningTokens += usage.reasoningTokens;
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
          raw: { pdf: true, pagesRendered: rendered.dataUrls.length, truncated: rendered.truncated, responses: rawPages },
        };
      }

      const dataUrl = toDataUrl(input);
      const { parsed, usage, raw } = await ocrSingleImage(chatModel, prompt, dataUrl);

      return {
        text: parsed.text,
        pages: parsed.pages,
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
