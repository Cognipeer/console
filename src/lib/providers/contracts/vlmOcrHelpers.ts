import { HumanMessage } from '@langchain/core/messages';
import type {
  OcrRuntime,
  OcrExtractInput,
  OcrResult,
  OcrPageResult,
} from '../domains/ocr';
import type { ModelProviderRuntime, ModelRuntimeConfig } from '../domains/model';

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

interface ChatRunnable {
  invoke(input: unknown, options?: Record<string, unknown>): Promise<unknown>;
}

function isChatRunnable(value: unknown): value is ChatRunnable {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { invoke?: unknown }).invoke === 'function',
  );
}

function extractText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function stripJsonFence(text: string): string {
  let trimmed = text.trim();
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

export function createVlmOcrRuntime(
  providerRuntime: ModelProviderRuntime,
  config: ModelRuntimeConfig,
  defaultPrompt?: string,
): OcrRuntime {
  if (!providerRuntime.createChatModel) {
    throw new Error(
      'VLM-mode OCR requires a chat-capable model provider with createChatModel.',
    );
  }

  return {
    async extract(input: OcrExtractInput): Promise<OcrResult> {
      const chatModel = await providerRuntime.createChatModel!({
        ...config,
        category: 'llm',
        options: { ...(config.options ?? {}), streaming: false },
      });

      if (!isChatRunnable(chatModel)) {
        throw new Error('Model provider returned a non-invocable chat runtime for VLM-OCR.');
      }

      const prompt =
        input.prompt?.trim() ||
        defaultPrompt?.trim() ||
        DEFAULT_OCR_PROMPT;
      const dataUrl = toDataUrl(input);

      const userMessage = new HumanMessage({
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: dataUrl },
          },
        ],
      });

      const response = await chatModel.invoke([userMessage]);
      const raw = extractText(response);
      const parsed = tryParseJson(raw);

      const usageMeta =
        (response as { usage_metadata?: Record<string, number> }).usage_metadata ?? {};

      return {
        text: parsed.text,
        pages: parsed.pages,
        language: parsed.language || input.language,
        usage: {
          inputTokens: usageMeta.input_tokens,
          outputTokens: usageMeta.output_tokens,
          totalTokens: usageMeta.total_tokens,
          inputBytes:
            input.document.kind === 'bytes' ? input.document.data.byteLength : undefined,
        },
        invokedVia: 'vlm',
        raw: response,
      };
    },
  };
}
