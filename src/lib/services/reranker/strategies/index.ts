/**
 * Strategy registry.
 *
 * Each strategy receives a normalized input + reranker config and returns
 * `[index, score, originalScore]` tuples in arbitrary order. The service
 * sorts, filters by threshold, and slices to topN.
 */

import type { IModel, IReranker } from '@/lib/database';

export interface StrategyContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  reranker: IReranker;
  /** Pre-resolved model (when strategy needs one); undefined for heuristic/fusion. */
  model?: IModel;
}

export interface StrategyInputDocument {
  index: number;
  content: string;
  originalScore?: number;
}

export interface StrategyOutputItem {
  index: number;
  score: number;
}

export interface RerankerStrategyImpl {
  run(
    ctx: StrategyContext,
    query: string,
    documents: StrategyInputDocument[],
    topN: number,
  ): Promise<StrategyOutputItem[]>;
}

import { dedicatedModelStrategy } from './dedicatedModel';
import { llmJudgeStrategy } from './llmJudge';
import { llmListwiseStrategy } from './llmListwise';
import { heuristicStrategy } from './heuristic';

export const STRATEGIES: Record<string, RerankerStrategyImpl> = {
  'dedicated-model': dedicatedModelStrategy,
  'llm-judge': llmJudgeStrategy,
  'llm-listwise': llmListwiseStrategy,
  heuristic: heuristicStrategy,
};

export function getStrategy(name: string): RerankerStrategyImpl {
  const impl = STRATEGIES[name];
  if (!impl) {
    throw new Error(`Reranker strategy "${name}" is not implemented.`);
  }
  return impl;
}
