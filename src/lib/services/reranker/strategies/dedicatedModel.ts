import type { RerankerStrategyImpl } from './index';
import { callRerankProvider } from '../rerankAdapter';

export const dedicatedModelStrategy: RerankerStrategyImpl = {
  async run(ctx, query, documents, topN) {
    if (!ctx.model) {
      throw new Error('dedicated-model strategy requires a model with category=rerank.');
    }
    if (ctx.model.category !== 'rerank') {
      throw new Error(
        `Model "${ctx.model.key}" has category "${ctx.model.category}". The dedicated-model strategy requires a model with category "rerank".`,
      );
    }
    const result = await callRerankProvider(
      {
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        model: ctx.model,
      },
      {
        query,
        documents: documents.map((d) => d.content),
        topN,
      },
    );
    return result.results.map((r) => ({
      index: documents[r.index].index,
      score: r.score,
    }));
  },
};
