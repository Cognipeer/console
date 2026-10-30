/**
 * Crawler ↔ RAG bridge.
 *
 * For each successful HTML page the crawler produces, we optionally pipe
 * the markdown body into the configured RAG module via `ingestDocument`.
 * Failures are recorded against the crawl result but never propagate as
 * a crawl error (one bad page should not kill the run).
 */

import { createLogger } from '@/lib/core/logger';
import { ingestDocument, reingestDocument } from '@/lib/services/rag';
import { getDatabase } from '@/lib/database';
import type { ICrawlerRagBinding } from '@/lib/database';
import { isPageOfCrawler } from '@/lib/services/rag/crawlerMark';

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

  const metadata = {
    source: 'crawler',
    sourceUrl: input.url,
    crawlerKey: input.crawlerKey,
    jobId: input.jobId,
    depth: input.depth,
    title: input.title,
  };

  try {
    // Recurring crawls revisit the same URLs on every run. Re-ingesting a
    // page we've already indexed for this module must replace its old
    // chunks/vectors rather than piling up duplicate copies alongside them.
    const db = await getDatabase();
    await db.switchToTenant(input.tenantDbName);
    let existing = await db.findRagDocumentByFileName(
      input.rag.ragModuleKey,
      input.url,
      input.projectId,
    );
    // In a knowledge base with access control a page replaces only a page this crawler sent, wherever a manager put it:
    // a document of the same name from anywhere else may sit in a folder whose readers never asked for the crawled
    // text, and the newest of that name need not be the crawler's. With none of its own, the page is a new document.
    if (existing && !isPageOfCrawler(existing.metadata, input.crawlerKey)) {
      const ragModule = await db.findRagModuleByKey(input.rag.ragModuleKey, input.projectId);
      if (ragModule?.access?.enabled === true) {
        const named = await db.listRagDocumentsByFileName(input.rag.ragModuleKey, input.url, input.projectId);
        existing = named.find((doc) => isPageOfCrawler(doc.metadata, input.crawlerKey)) ?? null;
      }
    }
    const sentByCrawler = { crawlerKey: input.crawlerKey };

    const doc = existing
      ? await reingestDocument(
          input.tenantDbName,
          input.tenantId,
          input.projectId,
          {
            ragModuleKey: input.rag.ragModuleKey,
            documentId: String(existing._id),
            content: input.bodyMarkdown,
            fileName: input.url,
            contentType: 'text/markdown',
            metadata,
            sentByCrawler,
            updatedBy: input.createdBy,
          },
        )
      : await ingestDocument(
          input.tenantDbName,
          input.tenantId,
          input.projectId,
          {
            ragModuleKey: input.rag.ragModuleKey,
            fileName: input.url,
            content: input.bodyMarkdown,
            contentType: 'text/markdown',
            metadata,
            sentByCrawler,
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
