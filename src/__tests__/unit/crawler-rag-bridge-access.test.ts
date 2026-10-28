/**
 * A crawled page that goes into a knowledge base with access control replaces only a page this crawler sent there,
 * wherever a manager put it. A document of the same name from anywhere else (an upload, another crawler, one whose
 * metadata only claims to be the crawler's) may sit in a folder whose readers never asked for the crawled text: the
 * page becomes a new document instead. Without access control nothing changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: {
    switchToTenant: vi.fn(),
    findRagDocumentByFileName: vi.fn(),
    listRagDocumentsByFileName: vi.fn(),
    findRagModuleByKey: vi.fn(),
  },
  ingestDocument: vi.fn(),
  reingestDocument: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: async () => hoisted.db }));
vi.mock('@/lib/services/rag', () => ({
  ingestDocument: hoisted.ingestDocument,
  reingestDocument: hoisted.reingestDocument,
}));

import { ingestCrawlPage } from '@/lib/services/crawler/crawlerRagBridge';

const URL = 'https://intranet.example/hr/benefits';

const page = (crawlerKey?: string) => ({
  tenantDbName: 'tenant_acme',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  rag: { ragModuleKey: 'wiki', enabled: true },
  crawlerKey,
  jobId: 'job-1',
  url: URL,
  title: 'Benefits',
  bodyMarkdown: '# Benefits\n\ncrawled text',
  createdBy: 'crawler-user',
  depth: 0,
});

const stored = (metadata: Record<string, unknown>, id = 'doc-1') => ({
  _id: id,
  ragModuleKey: 'wiki',
  fileName: URL,
  status: 'indexed',
  metadata,
});
/** The mark only the crawler's own ingest sets (see services/rag/crawlerMark.ts). */
const pageOf = (crawlerKey: string, id = 'doc-1') => stored({ source: 'crawler', _crawlerKey: crawlerKey }, id);

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.ingestDocument.mockResolvedValue({ _id: 'doc-new', status: 'indexed' });
  hoisted.reingestDocument.mockImplementation(async (_db: string, _t: string, _p: string, request: { documentId: string }) => ({
    _id: request.documentId,
    status: 'indexed',
  }));
  hoisted.db.listRagDocumentsByFileName.mockResolvedValue([]);
});

describe('a crawled page sent into a knowledge base with access control', () => {
  beforeEach(() => {
    hoisted.db.findRagModuleByKey.mockResolvedValue({ key: 'wiki', access: { enabled: true } });
  });

  it('becomes a new document beside one of the same address that was uploaded, marked as the crawler\'s', async () => {
    hoisted.db.findRagDocumentByFileName.mockResolvedValue(stored({ source: 'upload' }));
    expect(await ingestCrawlPage(page('site'))).toEqual({ ragStatus: 'indexed', ragDocumentId: 'doc-new' });
    expect(hoisted.reingestDocument).not.toHaveBeenCalled();
    expect(hoisted.ingestDocument).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', expect.objectContaining({
      ragModuleKey: 'wiki',
      fileName: URL,
      sentByCrawler: { crawlerKey: 'site' },
    }));
  });

  it('does not take metadata that only claims the page for the crawler: anyone who writes can put that there', async () => {
    for (const claimed of [{ source: 'crawler', crawlerKey: 'site' }, { source: 'crawler' }]) {
      hoisted.db.findRagDocumentByFileName.mockResolvedValueOnce(stored(claimed));
      await ingestCrawlPage(page('site'));
    }
    expect(hoisted.reingestDocument).not.toHaveBeenCalled();
    expect(hoisted.ingestDocument).toHaveBeenCalledTimes(2);
  });

  it('does not replace the page another crawler sent', async () => {
    hoisted.db.findRagDocumentByFileName.mockResolvedValue(pageOf('other-site'));
    await ingestCrawlPage(page('site'));
    expect(hoisted.reingestDocument).not.toHaveBeenCalled();
    expect(hoisted.ingestDocument).toHaveBeenCalledTimes(1);
  });

  it('finds its own page under a newer document of the same name, and refreshes that one', async () => {
    // Someone uploaded a document of the crawled address after the crawler's page was moved to a closed folder.
    hoisted.db.findRagDocumentByFileName.mockResolvedValue(stored({ source: 'upload' }, 'doc-upload'));
    hoisted.db.listRagDocumentsByFileName.mockResolvedValue([
      stored({ source: 'upload' }, 'doc-upload'),
      pageOf('other-site', 'doc-other'),
      pageOf('site', 'doc-own'),
    ]);
    expect(await ingestCrawlPage(page('site'))).toEqual({ ragStatus: 'indexed', ragDocumentId: 'doc-own' });
    expect(hoisted.db.listRagDocumentsByFileName).toHaveBeenCalledWith('wiki', URL, 'proj-1');
    expect(hoisted.reingestDocument).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', expect.objectContaining({
      documentId: 'doc-own',
      sentByCrawler: { crawlerKey: 'site' },
    }));
    expect(hoisted.ingestDocument).not.toHaveBeenCalled();
  });

  it('refreshes its own page in place, and asks nothing about the module for it', async () => {
    hoisted.db.findRagDocumentByFileName.mockResolvedValue(pageOf('site'));
    expect(await ingestCrawlPage(page('site'))).toEqual({ ragStatus: 'indexed', ragDocumentId: 'doc-1' });
    expect(hoisted.reingestDocument).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', expect.objectContaining({
      documentId: 'doc-1',
    }));
    expect(hoisted.db.findRagModuleByKey).not.toHaveBeenCalled();

    // An ad-hoc crawl has no key: its pages carry an empty one.
    hoisted.db.findRagDocumentByFileName.mockResolvedValue(pageOf(''));
    await ingestCrawlPage(page(undefined));
    expect(hoisted.reingestDocument).toHaveBeenCalledTimes(2);
    expect(hoisted.ingestDocument).not.toHaveBeenCalled();
  });
});

describe('a crawled page sent into a knowledge base without access control', () => {
  it('replaces the document of the same address, whoever sent it, as before', async () => {
    for (const ragModule of [{ key: 'wiki' }, { key: 'wiki', access: { enabled: false } }]) {
      hoisted.db.findRagModuleByKey.mockResolvedValueOnce(ragModule);
      hoisted.db.findRagDocumentByFileName.mockResolvedValueOnce(stored({ source: 'upload' }));
      expect(await ingestCrawlPage(page('site'))).toEqual({ ragStatus: 'indexed', ragDocumentId: 'doc-1' });
    }
    expect(hoisted.reingestDocument).toHaveBeenCalledTimes(2);
    expect(hoisted.ingestDocument).not.toHaveBeenCalled();
    expect(hoisted.db.listRagDocumentsByFileName).not.toHaveBeenCalled();
  });

  it('makes a new document when none has the address', async () => {
    hoisted.db.findRagDocumentByFileName.mockResolvedValue(null);
    expect(await ingestCrawlPage(page('site'))).toEqual({ ragStatus: 'indexed', ragDocumentId: 'doc-new' });
    expect(hoisted.db.findRagModuleByKey).not.toHaveBeenCalled();
  });
});
