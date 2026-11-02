// @vitest-environment jsdom
/**
 * The Knowledge Engine module page in a DOM, against a mocked `fetch`: the OCR line in the overview, a document’s OCR
 * badge and the progress of a file that is still being read, the file picker (pictures only while the module’s OCR is
 * on), and the Re-extract row action (only for a document with a stored original).
 */

import { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import RagModulePage from '@/app/dashboard/rag/[key]/page';
import { buttonByText, click, installApiMock, installDomStubs, jsonResponse, mount, q, qa, text, wait, type ApiMock, type Mounted } from '../helpers/iamCenterUi';
import { until } from '../helpers/filesUploadDetailHarness';

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));
// Stable objects: the page lists the router among its effects' dependencies, so a fresh one per render would loop.
const nav = vi.hoisted(() => ({
  params: { key: 'kb' },
  router: { push: () => undefined, prefetch: () => undefined, replace: () => undefined },
  search: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => nav.params,
  useRouter: () => nav.router,
  usePathname: () => '/dashboard/rag/kb',
  useSearchParams: () => nav.search,
}));
vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

let mounted: Mounted | null = null;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  notify.show.mockReset();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const moduleView = (extraction?: Record<string, unknown>) => ({
  _id: 'm1',
  key: 'kb',
  name: 'Support KB',
  embeddingModelKey: 'embed',
  vectorProviderKey: 'vp',
  vectorIndexKey: 'idx',
  chunkConfig: { strategy: 'recursive_character', chunkSize: 1000, chunkOverlap: 100 },
  status: 'active',
  totalDocuments: 3,
  totalChunks: 10,
  ...(extraction ? { extraction } : {}),
});

const documents = [
  { _id: 'd1', ragModuleKey: 'kb', fileKey: 'files/scan.pdf', fileName: 'scan.pdf', status: 'indexed', chunkCount: 8, extraction: { sourceType: 'mixed', pageCount: 5, ocrPages: 3 } },
  { _id: 'd2', ragModuleKey: 'kb', fileKey: 'files/big.pdf', fileName: 'big.pdf', status: 'pending', extraction: { sourceType: 'ocr', stage: 'running', progress: { completed: 12, total: 40 } } },
  { _id: 'd3', ragModuleKey: 'kb', fileName: 'pasted.txt', status: 'indexed', chunkCount: 2 },
];

async function open(extraction?: Record<string, unknown>) {
  api = installApiMock([
    ['GET', '/api/rag/modules/kb', () => ({ module: moduleView(extraction) })],
    ['GET', '/api/rag/modules/kb/documents', () => ({ documents, total: documents.length })],
    // The usage and insight panels are not what these tests are about.
    ['GET', /^\/api\/rag\/modules\/kb\/(usage|score-distribution|queries)/, () => ({ logs: [], buckets: [], queries: [] })],
    ['POST', '/api/rag/modules/kb/documents/d1', () => jsonResponse({ document: documents[0] })],
  ]);
  mounted = await mount(h(RagModulePage));
  await until(() => text().includes('Support KB'), 'the page');
}

async function documentsTab() {
  const tab = qa<HTMLButtonElement>('[role="tab"]').find((b) => b.textContent?.includes('Documents'));
  await click(tab);
  await until(() => text().includes('scan.pdf'), 'the documents');
}

describe('the module page and OCR', () => {
  it('says in the overview whether OCR is on', async () => {
    await open();
    expect(text()).toContain('Text Extraction (OCR)');
    expect(text()).toMatch(/Text Extraction \(OCR\)\s*Off/);
    await mounted!.unmount();
    mounted = null;

    await open({ ocr: { mode: 'auto', modelKey: 'doc-ocr', languages: ['de'] } });
    expect(text()).toContain('Auto · doc-ocr · de');
  });

  it('shows how many pages were read by OCR, and where a file that is still being read stands', async () => {
    await open({ ocr: { mode: 'auto' } });
    await documentsTab();
    expect(text()).toContain('OCR · 3/5 pages');
    expect(text()).toContain('Reading the file… 12/40 pages');
    // A document read without OCR carries no badge.
    expect(text().match(/OCR · /g)).toHaveLength(1);
  });

  it('offers pictures in the file picker only while the module’s OCR is on', async () => {
    await open();
    await documentsTab();
    const off = q<HTMLInputElement>('input[type="file"]')!;
    expect(off.accept).toContain('.pdf');
    expect(off.accept).not.toContain('.tif');
    await mounted!.unmount();
    mounted = null;

    await open({ ocr: { mode: 'always' } });
    await documentsTab();
    const on = q<HTMLInputElement>('input[type="file"]')!;
    for (const type of ['.pdf', '.png', '.jpg', '.tiff', '.webp']) expect(on.accept).toContain(type);
  });

  it('re-extracts a document from its stored original, and offers it only where there is one', async () => {
    await open({ ocr: { mode: 'auto' } });
    await documentsTab();
    const triggers = qa<HTMLButtonElement>('button[aria-label="Actions"]');
    expect(triggers.length).toBe(3);

    // The pasted text has no stored original: no Re-extract.
    await click(triggers[2]);
    await until(() => qa('[role="menuitem"]').length > 0, 'the menu');
    expect(qa('[role="menuitem"]').some((item) => item.textContent?.trim() === 'Re-extract')).toBe(false);
    await click(triggers[2]);
    await wait(50);

    await click(triggers[0]);
    await until(() => qa('[role="menuitem"]').some((item) => item.textContent?.trim() === 'Re-extract'), 'the action');
    await click(qa('[role="menuitem"]').find((item) => item.textContent?.trim() === 'Re-extract'));
    await until(() => Boolean(buttonByText('Re-extract')), 'the question');
    await click(buttonByText('Re-extract'));
    await until(() => api.to('POST', '/api/rag/modules/kb/documents/d1').length === 1, 'the request');
    expect(api.to('POST', '/api/rag/modules/kb/documents/d1')[0]!.body).toEqual({ reextract: true });
  });
});
