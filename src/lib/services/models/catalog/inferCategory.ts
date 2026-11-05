/**
 * Which Model Hub category a listed model id belongs to, judged by the id alone.
 *
 * Most "list models" APIs (OpenAI, vLLM, Groq, Azure deployments) return bare ids with nothing that says what a model
 * does, so the catalog reads the well-known naming families instead. Pure and import-free (type imports only): the
 * dashboard may read it as well. It is a default for a catalog row, not a promise; the person can change the category
 * in the create form.
 */
import type { ModelCategory } from '@/lib/database';

/** What a provider said about a model besides its id, when it said anything. */
export interface CategoryHints {
  /**
   * Output modalities in the provider's words, any case (`text`, `embeddings`, `EMBEDDING`, `image`, `audio` …).
   * An embedding output settles it; an output list without text marks a model a chat gateway cannot serve.
   */
  outputModalities?: readonly string[];
}

/**
 * Ids no driver of this console can serve through its chat, embedding, audio or image routes: realtime and
 * audio-only chat sessions, video generation, the legacy completions-only models and tool-bound agents.
 */
const UNSERVABLE: readonly RegExp[] = [
  /realtime/,
  /(^|[-_/.])sora([-_/.:]|$)/,
  /(^|[-_/.])veo([-_/.:\d]|$)/,
  // Anchored at the start (or after a path): `text-embedding-ada-002` is an embedding model, not a completions one.
  /(^|\/)(davinci|babbage)-00\d/,
  /(^|\/)text-(davinci|curie|babbage|ada)-/,
  /gpt-3\.5-turbo-instruct/,
  /computer-use/,
  // OpenAI deep research: Responses-only, and refuses a request without a web_search_preview / mcp / file_search tool,
  // which no route here sends. Narrow on purpose: Perplexity's `sonar-deep-research` is a Chat Completions model.
  /(^|[-_/.])o\d+(-mini)?-deep-research/,
  // Gemini Live API models: a bidirectional session, not a request.
  /(^|[-_.])live([-_.]|$)/,
  /native-audio/,
  // Chat Completions refuses a text-only request for these: they need audio in or out.
  /audio-preview/,
  /(^|[-_/.])gpt-audio/,
];

const RERANK = /rerank/;
const MODERATION = /moderation/;

const EMBEDDING: readonly RegExp[] = [
  /embed/,
  /(^|[-_/.])bge-/,
  /(^|[-_/.])e5-/,
  /(^|[-_/.])gte-/,
  /(^|[-_/.])voyage-/,
  /minilm/,
  /(^|[-_/.])sentence-transformers\//,
];

const STT: readonly RegExp[] = [/whisper/, /transcribe/, /(^|[-_/.])stt([-_/.:]|$)/, /speech-to-text/];

const TTS: readonly RegExp[] = [
  /(^|[-_/.])tts([-_/.:\d]|$)/,
  /text-to-speech/,
  // Speech models whose ids carry no `tts`: Groq's Canopy Labs Orpheus, Kokoro (speaches, Kokoro-FastAPI), Piper, XTTS,
  // Chatterbox, Parler.
  /(^|[-_/.])(orpheus|kokoro|piper|xtts|chatterbox|parler)([-_/.:\d]|$)/,
];

const IMAGE: readonly RegExp[] = [
  /dall-e/,
  /gpt-image/,
  /(^|[-_/.])flux/,
  /stable-diffusion/,
  /sdxl/,
  /(^|[-_/.])imagen/,
];

const lower = (values: readonly string[] | undefined) =>
  (values ?? []).filter((value): value is string => typeof value === 'string').map((value) => value.trim().toLowerCase());

/**
 * The category a listed model id is served under, or `null` when a chat gateway cannot serve it at all (realtime,
 * video, legacy completions …). Everything not recognised is a chat model (`llm`).
 */
export function inferCatalogCategory(id: string, hints?: CategoryHints): ModelCategory | null {
  const name = (typeof id === 'string' ? id : '').trim().toLowerCase();
  if (!name) return null;

  const outputs = lower(hints?.outputModalities);
  if (outputs.includes('embeddings') || outputs.includes('embedding')) return 'embedding';

  if (UNSERVABLE.some((pattern) => pattern.test(name))) return null;
  // Rerankers first: `bge-reranker` and `jina-reranker` would otherwise read as embedding families.
  if (RERANK.test(name)) return 'rerank';
  if (MODERATION.test(name)) return 'moderation';
  if (EMBEDDING.some((pattern) => pattern.test(name))) return 'embedding';
  if (STT.some((pattern) => pattern.test(name))) return 'stt';
  if (TTS.some((pattern) => pattern.test(name))) return 'tts';
  if (IMAGE.some((pattern) => pattern.test(name))) return 'image';

  // A model that answers in images, audio or video only is not a chat model, whatever its name says.
  if (outputs.length > 0 && !outputs.includes('text')) return null;
  return 'llm';
}

/** `category` when the driver serves it, else `null` (the entry is left out of the catalog). */
export function constrainCategory(
  category: ModelCategory | null | undefined,
  allowed: readonly ModelCategory[],
): ModelCategory | null {
  if (!category) return null;
  return allowed.includes(category) ? category : null;
}
