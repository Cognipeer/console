/**
 * Reranker adapter — directly calls provider rerank HTTP endpoints.
 *
 * Rather than extending the ModelProviderRuntime contract (which would require
 * updating every existing provider implementation), reranker calls bypass the
 * runtime layer and hit provider HTTP APIs directly. This is simpler and works
 * for the small set of rerank providers we support today:
 *   - Cohere   → /v2/rerank
 *   - Jina AI  → /v1/rerank
 *   - Voyage AI → /v1/rerank
 *   - openai-compatible → /v1/rerank (BGE / Mixedbread reranker servers)
 */

import { createLogger } from '@/lib/core/logger';
import { withResilience } from '@/lib/core/resilience';
import { loadProviderRuntimeData } from '@/lib/services/providers/providerService';
import type { IModel } from '@/lib/database';

const logger = createLogger('rerank-adapter');

interface RerankCallInput {
  query: string;
  documents: string[];
  topN?: number;
}

interface RerankCallResult {
  /** index into the documents array, with score. */
  results: Array<{ index: number; score: number }>;
}

interface ProviderCallContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  model: IModel;
}

export async function callRerankProvider(
  ctx: ProviderCallContext,
  input: RerankCallInput,
): Promise<RerankCallResult> {
  const { runtime, credentials } = await resolveProviderInfo(ctx);
  const driver = runtime.driver;
  const apiKey = (credentials as Record<string, unknown>).apiKey as string | undefined;
  const baseUrl = (credentials as Record<string, unknown>).baseUrl as string | undefined;

  switch (driver) {
    case 'cohere':
      return callCohere({ apiKey, model: ctx.model.modelId, ...input });
    case 'jina-ai':
      return callJina({ apiKey, model: ctx.model.modelId, ...input });
    case 'voyage-ai':
      return callVoyage({ apiKey, model: ctx.model.modelId, ...input });
    case 'openai-compatible':
      return callOpenAICompatibleRerank({ apiKey, baseUrl, model: ctx.model.modelId, ...input });
    default:
      throw new Error(
        `Provider driver "${driver}" does not support reranking. Use Cohere, Jina AI, Voyage AI, or an OpenAI-compatible rerank server.`,
      );
  }
}

async function resolveProviderInfo(ctx: ProviderCallContext) {
  const { record, credentials } = await loadProviderRuntimeData(ctx.tenantDbName, {
    tenantId: ctx.tenantId,
    key: ctx.model.providerKey,
    projectId: ctx.projectId,
  });
  return { runtime: record, credentials };
}

// ── Cohere ──────────────────────────────────────────────────────────────

async function callCohere(input: {
  apiKey?: string;
  model: string;
  query: string;
  documents: string[];
  topN?: number;
}): Promise<RerankCallResult> {
  if (!input.apiKey) throw new Error('Cohere reranker requires an apiKey credential.');
  const body = {
    model: input.model,
    query: input.query,
    documents: input.documents,
    top_n: input.topN ?? input.documents.length,
  };
  const response = await withResilience(
    () => fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    { key: 'rerank:cohere' },
  );
  if (!response.ok) {
    const errBody = await safeReadText(response);
    throw new Error(`Cohere rerank failed (${response.status}): ${errBody}`);
  }
  const json = (await response.json()) as {
    results?: Array<{ index: number; relevance_score: number }>;
  };
  if (!Array.isArray(json.results)) {
    throw new Error('Cohere rerank: malformed response.');
  }
  return {
    results: json.results.map((r) => ({ index: r.index, score: r.relevance_score })),
  };
}

// ── Jina AI ─────────────────────────────────────────────────────────────

async function callJina(input: {
  apiKey?: string;
  model: string;
  query: string;
  documents: string[];
  topN?: number;
}): Promise<RerankCallResult> {
  if (!input.apiKey) throw new Error('Jina reranker requires an apiKey credential.');
  const body = {
    model: input.model,
    query: input.query,
    documents: input.documents,
    top_n: input.topN ?? input.documents.length,
  };
  const response = await withResilience(
    () => fetch('https://api.jina.ai/v1/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    { key: 'rerank:jina' },
  );
  if (!response.ok) {
    const errBody = await safeReadText(response);
    throw new Error(`Jina rerank failed (${response.status}): ${errBody}`);
  }
  const json = (await response.json()) as {
    results?: Array<{ index: number; relevance_score: number }>;
  };
  if (!Array.isArray(json.results)) throw new Error('Jina rerank: malformed response.');
  return {
    results: json.results.map((r) => ({ index: r.index, score: r.relevance_score })),
  };
}

// ── Voyage AI ───────────────────────────────────────────────────────────

async function callVoyage(input: {
  apiKey?: string;
  model: string;
  query: string;
  documents: string[];
  topN?: number;
}): Promise<RerankCallResult> {
  if (!input.apiKey) throw new Error('Voyage reranker requires an apiKey credential.');
  const body = {
    model: input.model,
    query: input.query,
    documents: input.documents,
    top_k: input.topN ?? input.documents.length,
  };
  const response = await withResilience(
    () => fetch('https://api.voyageai.com/v1/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    { key: 'rerank:voyage' },
  );
  if (!response.ok) {
    const errBody = await safeReadText(response);
    throw new Error(`Voyage rerank failed (${response.status}): ${errBody}`);
  }
  const json = (await response.json()) as {
    data?: Array<{ index: number; relevance_score: number }>;
  };
  if (!Array.isArray(json.data)) throw new Error('Voyage rerank: malformed response.');
  return {
    results: json.data.map((r) => ({ index: r.index, score: r.relevance_score })),
  };
}

// ── OpenAI-compatible (BGE / Mixedbread / self-hosted) ──────────────────

async function callOpenAICompatibleRerank(input: {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  query: string;
  documents: string[];
  topN?: number;
}): Promise<RerankCallResult> {
  if (!input.baseUrl) {
    throw new Error('OpenAI-compatible rerank requires a baseUrl credential.');
  }
  const url = `${input.baseUrl.replace(/\/$/, '')}/rerank`;
  const body = {
    model: input.model,
    query: input.query,
    documents: input.documents,
    top_n: input.topN ?? input.documents.length,
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
  const response = await withResilience(
    () => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }),
    { key: 'rerank:openai-compatible' },
  );
  if (!response.ok) {
    const errBody = await safeReadText(response);
    throw new Error(`Rerank endpoint failed (${response.status}): ${errBody}`);
  }
  const json = (await response.json()) as {
    results?: Array<{ index: number; relevance_score?: number; score?: number }>;
  };
  if (!Array.isArray(json.results)) {
    throw new Error('OpenAI-compatible rerank: malformed response.');
  }
  return {
    results: json.results.map((r) => ({
      index: r.index,
      score: r.relevance_score ?? r.score ?? 0,
    })),
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return '<unable to read response body>';
  }
}

export const _logger = logger;
