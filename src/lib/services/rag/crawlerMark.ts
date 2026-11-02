/**
 * Which crawler sent a Knowledge Engine document. A crawled page replaces, in a knowledge base with access control, only
 * a page the same crawler sent there (`crawlerRagBridge`): a document of the same name from anywhere else may sit in a
 * folder whose readers never asked for the crawled text.
 *
 * The mark lives in the document's metadata under a key only the crawler's own ingest sets (`sentByCrawler` on an
 * ingest). The same key in any other caller's metadata is dropped by the ingest, so an upload never passes for a page
 * of the crawler.
 */

/** The metadata key: the crawler's key, '' for an ad-hoc crawl. */
export const RAG_CRAWLER_MARK = '_crawlerKey';

/** Set on an ingest by the crawler only: which crawler sends the document. */
export interface RagSentByCrawler {
  crawlerKey?: string;
}

/** The metadata an ingest stores: the caller's without the mark, and the mark only when the crawler sent it. */
export function metadataWithCrawlerMark(
  metadata: Record<string, unknown> | undefined,
  sentByCrawler: RagSentByCrawler | undefined,
): Record<string, unknown> | undefined {
  let own = metadata;
  if (own && Object.prototype.hasOwnProperty.call(own, RAG_CRAWLER_MARK)) {
    const { [RAG_CRAWLER_MARK]: _dropped, ...rest } = own;
    own = rest;
  }
  return sentByCrawler ? { ...own, [RAG_CRAWLER_MARK]: sentByCrawler.crawlerKey ?? '' } : own;
}

/** Whether a stored document is a page this crawler (by key; none for an ad-hoc crawl) sent. */
export function isPageOfCrawler(
  metadata: Record<string, unknown> | null | undefined,
  crawlerKey: string | undefined,
): boolean {
  const mark = metadata?.[RAG_CRAWLER_MARK];
  return typeof mark === 'string' && mark === (crawlerKey ?? '');
}
