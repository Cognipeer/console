/**
 * Shadow mode for the model calls the application makes on its own: a RAG
 * answer, an LLM reranker or judge, analysis and evaluation runs, red-team
 * probes, dataset generation, web-search answers.
 *
 * These calls do not pass through the gateway routes, which are where the
 * `llm` limits are enforced. Counting them against the caller's limits would
 * start refusing work that tenants run today, so for now they are only counted
 * against the same limits on separate (`rate_limit_shadow`) counters, and a
 * call that would have gone over is logged. Nothing is refused and the real
 * counters are untouched. The log shows how often enforcing them would refuse
 * work, before that is turned on.
 *
 * The caller comes from the request context (`runWithRequestContext`) when the
 * work runs inside a request or an agent run; background work counts against
 * tenant and project limits only.
 */
import { fireAndForget } from '@/lib/core/asyncTask';
import { createLogger } from '@/lib/core/logger';
import type { TokenUsage } from '@/lib/services/models/usageLogger';
import { checkRateLimit } from './quotaGuard';
import { serviceQuotaContext } from './serviceQuota';

const logger = createLogger('quota-shadow');

export const SHADOW_COUNTER_PREFIX = 'rate_limit_shadow';

export interface InternalLlmCall {
  tenantDbName: string;
  tenantId?: string;
  projectId: string;
  modelKey: string;
  route?: string;
}

/** Count one settled internal model call in shadow mode; logs when the `llm` limits would have refused it. */
export function shadowInternalLlmUsage(call: InternalLlmCall, usage?: TokenUsage): void {
  fireAndForget('quota-shadow-llm', async () => {
    const context = serviceQuotaContext(
      { tenantDbName: call.tenantDbName, tenantId: call.tenantId, projectId: call.projectId },
      { domain: 'llm', resourceKey: call.modelKey },
    );
    if (!context) return;
    const tokens = usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    const result = await checkRateLimit(context, { requests: 1, tokens }, { counterPrefix: SHADOW_COUNTER_PREFIX });
    if (!result.allowed) {
      logger.warn('Internal model call would exceed the llm limits (shadow mode, not refused)', {
        tenantId: context.tenantId,
        projectId: context.projectId,
        modelKey: call.modelKey,
        route: call.route,
        userId: context.userId,
        tokenId: context.tokenId,
        reason: result.reason,
      });
    }
  });
}
