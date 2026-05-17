/**
 * Reranker service
 *
 * First-class service: a strategy-driven re-scoring pipeline over candidate
 * documents. Backing engine (dedicated rerank model, LLM, heuristic, …) is
 * selected via `strategy` + `config.modelKey`.
 *
 * Used directly by:
 *   - the dashboard "playground" via /api/reranker/:key/run
 *   - external API clients via POST /api/client/v1/rerank/:key
 *   - the RAG pipeline (ragService.queryRag) when the RAG module sets `rerankerKey`
 *
 * Future cache layer wraps this service's run() without strategy changes.
 */

import crypto from 'crypto';
import { createLogger } from '@/lib/core/logger';
import { fireAndForget } from '@/lib/core/asyncTask';
import { getDatabase } from '@/lib/database';
import type {
  IReranker,
  IRerankerRunLog,
  IRerankerConfig,
  RerankerStrategy,
} from '@/lib/database';
import { getModelByKey } from '@/lib/services/models/modelService';
import { getStrategy } from './strategies';
import type {
  CreateRerankerRequest,
  Reranker,
  RerankerDocumentInput,
  RerankerRunRequest,
  RerankerRunResult,
  RerankerRunResultItem,
  UpdateRerankerRequest,
} from './types';

const logger = createLogger('reranker');

/* ── Key generation ──────────────────────────────────────────────────── */

function generateKey(name: string, existingKey?: string): string {
  if (existingKey) return existingKey;
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) +
    '-' +
    crypto.randomBytes(4).toString('hex')
  );
}

function validateStrategyConfig(strategy: RerankerStrategy, config: IRerankerConfig): void {
  switch (strategy) {
    case 'dedicated-model':
    case 'llm-judge':
    case 'llm-listwise':
      if (!config?.modelKey || typeof config.modelKey !== 'string') {
        throw new Error(`Strategy "${strategy}" requires config.modelKey.`);
      }
      break;
    case 'heuristic':
    case 'fusion':
      // No model required.
      break;
    default:
      throw new Error(`Unknown reranker strategy: ${strategy}`);
  }
}

/* ── CRUD ────────────────────────────────────────────────────────────── */

export async function createReranker(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  request: CreateRerankerRequest,
): Promise<Reranker> {
  validateStrategyConfig(request.strategy, request.config);
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const key = generateKey(request.name, request.key);
  const existing = await db.findRerankerByKey(key, projectId);
  if (existing) {
    throw new Error(`Reranker with key "${key}" already exists.`);
  }

  return db.createReranker({
    tenantId,
    projectId,
    key,
    name: request.name,
    description: request.description,
    strategy: request.strategy,
    config: request.config,
    status: request.status ?? 'active',
    metadata: request.metadata,
    createdBy: request.createdBy,
  });
}

export async function updateReranker(
  tenantDbName: string,
  rerankerId: string,
  request: UpdateRerankerRequest,
): Promise<Reranker | null> {
  if (request.strategy && request.config) {
    validateStrategyConfig(request.strategy, request.config);
  }
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const updates: Partial<IReranker> = {};
  if (request.name !== undefined) updates.name = request.name;
  if (request.description !== undefined) updates.description = request.description;
  if (request.strategy !== undefined) updates.strategy = request.strategy;
  if (request.config !== undefined) updates.config = request.config;
  if (request.status !== undefined) updates.status = request.status;
  if (request.metadata !== undefined) updates.metadata = request.metadata;
  if (request.updatedBy !== undefined) updates.updatedBy = request.updatedBy;
  return db.updateReranker(rerankerId, updates);
}

export async function deleteReranker(
  tenantDbName: string,
  rerankerId: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteReranker(rerankerId);
}

export async function getRerankerByKey(
  tenantDbName: string,
  key: string,
  projectId?: string,
): Promise<Reranker | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findRerankerByKey(key, projectId);
}

export async function getRerankerById(
  tenantDbName: string,
  id: string,
): Promise<Reranker | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findRerankerById(id);
}

export async function listRerankers(
  tenantDbName: string,
  filters?: { projectId?: string; status?: 'active' | 'disabled'; search?: string },
): Promise<Reranker[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listRerankers(filters);
}

/* ── Run logs ────────────────────────────────────────────────────────── */

export async function listRerankerRunLogs(
  tenantDbName: string,
  rerankerKey: string,
  options?: { limit?: number; from?: Date; to?: Date },
): Promise<IRerankerRunLog[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listRerankerRunLogs(rerankerKey, options);
}

