/**
 * Service-layer DTOs for the Crawler module.
 *
 * These are the shapes that flow through the HTTP API and the dashboard
 * UI. The DB-facing interfaces live in lib/database/provider/types.domain
 * (ICrawler / ICrawlJob / ICrawlResult).
 */

import type {
  ICrawler,
  ICrawlerHttpConfig,
  ICrawlerRagBinding,
  ICrawlerSchedule,
  ICrawlerScope,
  ICrawlerWebhookConfig,
  ICrawlJob,
  ICrawlResult,
  ICrawlPlanSnapshot,
  CrawlerEngine,
} from '@/lib/database';

export interface CrawlerContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
}

export interface CreateCrawlerInput {
  key?: string;
  name: string;
  description?: string;
  /** Optional initial URL list. Crawler is a container — URLs can be added later. */
  seeds?: string[];
  engine?: CrawlerEngine;
  maxDepth?: number;
  maxPages?: number;
  autoCrawl?: boolean;
  scope?: Partial<ICrawlerScope>;
  http?: Partial<ICrawlerHttpConfig>;
  downloadableMimes?: string[];
  markdownOptions?: ICrawler['markdownOptions'];
  rag?: ICrawlerRagBinding;
  webhook?: ICrawlerWebhookConfig;
  schedule?: ICrawlerSchedule;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateCrawlerInput {
  name?: string;
  description?: string;
  status?: ICrawler['status'];
  seeds?: string[];
  engine?: CrawlerEngine;
  maxDepth?: number;
  maxPages?: number;
  autoCrawl?: boolean;
  scope?: Partial<ICrawlerScope>;
  http?: Partial<ICrawlerHttpConfig>;
  downloadableMimes?: string[];
  markdownOptions?: ICrawler['markdownOptions'];
  rag?: ICrawlerRagBinding | null;
  webhook?: ICrawlerWebhookConfig | null;
  schedule?: ICrawlerSchedule | null;
  metadata?: Record<string, unknown>;
  updatedBy: string;
}

export type CrawlerView = Omit<ICrawler, '_id'> & { id: string };
export type CrawlJobView = Omit<ICrawlJob, '_id'> & { id: string };
export type CrawlResultView = Omit<ICrawlResult, '_id'> & { id: string };

/**
 * Dispatch mode for a run.
 *
 *  - `sync`  : block until the crawl finishes (the call returns once every
 *              page has been processed). Default at the service layer so
 *              programmatic callers and tests keep their existing semantics.
 *  - `async` : fire-and-forget — enqueue the job, return immediately with
 *              `status: 'queued'`, and let the queue consumer run it in the
 *              background. Completion is surfaced by polling the job record
 *              and/or the `callbackUrl` webhook. This is what the HTTP API
 *              (and therefore the dashboard UI) uses so the request returns
 *              right away instead of hanging for the whole crawl.
 */
export type CrawlRunMode = 'sync' | 'async';

export interface RunCrawlerOptions {
  /** URLs to crawl for this run. Overrides the container's saved URL list. */
  urls?: string[];
  /** Legacy alias for `urls` — kept so existing callers don't break. */
  seeds?: string[];
  /** Override webhook receiver for this specific run. */
  callbackUrl?: string;
  /** Sync (block) or async (enqueue + callback). Defaults to `sync`. */
  mode?: CrawlRunMode;
  trigger?: ICrawlJob['trigger'];
  triggerActor: string;
  metadata?: Record<string, unknown>;
}

export interface AdhocCrawlInput {
  seeds: string[];
  engine?: CrawlerEngine;
  maxDepth?: number;
  maxPages?: number;
  autoCrawl?: boolean;
  scope?: Partial<ICrawlerScope>;
  http?: Partial<ICrawlerHttpConfig>;
  downloadableMimes?: string[];
  markdownOptions?: ICrawler['markdownOptions'];
  rag?: ICrawlerRagBinding;
  webhook?: ICrawlerWebhookConfig;
  callbackUrl?: string;
  /** Sync (block) or async (enqueue + callback). Defaults to `sync`. */
  mode?: CrawlRunMode;
  triggerActor: string;
  metadata?: Record<string, unknown>;
}

export interface CrawlRunSummary {
  jobId: string;
  status: ICrawlJob['status'];
}

export type { ICrawlPlanSnapshot };
