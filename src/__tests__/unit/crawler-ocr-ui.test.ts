// @vitest-environment jsdom
/**
 * The crawler page’s Content extraction card in a DOM, against a mocked `fetch`: it shows the stored OCR option and
 * saving the HTTP settings sends it back (the update replaces `markdownOptions`, so an option the form left out was
 * wiped the first time anyone saved), and turning OCR on or off changes what is sent.
 */

import { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import CrawlerDetailPage from '@/app/dashboard/crawler/[crawlerId]/page';
import { buttonByText, click, installApiMock, installDomStubs, jsonResponse, mount, qa, text, wait, type ApiMock, type Mounted } from '../helpers/iamCenterUi';
import { until } from '../helpers/filesUploadDetailHarness';

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));
const nav = vi.hoisted(() => ({ params: { crawlerId: 'docs-site' }, router: { push: () => undefined } }));
vi.mock('next/navigation', () => ({ useParams: () => nav.params, useRouter: () => nav.router }));

let mounted: Mounted | null = null;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function crawler(markdownOptions?: Record<string, unknown>) {
  return {
    key: 'docs-site',
    name: 'Docs site',
    status: 'active',
    engine: 'auto',
    maxDepth: 1,
    maxPages: 10,
    autoCrawl: false,
    scope: { sameDomainOnly: true, includeSubdomains: false },
    http: { timeoutMs: 15000, maxConcurrency: 2 },
    urls: [],
    ...(markdownOptions ? { markdownOptions } : {}),
  };
}

async function open(markdownOptions?: Record<string, unknown>) {
  api = installApiMock([
    ['GET', '/api/crawler/crawlers/docs-site', () => ({ crawler: crawler(markdownOptions) })],
    ['GET', '/api/crawler/jobs', () => ({ jobs: [] })],
    ['GET', '/api/rag/modules', () => ({ modules: [] })],
    ['GET', '/api/models', () => ({ models: [] })],
    ['PATCH', '/api/crawler/crawlers/docs-site', () => jsonResponse({ crawler: crawler(markdownOptions) })],
  ]);
  mounted = await mount(h(CrawlerDetailPage));
  await until(() => text().includes('Docs site'), 'the page');
  const tab = qa<HTMLButtonElement>('[role="tab"], button').find((b) => b.textContent?.trim() === 'HTTP');
  await click(tab);
  await until(() => text().includes('Content extraction'), 'the HTTP tab');
  await wait(20);
}

const modeLabel = (label: string) => qa('label').find((l) => l.textContent?.trim() === label);

async function saveHttp() {
  await click(buttonByText('Save HTTP settings'));
  await until(() => api.to('PATCH', '/api/crawler/crawlers/docs-site').length === 1, 'the save');
  return api.to('PATCH', '/api/crawler/crawlers/docs-site')[0]!.body as { markdownOptions: Record<string, unknown> };
}

describe('the crawler’s Content extraction card', () => {
  it('offers the OCR fields in English, off for a crawler that has none', async () => {
    await open();
    expect(text()).toContain('Read scanned pages (OCR)');
    expect(text()).not.toContain('Maximum pages per document');
    expect((await saveHttp()).markdownOptions).not.toHaveProperty('ocr');
  });

  it('keeps the stored OCR option when the HTTP settings are saved (it used to be wiped)', async () => {
    const stored = { enabled: true, mode: 'always', modelKey: 'doc-ocr', languages: ['tr', 'en'], maxPages: 40, images: true };
    await open({ ocr: stored });
    expect(text()).toContain('Maximum pages per document');
    expect(text()).toContain('Also read images');
    expect((await saveHttp()).markdownOptions.ocr).toEqual(stored);
  });

  it('reads an option stored before models existed as scanned pages only, and saves it with that mode', async () => {
    await open({ ocr: { enabled: true, languages: ['eng'] } });
    expect((await saveHttp()).markdownOptions.ocr).toEqual({ enabled: true, mode: 'auto', languages: ['eng'] });
  });

  it('sends the option once it is turned on', async () => {
    await open();
    await click(modeLabel('Auto (scanned pages only)'));
    expect((await saveHttp()).markdownOptions.ocr).toEqual({ enabled: true, mode: 'auto' });
  });

  it('drops the option when OCR is turned off', async () => {
    await open({ ocr: { enabled: true, mode: 'auto' } });
    await click(modeLabel('Off'));
    expect((await saveHttp()).markdownOptions).not.toHaveProperty('ocr');
  });
});
