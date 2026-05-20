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

export interface RunCrawlerOptions {
  /** URLs to crawl for this run. Overrides the container's saved URL list. */
  urls?: string[];
  /** Legacy alias for `urls` — kept so existing callers don't break. */
  seeds?: string[];
  /** Override webhook receiver for this specific run. */
  callbackUrl?: string;
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
  triggerActor: string;
  metadata?: Record<string, unknown>;
}

export interface CrawlRunSummary {
  jobId: string;
  status: ICrawlJob['status'];
}

export type { ICrawlPlanSnapshot };
