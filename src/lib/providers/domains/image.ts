/**
 * Image-generation domain.
 *
 * Modelled on the audio domains: the gateway speaks the OpenAI
 * `/v1/images/generations` schema on the wire, and a provider contract turns it
 * into whatever its upstream wants. Kept deliberately close to that schema so a
 * caller can point an OpenAI client at Console and have it work unchanged.
 */
import type { ModelRuntimeConfig } from './model';

export type ImageResponseFormat = 'b64_json' | 'url';

export interface ImageGenerateInput {
  prompt: string;
  /** How many images to produce. Providers cap this; the gateway does not. */
  n?: number;
  /** e.g. `1024x1024`, or `auto` where the provider supports it. */
  size?: string;
  quality?: string;
  style?: string;
  background?: string;
  /** `png` | `jpeg` | `webp` — provider dependent. */
  outputFormat?: string;
  responseFormat?: ImageResponseFormat;
  user?: string;
  /** Provider-specific extra fields, forwarded as-is. */
  extra?: Record<string, unknown>;
}

export interface GeneratedImage {
  /** Base64 payload. Providers that only return a URL leave this unset. */
  b64Json?: string;
  url?: string;
  /** Some models rewrite the prompt and report what they actually drew. */
  revisedPrompt?: string;
}

export interface ImageUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Number of images billed — the unit most image models price on. */
  images?: number;
}

export interface ImageResult {
  images: GeneratedImage[];
  usage?: ImageUsage;
  model?: string;
  /** The upstream body, for the trace. */
  raw?: Record<string, unknown>;
}

export interface ImageRuntime {
  generate(input: ImageGenerateInput, config?: ModelRuntimeConfig): Promise<ImageResult>;
}
