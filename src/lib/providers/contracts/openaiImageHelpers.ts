/**
 * OpenAI-schema image generation, shared by every contract that speaks it
 * (OpenAI, any OpenAI-compatible base URL, Azure).
 *
 * The wire shape is `POST {base}/images/generations`; Azure needs a
 * deployment-scoped URL and its own auth header, so both are injectable exactly
 * as they are for audio (`openaiAudioHelpers`).
 */
import { upstreamError } from './upstreamError';
import type {
  GeneratedImage,
  ImageGenerateInput,
  ImageResult,
  ImageRuntime,
} from '../domains/image';

export interface OpenAiImageClientOptions {
  apiKey: string;
  baseUrl: string;
  organization?: string;
  /** Image model id (e.g. gpt-image-1, dall-e-3, gpt-image-2). */
  modelId: string;
  /** Extra headers — Azure authenticates with `api-key` instead of a bearer. */
  extraHeaders?: Record<string, string>;
  /** Override the URL builder (Azure puts the deployment in the path). */
  buildUrl?: (path: '/images/generations') => string;
}

function buildHeaders(opts: OpenAiImageClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (opts.organization) headers['OpenAI-Organization'] = opts.organization;
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
  return headers;
}

function resolveUrl(opts: OpenAiImageClientOptions): string {
  if (opts.buildUrl) return opts.buildUrl('/images/generations');
  return `${opts.baseUrl.replace(/\/$/, '')}/images/generations`;
}

function toGeneratedImage(entry: Record<string, unknown>): GeneratedImage {
  const image: GeneratedImage = {};
  if (typeof entry.b64_json === 'string') image.b64Json = entry.b64_json;
  if (typeof entry.url === 'string') image.url = entry.url;
  if (typeof entry.revised_prompt === 'string') image.revisedPrompt = entry.revised_prompt;
  return image;
}

export function createOpenAiImageRuntime(opts: OpenAiImageClientOptions): ImageRuntime {
  const generate = async (input: ImageGenerateInput): Promise<ImageResult> => {
    const body: Record<string, unknown> = {
      model: opts.modelId,
      prompt: input.prompt,
    };
    if (typeof input.n === 'number') body.n = input.n;
    if (input.size) body.size = input.size;
    if (input.quality) body.quality = input.quality;
    if (input.style) body.style = input.style;
    if (input.background) body.background = input.background;
    if (input.outputFormat) body.output_format = input.outputFormat;
    // `gpt-image-*` rejects `response_format` outright — it always answers with
    // base64 — so it is only forwarded when the caller actually asked for one.
    if (input.responseFormat) body.response_format = input.responseFormat;
    if (input.user) body.user = input.user;
    if (input.extra) Object.assign(body, input.extra);

    const response = await fetch(resolveUrl(opts), {
      method: 'POST',
      headers: buildHeaders(opts),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw await upstreamError('OpenAI image generation failed', response);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const data = Array.isArray(payload.data) ? payload.data : [];
    const images = data.map((entry) => toGeneratedImage((entry ?? {}) as Record<string, unknown>));
    const usage = (payload.usage ?? {}) as Record<string, unknown>;

    return {
      images,
      model: typeof payload.model === 'string' ? payload.model : opts.modelId,
      usage: {
        images: images.length,
        ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
        ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
        ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
      },
      raw: payload,
    };
  };

  return { generate };
}
