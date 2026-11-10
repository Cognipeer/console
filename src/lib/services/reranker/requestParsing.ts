/**
 * Pure request-body parsing shared by the dashboard and client reranker
 * routes. No request, reply or auth access: callers pass the already decoded
 * JSON body and map the typed result onto their own response envelope.
 */
import type { IRerankerConfig, RerankerStrategy } from '@/lib/database';
import type { RerankerDocumentInput } from './types';

export const ALLOWED_STRATEGIES: RerankerStrategy[] = [
  'dedicated-model',
  'llm-judge',
  'llm-listwise',
  'heuristic',
];

export function isStrategy(value: unknown): value is RerankerStrategy {
  return typeof value === 'string' && ALLOWED_STRATEGIES.includes(value as RerankerStrategy);
}

/** Raised for malformed `documents` input; routes map it to HTTP 400. */
export class RerankerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RerankerInputError';
  }
}

export function normalizeDocuments(raw: unknown): RerankerDocumentInput[] {
  if (!Array.isArray(raw)) {
    throw new RerankerInputError('`documents` must be an array.');
  }
  return raw.map((item, idx): RerankerDocumentInput => {
    if (typeof item === 'string') return { content: item };
    if (item && typeof item === 'object') {
      const d = item as Record<string, unknown>;
      const content = typeof d.content === 'string' ? d.content
        : typeof d.text === 'string' ? d.text
          : undefined;
      if (!content) {
        throw new RerankerInputError(`documents[${idx}]: missing "content" (or "text") field.`);
      }
      return {
        id: typeof d.id === 'string' ? d.id : undefined,
        content,
        score: typeof d.score === 'number' ? d.score : undefined,
        metadata:
          d.metadata && typeof d.metadata === 'object'
            ? (d.metadata as Record<string, unknown>)
            : undefined,
      };
    }
    throw new RerankerInputError(`documents[${idx}]: must be a string or an object with "content".`);
  });
}

export interface RerankerCreateInput {
  name: string;
  key?: string;
  description?: string;
  strategy: RerankerStrategy;
  config: IRerankerConfig;
  status: 'active' | 'disabled';
  metadata?: Record<string, unknown>;
}

export type RerankerCreateParseResult =
  | { ok: true; value: RerankerCreateInput }
  | { ok: false; status: 400; error: string };

export function readCreateBody(body: Record<string, unknown>): RerankerCreateParseResult {
  if (typeof body.name !== 'string' || body.name === '') {
    return { ok: false, status: 400, error: '`name` is required.' };
  }
  if (!isStrategy(body.strategy)) {
    return {
      ok: false,
      status: 400,
      error: `\`strategy\` must be one of: ${ALLOWED_STRATEGIES.join(', ')}.`,
    };
  }
  if (!body.config || typeof body.config !== 'object') {
    return { ok: false, status: 400, error: '`config` object is required.' };
  }
  return {
    ok: true,
    value: {
      name: body.name,
      key: typeof body.key === 'string' ? body.key : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      strategy: body.strategy,
      config: body.config as IRerankerConfig,
      status: body.status === 'disabled' ? 'disabled' : 'active',
      metadata:
        body.metadata && typeof body.metadata === 'object'
          ? (body.metadata as Record<string, unknown>)
          : undefined,
    },
  };
}

export interface RerankerPatchInput {
  name?: string;
  description?: string;
  strategy?: RerankerStrategy;
  config?: IRerankerConfig;
  status?: 'active' | 'disabled';
  metadata?: Record<string, unknown>;
}

export function readPatchBody(body: Record<string, unknown>): RerankerPatchInput {
  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    description: typeof body.description === 'string' ? body.description : undefined,
    strategy: isStrategy(body.strategy) ? body.strategy : undefined,
    config:
      body.config && typeof body.config === 'object'
        ? (body.config as IRerankerConfig)
        : undefined,
    status: body.status === 'disabled' || body.status === 'active' ? body.status : undefined,
    metadata:
      body.metadata && typeof body.metadata === 'object'
        ? (body.metadata as Record<string, unknown>)
        : undefined,
  };
}
