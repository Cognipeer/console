import crypto from 'crypto';
import { createLogger } from '@/lib/core/logger';
import type { IModel, ISemanticCacheConfig } from '@/lib/database';

const logger = createLogger('semantic-cache');
import { handleEmbeddingRequest } from './inferenceService';
import {
  queryVectorIndex,
  upsertVectors,
} from '@/lib/services/vector/vectorService';

export interface CacheLookupResult {
  hit: boolean;
  response?: Record<string, unknown>;
  score?: number;
}

function buildCacheId(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 32);
}

function extractUserContent(messages: unknown[]): string {
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role === 'user') {
      if (typeof msg.content === 'string') {
        parts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === 'string') parts.push(part);
          else if (typeof part?.text === 'string') parts.push(part.text);
        }
      }
      break;
    }
  }
  return parts.join('\n');
}

async function getEmbedding(
  tenantDbName: string,
  projectId: string,
  embeddingModelKey: string,
  text: string,
): Promise<number[]> {
  const result = await handleEmbeddingRequest({
    tenantDbName,
    modelKey: embeddingModelKey,
    projectId,
    body: { input: text },
  });

  const data = result.response?.data as
    | Array<{ embedding?: number[] }>
    | undefined;

  if (!data || data.length === 0 || !data[0].embedding) {
    throw new Error('Failed to generate embedding for cache lookup');
  }

  return data[0].embedding;
}

export async function lookupCache(params: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  config: ISemanticCacheConfig;
  messages: unknown[];
}): Promise<CacheLookupResult> {
  const { tenantDbName, tenantId, projectId, config, messages } = params;

  const userContent = extractUserContent(messages);
  if (!userContent) {
    return { hit: false };
  }

  try {
    const embedding = await getEmbedding(
      tenantDbName,
      projectId,
      config.embeddingModelKey,
      userContent,
    );

    const queryResult = await queryVectorIndex(
      tenantDbName,
      tenantId,
      projectId,
      {
        providerKey: config.vectorProviderKey,
        indexKey: config.vectorIndexKey,
        query: {
          vector: embedding,
          topK: 1,
          filter: { _cacheType: 'semantic_cache' },
        },
      },
    );

    if (queryResult.matches.length > 0) {
      const topMatch = queryResult.matches[0];

      if (topMatch.score >= config.similarityThreshold) {
        const metadata = topMatch.metadata || {};

        if (config.ttlSeconds > 0 && metadata._cachedAt) {
          const cachedAt = Number(metadata._cachedAt);
          const now = Date.now();
          if (now - cachedAt > config.ttlSeconds * 1000) {
            return { hit: false };
          }
        }

        if (metadata._cachedResponse) {
          try {
            const response =
              typeof metadata._cachedResponse === 'string'
                ? JSON.parse(metadata._cachedResponse)
                : metadata._cachedResponse;
            return { hit: true, response, score: topMatch.score };
          } catch {
            return { hit: false };
          }
        }
      }
    }

    return { hit: false };
  } catch (error) {
    logger.warn('Cache lookup failed, proceeding without cache', { error });
    return { hit: false };
  }
}

export async function storeInCache(params: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  config: ISemanticCacheConfig;
  messages: unknown[];
  response: Record<string, unknown>;
}): Promise<void> {
  const { tenantDbName, tenantId, projectId, config, messages, response } = params;

  const userContent = extractUserContent(messages);
  if (!userContent) {
    return;
  }

  try {
    const embedding = await getEmbedding(
      tenantDbName,
      projectId,
      config.embeddingModelKey,
      userContent,
    );

    const cacheId = buildCacheId(userContent);

    await upsertVectors(tenantDbName, tenantId, projectId, {
      providerKey: config.vectorProviderKey,
      indexKey: config.vectorIndexKey,
      vectors: [
        {
          id: cacheId,
          values: embedding,
          metadata: {
            _cacheType: 'semantic_cache',
            _cachedAt: Date.now(),
            _cachedResponse: JSON.stringify(response),
            _queryPreview: userContent.slice(0, 200),
          },
        },
      ],
    });
  } catch (error) {
    logger.warn('Failed to store cache entry', { error });
  }
}

export function isSemanticCacheEnabled(model: IModel): boolean {
  return Boolean(
    model.semanticCache?.enabled &&
      model.semanticCache.vectorProviderKey &&
      model.semanticCache.vectorIndexKey &&
      model.semanticCache.embeddingModelKey,
  );
}