/* ── Run (the main entry point) ──────────────────────────────────────── */

export async function runReranker(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  rerankerKey: string,
  request: RerankerRunRequest,
): Promise<RerankerRunResult> {
  const start = Date.now();
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const reranker = await db.findRerankerByKey(rerankerKey, projectId);
  if (!reranker) {
    throw new Error(`Reranker "${rerankerKey}" not found.`);
  }
  if (reranker.status !== 'active') {
    throw new Error(`Reranker "${rerankerKey}" is disabled.`);
  }

  if (!request.query || typeof request.query !== 'string') {
    throw new Error('Reranker run: `query` is required.');
  }
  if (!Array.isArray(request.documents) || request.documents.length === 0) {
    throw new Error('Reranker run: `documents` must be a non-empty array.');
  }

  const cfg = reranker.config ?? {};
  const effectiveTopN = request.topN ?? cfg.topN ?? request.documents.length;

  // Normalize input documents to strategy shape.
  const inputDocs = request.documents.map((d, i) => ({
    index: i,
    content: d.content,
    originalScore: d.score,
  }));

  let scored;
  try {
    const strategy = getStrategy(reranker.strategy);
    let model;
    if (cfg.modelKey && ['dedicated-model', 'llm-judge', 'llm-listwise'].includes(reranker.strategy)) {
      model = await getModelByKey(tenantDbName, cfg.modelKey, projectId ?? '');
      if (!model) {
        throw new Error(`Reranker model "${cfg.modelKey}" not found.`);
      }
    }
    scored = await strategy.run(
      {
        tenantDbName,
        tenantId,
        projectId,
        reranker,
        model,
      },
      request.query,
      inputDocs,
      effectiveTopN,
    );
  } catch (error) {
    const latencyMs = Date.now() - start;
    fireAndForget('log-reranker-error', async () => {
      await db.createRerankerRunLog({
        tenantId,
        projectId,
        rerankerKey: reranker.key,
        strategy: reranker.strategy,
        modelKey: cfg.modelKey,
        query: request.query.slice(0, 500),
        inputCount: request.documents.length,
        outputCount: 0,
        latencyMs,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        source: request.source,
        ragModuleKey: request.ragModuleKey,
      });
    });
    throw error;
  }

  // Optional score normalization (minmax to [0,1]).
  if (cfg.scoreNormalization === 'minmax' && scored.length > 1) {
    const values = scored.map((s) => s.score);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    if (range > 0) {
      scored = scored.map((s) => ({ ...s, score: (s.score - min) / range }));
    }
  }

  // Sort descending by reranked score, apply threshold + topN.
  scored.sort((a, b) => b.score - a.score);
  if (typeof cfg.scoreThreshold === 'number') {
    scored = scored.filter((s) => s.score >= cfg.scoreThreshold!);
  }
  scored = scored.slice(0, effectiveTopN);

  const results: RerankerRunResultItem[] = scored.map((s) => {
    const original = request.documents[s.index] as RerankerDocumentInput;
    return {
      index: s.index,
      id: original.id,
      score: s.score,
      originalScore: original.score,
      content: original.content,
      metadata: original.metadata,
    };
  });

  const latencyMs = Date.now() - start;

  // Update reranker stats + log run.
  fireAndForget('log-reranker-success', async () => {
    try {
      await db.createRerankerRunLog({
        tenantId,
        projectId,
        rerankerKey: reranker.key,
        strategy: reranker.strategy,
        modelKey: cfg.modelKey,
        query: request.query.slice(0, 500),
        inputCount: request.documents.length,
        outputCount: results.length,
        latencyMs,
        status: 'success',
        source: request.source,
        ragModuleKey: request.ragModuleKey,
      });
    } catch (err) {
      logger.warn('Failed to log reranker run', { error: err });
    }
    try {
      const total = (reranker.totalRuns ?? 0) + 1;
      const prevAvg = reranker.avgLatencyMs ?? latencyMs;
      const newAvg = prevAvg + (latencyMs - prevAvg) / total;
      await db.updateReranker(String(reranker._id), {
        totalRuns: total,
        avgLatencyMs: newAvg,
        lastUsedAt: new Date(),
      });
    } catch (err) {
      logger.warn('Failed to update reranker stats', { error: err });
    }
  });

  return {
    rerankerKey: reranker.key,
    strategy: reranker.strategy,
    modelKey: cfg.modelKey,
    results,
    latencyMs,
    inputCount: request.documents.length,
    outputCount: results.length,
  };
}
