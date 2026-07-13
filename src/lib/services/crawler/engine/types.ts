/**
 * Public types for the crawler engine.
 *
 * The engine is the only thing that will eventually be extracted into the
 * standalone `@cognipeer/crawler` npm package. Files under engine/ must
 * NOT import anything from the rest of the console (no `@/lib/...`).
 */

export type CrawlerEngineMode = 'axios' | 'playwright' | 'auto';

export interface CrawlScope {
  sameDomainOnly: boolean;
  includeSubdomains: boolean;
  allowList?: string[];
  blockList?: string[];
}

export interface CrawlCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
}

export interface CrawlHttpConfig {
  userAgent?: string;
  acceptLanguage?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  retries?: number;
  headers?: Record<string, string>;
  cookies?: CrawlCookie[];
  basicAuth?: { username: string; password: string };
  bearerToken?: string;
  allowPrivateNetwork?: boolean;
  /**
   * Skip TLS certificate verification (DANGER: disables MITM protection).
   * Opt-in escape hatch for sites whose server misconfigures the TLS chain
   * (e.g. missing intermediate certificate) so Node can't build trust even
   * though browsers/OS trust stores can. Default false.
   */
  allowInsecureTls?: boolean;
}

export interface CrawlMarkdownOptions {
  ocr?: { enabled: boolean; languages?: string[] };
}

export interface CrawlPlan {
  seeds: string[];
  engine: CrawlerEngineMode;
  maxDepth: number;
  maxPages: number;
  autoCrawl: boolean;
  scope: CrawlScope;
  http: CrawlHttpConfig;
  downloadableMimes?: string[];
  markdownOptions?: CrawlMarkdownOptions;
}

export type PageResultType = 'html' | 'file' | 'error';

export interface PageResult {
  url: string;
  parentUrl?: string;
  depth: number;
  type: PageResultType;
  httpStatus?: number;
  contentType?: string;
  title?: string;
  description?: string;
  /**
   * Markdown text. Present for `type === 'html'` (rendered page content) and,
   * when extraction succeeds, for `type === 'file'` (PDF/DOCX/XLSX/… attachment
   * content converted via `@cognipeer/to-markdown`).
   */
  body?: string;
  /** Raw bytes of fetched content (HTML before markdown, or file). */
  bytes?: number;
  errorMessage?: string;
  fetchedAt: Date;
}

export interface EngineLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface CrawlEngineDeps {
  logger: EngineLogger;
  /** Abort the in-flight crawl. Streamed pages drain to completion. */
  signal?: AbortSignal;
}

export const DEFAULT_DOWNLOADABLE_MIMES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
];

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

export const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9,tr;q=0.8';
