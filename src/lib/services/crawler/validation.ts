/**
 * Zod schemas used by both Fastify routes and the dashboard API.
 */

import { z } from 'zod';

const scopeSchema = z.object({
  sameDomainOnly: z.boolean().default(true),
  includeSubdomains: z.boolean().default(false),
  allowList: z.array(z.string()).optional(),
  blockList: z.array(z.string()).optional(),
});

const cookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  expires: z.number().optional(),
});

const httpSchema = z.object({
  userAgent: z.string().optional(),
  acceptLanguage: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  maxConcurrency: z.number().int().min(1).max(16).optional(),
  retries: z.number().int().min(1).max(5).optional(),
  headers: z.record(z.string()).optional(),
  cookies: z.array(cookieSchema).optional(),
  basicAuth: z.object({ username: z.string(), password: z.string() }).optional(),
  bearerToken: z.string().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  allowInsecureTls: z.boolean().optional(),
});

const webhookSchema = z.object({
  url: z.string().url(),
  secret: z.string().optional(),
  events: z.array(z.enum(['page', 'completed', 'failed'])).min(1),
});

const ragSchema = z.object({
  ragModuleKey: z.string().min(1),
  enabled: z.boolean(),
});

const scheduleSchema = z.object({
  mode: z.enum(['interval', 'cron']),
  enabled: z.boolean(),
  intervalSeconds: z.number().int().min(60).max(86_400).optional(),
  cron: z.string().min(1).max(120).optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
}).refine(
  (v) => (v.mode === 'interval' ? typeof v.intervalSeconds === 'number' : !!v.cron),
  { message: 'interval mode requires intervalSeconds; cron mode requires cron' },
);

const markdownOptionsSchema = z.object({
  ocr: z.object({
    enabled: z.boolean(),
    languages: z.array(z.string()).optional(),
  }).optional(),
  outputFormat: z.enum(['markdown', 'text']).optional(),
  cleanup: z.boolean().optional(),
  stripDataImages: z.boolean().optional(),
  mainContentOnly: z.boolean().optional(),
  contentSelector: z.string().max(200).optional(),
  removeSelectors: z.array(z.string().max(200)).max(50).optional(),
  maxBodyChars: z.number().int().min(0).max(5_000_000).optional(),
}).optional();

const engineSchema = z.enum(['axios', 'playwright', 'auto']);

/** Dispatch mode for a run: block (`sync`) or enqueue + callback (`async`). */
const runModeSchema = z.enum(['sync', 'async']);

export const createCrawlerInputSchema = z.object({
  key: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/i, 'lowercase letters, numbers, dash, underscore').optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** Optional initial URL list. The crawler is a container — URLs can be added later via /urls. */
  seeds: z.array(z.string().url()).max(500).optional(),
  engine: engineSchema.default('auto'),
  maxDepth: z.number().int().min(0).max(3).default(0),
  maxPages: z.number().int().min(0).max(5000).default(50),
  autoCrawl: z.boolean().default(false),
  scope: scopeSchema.partial().optional(),
  http: httpSchema.partial().optional(),
  downloadableMimes: z.array(z.string()).optional(),
  markdownOptions: markdownOptionsSchema,
  rag: ragSchema.optional(),
  webhook: webhookSchema.optional(),
  schedule: scheduleSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateCrawlerInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  seeds: z.array(z.string().url()).max(500).optional(),
  engine: engineSchema.optional(),
  maxDepth: z.number().int().min(0).max(3).optional(),
  maxPages: z.number().int().min(0).max(5000).optional(),
  autoCrawl: z.boolean().optional(),
  scope: scopeSchema.partial().optional(),
  http: httpSchema.partial().optional(),
  downloadableMimes: z.array(z.string()).optional(),
  markdownOptions: markdownOptionsSchema,
  rag: ragSchema.nullable().optional(),
  webhook: webhookSchema.nullable().optional(),
  schedule: scheduleSchema.nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const runCrawlerOptionsSchema = z.object({
  /** URLs to crawl. Overrides the saved container targets for this run. */
  urls: z.array(z.string().url()).max(500).optional(),
  /** Legacy alias for urls — preserved so existing callers keep working. */
  seeds: z.array(z.string().url()).max(500).optional(),
  callbackUrl: z.string().url().optional(),
  /** Run mode. Omit to use the API default (`async`). */
  mode: runModeSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

/** Body for `POST /crawler/crawlers/:key/urls` and `DELETE …/urls`. */
export const crawlerUrlsBodySchema = z.object({
  urls: z.array(z.string().url()).min(1).max(500),
});

/** Body for `POST /crawler/crawlers/:key/crawl` — explicit ad-hoc-on-container. */
export const crawlOnContainerSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(500),
  callbackUrl: z.string().url().optional(),
  /** Run mode. Omit to use the API default (`async`). */
  mode: runModeSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const adhocCrawlInputSchema = z.object({
  seeds: z.array(z.string().url()).min(1).max(50),
  engine: engineSchema.default('auto'),
  maxDepth: z.number().int().min(0).max(3).default(0),
  maxPages: z.number().int().min(0).max(5000).default(20),
  autoCrawl: z.boolean().default(false),
  scope: scopeSchema.partial().optional(),
  http: httpSchema.partial().optional(),
  downloadableMimes: z.array(z.string()).optional(),
  markdownOptions: markdownOptionsSchema,
  rag: ragSchema.optional(),
  webhook: webhookSchema.optional(),
  callbackUrl: z.string().url().optional(),
  /** Run mode. Omit to use the API default (`async`). */
  mode: runModeSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateCrawlerBody = z.infer<typeof createCrawlerInputSchema>;
export type UpdateCrawlerBody = z.infer<typeof updateCrawlerInputSchema>;
export type RunCrawlerOptionsBody = z.infer<typeof runCrawlerOptionsSchema>;
export type AdhocCrawlBody = z.infer<typeof adhocCrawlInputSchema>;
export type CrawlerUrlsBody = z.infer<typeof crawlerUrlsBodySchema>;
export type CrawlOnContainerBody = z.infer<typeof crawlOnContainerSchema>;
