/**
 * OpenAI-schema moderation (`POST {base}/moderations`), shared by every contract
 * that speaks it. Azure exposes the same body under a deployment-scoped URL, so
 * both the URL builder and the auth header are injectable, exactly as they are
 * for audio and images.
 */
import type {
  ModerationClassification,
  ModerationResultSet,
  ModerationRuntime,
} from '../domains/moderation';
import { upstreamError } from './upstreamError';

export interface OpenAiModerationClientOptions {
  apiKey: string;
  baseUrl: string;
  organization?: string;
  /** Moderation model id (e.g. omni-moderation-latest). */
  modelId: string;
  extraHeaders?: Record<string, string>;
  buildUrl?: (path: '/moderations') => string;
}

function buildHeaders(opts: OpenAiModerationClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (opts.organization) headers['OpenAI-Organization'] = opts.organization;
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
  return headers;
}

function resolveUrl(opts: OpenAiModerationClientOptions): string {
  if (opts.buildUrl) return opts.buildUrl('/moderations');
  return `${opts.baseUrl.replace(/\/$/, '')}/moderations`;
}

/**
 * Folds one upstream result into the shared shape. OpenAI reports `categories`
 * and `category_scores` as parallel maps; a category present in only one of
 * them still produces a verdict, so a provider that omits scores degrades to
 * flags rather than to nothing.
 */
function toClassification(entry: Record<string, unknown>): ModerationClassification {
  const flags = (entry.categories ?? {}) as Record<string, unknown>;
  const scores = (entry.category_scores ?? {}) as Record<string, unknown>;
  const categories: ModerationClassification['categories'] = {};

  for (const id of new Set([...Object.keys(flags), ...Object.keys(scores)])) {
    const score = scores[id];
    categories[id] = {
      flagged: flags[id] === true,
      ...(typeof score === 'number' ? { score } : {}),
    };
  }

  return {
    flagged: entry.flagged === true,
    categories,
    raw: entry,
  };
}

export function createOpenAiModerationRuntime(
  opts: OpenAiModerationClientOptions,
): ModerationRuntime {
  const classify = async (texts: string[]): Promise<ModerationResultSet> => {
    const response = await fetch(resolveUrl(opts), {
      method: 'POST',
      headers: buildHeaders(opts),
      body: JSON.stringify({ model: opts.modelId, input: texts }),
    });

    if (!response.ok) {
      throw await upstreamError('OpenAI moderation failed', response);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const results = Array.isArray(payload.results) ? payload.results : [];
    const usage = (payload.usage ?? {}) as Record<string, unknown>;

    return {
      results: results.map((entry) => toClassification((entry ?? {}) as Record<string, unknown>)),
      model: typeof payload.model === 'string' ? payload.model : opts.modelId,
      usage: {
        ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
        ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
      },
    };
  };

  return { classify };
}
