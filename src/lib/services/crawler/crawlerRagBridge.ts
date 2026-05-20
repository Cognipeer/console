/**
 * Crawler ↔ RAG bridge.
 *
 * For each successful HTML page the crawler produces, we optionally pipe
 * the markdown body into the configured RAG module via `ingestDocument`.
 * Failures are recorded against the crawl result but never propagate as
 * a crawl error (one bad page should not kill the run).
 */

import { createLogger } from '@/lib/core/logger';
import { ingestDocument } from '@/lib/services/rag';
import type { ICrawlerRagBinding } from '@/lib/database';

const log = createLogger('crawler:rag-bridge');

export interface IngestPageInput {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  rag: ICrawlerRagBinding;
  crawlerKey?: string;
  jobId: string;
  url: string;
  title?: string;
  bodyMarkdown: string;
  createdBy: string;
  depth: number;
}

export interface IngestPageOutput {
  ragStatus: 'indexed' | 'skipped' | 'failed';
  ragDocumentId?: string;
  errorMessage?: string;
}

export async function ingestCrawlPage(input: IngestPageInput): Promise<IngestPageOutput> {
  if (!input.rag.enabled) {
    return { ragStatus: 'skipped' };
  }
  if (!input.bodyMarkdown || input.bodyMarkdown.trim().length === 0) {
    return { ragStatus: 'skipped' };
  }

  try {
    const doc = await ingestDocument(
      input.tenantDbName,
      input.tenantId,
      input.projectId,
      {
        ragModuleKey: input.rag.ragModuleKey,
        fileName: input.url,
        content: input.bodyMarkdown,
        contentType: 'text/markdown',
        metadata: {
          source: 'crawler',
          sourceUrl: input.url,
          crawlerKey: input.crawlerKey,
          jobId: input.jobId,
          depth: input.depth,
          title: input.title,
        },
        createdBy: input.createdBy,
      },
    );
    return {
      ragStatus: doc.status === 'indexed' ? 'indexed' : 'failed',
      ragDocumentId: typeof doc._id === 'string' ? doc._id : String(doc._id),
    };
  } catch (err) {
    log.warn('RAG ingest failed for crawled page', {
      url: input.url,
      ragModuleKey: input.rag.ragModuleKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ragStatus: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
