/**
 * Web Search service — resolves a configured Web Search instance (explicit key
 * or the project's single active instance) and executes the query through the
 * driver adapter. Optionally interprets the results with the instance's
 * configured AI model (settings.aiAnswer) when the request asks for an answer.
 */

import { createLogger } from '@/lib/core/logger';
import { fireAndForget } from '@/lib/core/asyncTask';
import { getDatabase, type IWebSearchRunLog } from '@/lib/database';
import {
  listProviderConfigs,
  loadProviderRuntimeData,
  type ProviderConfigView,
} from '@/lib/services/providers/providerService';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import { callWebSearchProvider } from './webSearchAdapter';
import type {
  WebSearchAiAnswerSettings,
  WebSearchInput,
  WebSearchResult,
  WebSearchResultItem,
} from './types';

const logger = createLogger('websearch-service');

/** Results inlined into a run log (snippets truncated to keep records small). */
const LOGGED_RESULTS_LIMIT = 20;
const LOGGED_SNIPPET_MAX = 300;
/** Results handed to the AI model for interpretation. */
const AI_ANSWER_RESULTS_LIMIT = 10;

export interface RunWebSearchOptions extends WebSearchInput {
  /** Instance key. Omit to use the project's single active instance. */
  providerKey?: string;
  /** Attribution only (dashboard test vs API). */
  source?: 'dashboard' | 'api';
}

export async function listWebSearchProviders(
  tenantDbName: string,
  tenantId: string,
  projectId?: string,
): Promise<ProviderConfigView[]> {
  return listProviderConfigs(tenantDbName, tenantId, {
    type: 'websearch',
    projectId,
  });
}

async function withTenantDb(tenantDbName: string) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

export async function listWebSearchRunLogs(
  tenantDbName: string,
  searchKey: string,
  options?: { limit?: number; skip?: number; from?: Date; to?: Date },
): Promise<IWebSearchRunLog[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listWebSearchRunLogs(searchKey, options);
}

function logRun(
  tenantDbName: string,
  entry: Omit<IWebSearchRunLog, '_id' | 'createdAt'>,
): void {
  // Resolve attribution + rollup synchronously so the request ALS is in scope.
  const attribution = recordUsageEvent({
    tenantDbName,
    tenantId: entry.tenantId,
    projectId: entry.projectId,
    service: 'websearch',
    refKey: entry.searchKey,
    status: entry.status,
    latencyMs: entry.latencyMs,
    units: { results: entry.resultCount },
  });
  fireAndForget('log-websearch-run', async () => {
    const db = await withTenantDb(tenantDbName);
    await db.createWebSearchRunLog({
      ...entry,
      userId: attribution.userId,
      apiTokenId: attribution.apiTokenId,
      actorType: attribution.actorType,
    });
  });
}

function loggableResults(results: WebSearchResultItem[]): IWebSearchRunLog['results'] {
  return results.slice(0, LOGGED_RESULTS_LIMIT).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet.length > LOGGED_SNIPPET_MAX
      ? `${r.snippet.slice(0, LOGGED_SNIPPET_MAX)}…`
      : r.snippet,
    position: r.position,
  }));
}

async function resolveProviderKey(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  explicitKey: string | undefined,
): Promise<string> {
  if (explicitKey) return explicitKey;

  const providers = await listWebSearchProviders(tenantDbName, tenantId, projectId);
  const active = providers.filter((p) => p.status === 'active');
  if (active.length === 0) {
    throw new Error(
      'No active web search instance is configured. Create one under Data → Web Search.',
    );
  }
  if (active.length > 1) {
    throw new Error(
      `Multiple web search instances are configured (${active.map((p) => p.key).join(', ')}). Specify one with the \`provider\` field or the /websearch/:key/search endpoint.`,
    );
  }
  return active[0].key;
}

function aiAnswerSettingsOf(settings: Record<string, unknown> | undefined): WebSearchAiAnswerSettings {
  const raw = settings?.aiAnswer;
  return raw && typeof raw === 'object' ? (raw as WebSearchAiAnswerSettings) : {};
}

async function interpretResults(params: {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  modelKey: string;
  instructions?: string;
  query: string;
  results: WebSearchResultItem[];
}): Promise<string> {
  // Lazy import keeps the search path free of the inference module unless an
  // AI answer is actually requested.
  const { handleChatCompletion } = await import('@/lib/services/models/inferenceService');

  const sources = params.results
    .slice(0, AI_ANSWER_RESULTS_LIMIT)
    .map((r) => `[${r.position}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
    .join('\n\n');

  const prompt = [
    params.instructions?.trim(),
    'You are given web search results. Using ONLY these results, answer the query concisely.',
    'Cite the result numbers you used like [1], [2]. If the results do not answer the query, say so.',
    '',
    `Query: ${params.query}`,
    '',
    'Results:',
    sources,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');

  const { response } = await handleChatCompletion({
    tenantDbName: params.tenantDbName,
    tenantId: params.tenantId,
    modelKey: params.modelKey,
    projectId: params.projectId ?? '',
    body: {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    },
  });

  const text = (response as { choices?: Array<{ message?: { content?: string } }> })
    ?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('AI answer model returned an empty response.');
  }
  return text.trim();
}

export async function runWebSearch(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  options: RunWebSearchOptions,
): Promise<WebSearchResult> {
  const query = options.query?.trim();
  if (!query) throw new Error('`query` is required.');

  const providerKey = await resolveProviderKey(
    tenantDbName,
    tenantId,
    projectId,
    options.providerKey,
  );

  const { record, credentials } = await loadProviderRuntimeData(tenantDbName, {
    tenantId,
    key: providerKey,
    projectId,
  });

  if (record.type !== 'websearch') {
    throw new Error(`Provider "${providerKey}" is not a web search provider.`);
  }
  if (record.status !== 'active') {
    throw new Error(`Provider "${providerKey}" is not active.`);
  }

  // An answer is a best-effort extra on top of the search, never a reason to
  // fail it: agents set `includeAnswer` on their own and API callers cannot see
  // the instance settings. When AI answers are off (or have no model) the
  // search still runs and the response says why there is no AI answer.
  const aiSettings = aiAnswerSettingsOf(record.settings as Record<string, unknown>);
  const warnings: string[] = [];
  let answerModelKey: string | undefined;
  if (options.includeAnswer) {
    if (aiSettings.enabled !== true) {
      warnings.push(
        `AI answers are not enabled on instance "${providerKey}"; returning search results only. Enable them under Configuration → AI Answer.`,
      );
    } else if (!aiSettings.modelKey) {
      warnings.push(
        `Instance "${providerKey}" has AI answers enabled but no model selected; returning search results only. Pick a model under Configuration → AI Answer.`,
      );
    } else {
      answerModelKey = aiSettings.modelKey;
    }
  }

  const startedAt = Date.now();
  const logEntry: Pick<IWebSearchRunLog, 'tenantId' | 'projectId' | 'searchKey' | 'driver' | 'query' | 'source'> = {
    tenantId,
    projectId,
    searchKey: providerKey,
    driver: record.driver,
    query,
    source: options.source ?? 'api',
  };
  try {
    const { results, answer: providerAnswer } = await callWebSearchProvider(
      record,
      credentials as Record<string, unknown>,
      { ...options, query },
    );

    let answer = providerAnswer;
    let answerModel: string | undefined;
    if (answerModelKey) {
      try {
        answer = await interpretResults({
          tenantDbName,
          tenantId,
          projectId,
          modelKey: answerModelKey,
          instructions: aiSettings.instructions,
          query,
          results,
        });
        answerModel = answerModelKey;
      } catch (error) {
        // The provider call already succeeded (and was billed) — keep its
        // results rather than throwing them away over the answer.
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`AI answer failed: ${message}`);
        logger.warn('Web search AI answer failed', { tenantId, projectId, providerKey, error: message });
      }
    }

    const latencyMs = Date.now() - startedAt;

    logRun(tenantDbName, {
      ...logEntry,
      resultCount: results.length,
      latencyMs,
      status: 'success',
      results: loggableResults(results),
      answer,
      metadata: answerModel || warnings.length > 0
        ? { ...(answerModel ? { answerModel } : {}), ...(warnings.length > 0 ? { warnings } : {}) }
        : undefined,
    });

    return {
      providerKey,
      driver: record.driver,
      query,
      results,
      answer,
      answerModel,
      ...(warnings.length > 0 ? { warnings } : {}),
      latencyMs,
    };
  } catch (error) {
    logRun(tenantDbName, {
      ...logEntry,
      resultCount: 0,
      latencyMs: Date.now() - startedAt,
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    logger.warn('Web search failed', {
      tenantId,
      projectId,
      providerKey,
      driver: record.driver,
      error,
    });
    throw error;
  }
}
