// @vitest-environment jsdom
/**
 * The file drawer in a DOM, against a mocked `fetch`: the Preview, Markdown and Details tabs for each kind of
 * file, the conversion states and Retry, the details of a file (checksum, uploader, origin, session), the API
 * snippets, Download / Copy key / Delete…, the loading and failure states, and what someone who can only read
 * sees. (The rules alone are in files-detail-model.test.ts.)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, createElement as h, useState } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileDetailDrawer, type FileDetailDrawerProps } from '@/components/files/detail/FileDetailDrawer';
import { PREVIEW_MAX_BYTES, formatBytes } from '@/components/files/shared';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  wait,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import { bucketView, fileRecord, isoAgo, newQueryClient, until } from '../helpers/filesUploadDetailHarness';

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));

let mounted: Mounted | null = null;
let api: ApiMock;
let client: QueryClient;
let setKey: (key: string | null) => void = () => {};
const onClose = vi.fn();
const onChanged = vi.fn();
const onDeleted = vi.fn();
const writeText = vi.fn(async () => {});
const created = vi.fn<(blob: Blob) => string>(() => 'blob:mock-1');
const revoked = vi.fn();
const anchorClicks: Array<{ download: string; href: string }> = [];

beforeAll(() => {
  installDomStubs();
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
});
beforeEach(() => {
  onClose.mockReset();
  onChanged.mockReset();
  onDeleted.mockReset();
  notify.show.mockReset();
  writeText.mockClear();
  created.mockClear();
  revoked.mockClear();
  anchorClicks.length = 0;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  URL.createObjectURL = created as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revoked as unknown as typeof URL.revokeObjectURL;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    anchorClicks.push({ download: this.download, href: this.href });
  });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const KB = 1024;
const OBJECTS = /^\/api\/files\/buckets\/docs\/objects\//;
const plain = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

interface Scenario {
  record?: Record<string, unknown>;
  /** A function is asked again on every read of the record (a conversion that moves on). */
  records?: () => Record<string, unknown>;
  level?: 'read' | 'write';
  originalText?: string;
  markdownText?: string;
  /** Overrides the answer of the record read. */
  recordAnswer?: () => Response | Promise<Response>;
  previewAnswer?: () => Response | Promise<Response>;
  convertAnswer?: () => Response | Promise<Response>;
  deleteAnswer?: () => Response | Promise<Response>;
  downloadAnswer?: () => Response | Promise<Response>;
}

function install(scenario: Scenario) {
  const current = () => fileRecord(scenario.records ? scenario.records() : scenario.record);
  api = installApiMock([
    ['GET', '/api/auth/session', () => ({ effectivePermissions: { files: scenario.level ?? 'write' } })],
    [
      'GET',
      OBJECTS,
      (call) => {
        if (call.query.preview === '1') {
          if (scenario.previewAnswer) return scenario.previewAnswer();
          if (call.query.variant === 'markdown') return plain(scenario.markdownText ?? '# Heading\n\nBody');
          const contentType = String(current().contentType ?? '');
          if (contentType === 'application/pdf') {
            return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'Content-Type': 'text/html' } });
          }
          return plain(scenario.originalText ?? 'hello');
        }
        if (call.query.download) {
          return (
            scenario.downloadAnswer?.() ??
            new Response('bytes', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="served-name.bin"' } })
          );
        }
        return scenario.recordAnswer ? scenario.recordAnswer() : { record: current() };
      },
    ],
    ['POST', '/api/files/buckets/docs/convert', () => scenario.convertAnswer?.() ?? jsonResponse({ record: fileRecord({ ...scenario.record, markdownStatus: 'pending', markdownError: undefined }) }, 202)],
    ['DELETE', OBJECTS, () => scenario.deleteAnswer?.() ?? jsonResponse({ success: true })],
  ]);
}

function Host({ initial, props }: { initial: string | null; props: Partial<FileDetailDrawerProps> }) {
  const [key, set] = useState<string | null>(initial);
  setKey = set;
  return h(FileDetailDrawer, { bucket: bucketView(), fileKey: key, onClose, onChanged, onDeleted, ...props });
}

async function open(
  scenario: Scenario,
  options: { key?: string | null; locale?: 'en' | 'tr'; props?: Partial<FileDetailDrawerProps>; settle?: 'content' | 'drawer' } = {},
) {
  install(scenario);
  client = newQueryClient();
  const key = options.key === undefined ? String(fileRecord(scenario.record).key) : options.key;
  mounted = await mount(h(QueryClientProvider, { client }, h(Host, { initial: key, props: options.props ?? {} })), options.locale ?? 'en');
  if (key === null) return;
  if (options.settle === 'drawer') await until(() => Boolean(drawer()), 'the drawer');
  else await until(() => Boolean(q('[role="tabpanel"]')) || Boolean(q('[role="alert"]')), 'the drawer content');
}

const drawer = () => q('.mantine-Drawer-content');
const drawerText = () => drawer()?.textContent ?? '';

async function tab(name: string) {
  const button = qa<HTMLButtonElement>('[role="tab"]').find((candidate) => candidate.textContent?.trim() === name);
  if (!button) throw new Error(`no tab: ${name}`);
  await click(button);
}

const activeTab = () => qa<HTMLButtonElement>('[role="tab"]').find((candidate) => candidate.getAttribute('aria-selected') === 'true')?.textContent?.trim();
const panel = () => q('[role="tabpanel"]')!;
const dialogs = () => qa('[role="dialog"]').filter((dialog) => !dialog.classList.contains('mantine-Drawer-content'));

async function press(key: string) {
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

/* ── Layout ───────────────────────────────────────────────────────────────── */

describe('the drawer body', () => {
  it('keeps air between the header rule and the facts under the name, which the library would take away after a header', async () => {
    await open({ record: { contentType: 'text/plain' } });
    const body = q('.mantine-Drawer-body')!;
    expect(body).not.toBeNull();
    // Beside the library's own classes (`mantine-Drawer-body`, `m_…`) the body carries one of the module's.
    const own = Array.from(body.classList).filter((name) => /body/i.test(name) && !name.startsWith('mantine-') && !name.startsWith('m_'));
    expect(own).toHaveLength(1);
    // The header comes first, so the library's "no top padding on a body that follows a header" rule applies; the
    // module's rule is the more specific one.
    expect(body.previousElementSibling?.classList.contains('mantine-Drawer-header')).toBe(true);
    const css = readFileSync(join(process.cwd(), 'src/components/files/detail/FileDetailDrawer.module.css'), 'utf8');
    expect(css).toMatch(/\.body:not\(:only-child\) \{\s*padding-top: 16px;/);
  });
});

/* ── Preview ──────────────────────────────────────────────────────────────── */

describe('Preview tab', () => {
  it('opens on the preview, titled with the file, and draws a PDF from a blob of this page typed as a PDF', async () => {
    await open({ record: { contentType: 'application/pdf' } });
    expect(activeTab()).toBe('Preview');
    expect(q('.mantine-Drawer-title')!.textContent).toBe('Q3 report.pdf');

    await until(() => Boolean(panel().querySelector('iframe')), 'the PDF frame');
    const frame = panel().querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('blob:mock-1');
    expect(frame.getAttribute('title')).toBe('Preview of Q3 report.pdf');
    // Whatever the server's header said (text/html here), the blob is a PDF and nothing else.
    const blob = created.mock.calls[0]![0];
    expect(blob.type).toBe('application/pdf');
    expect(api.calls.some((call) => call.method === 'GET' && OBJECTS.test(call.path) && call.query.preview === '1')).toBe(true);

    await mounted!.unmount();
    mounted = null;
    expect(revoked).toHaveBeenCalledWith('blob:mock-1');
  });

  it('says so when the PDF cannot be loaded', async () => {
    await open({
      record: { contentType: 'application/pdf' },
      previewAnswer: () => jsonResponse({ error: 'nope', code: 'preview_unsupported' }, 415),
    });
    await until(() => panel().textContent!.includes('No preview is available for this file type.'), 'the failure');
    expect(panel().querySelector('iframe')).toBeNull();
  });

  it('shows an image through its preview address', async () => {
    await open({ record: { key: 'photos/cat.png', name: 'cat.png', contentType: 'image/png', size: 5 * KB } });
    const image = panel().querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/api/files/buckets/docs/objects/photos/cat.png?preview=1');
    expect(image.getAttribute('alt')).toBe('cat.png');
    await act(async () => {
      image.dispatchEvent(new Event('error'));
    });
    expect(panel().querySelector('img')).toBeNull();
    expect(panel().textContent).toContain('The preview could not be loaded.');
  });

  it('shows the text of a text file exactly as it is, never as markup', async () => {
    const body = '# Title\n<script>alert(1)</script>\n<b>bold</b>';
    await open({ record: { key: 'notes.md', name: 'notes.md', contentType: 'text/markdown', size: 40 }, originalText: body });
    await until(() => Boolean(panel().querySelector('pre')), 'the text');
    const block = panel().querySelector('pre')!;
    expect(block.textContent).toBe(body);
    expect(block.querySelector('script, b, h1')).toBeNull();
    expect(block.getAttribute('aria-label')).toBe('Text of notes.md');
    expect(block.getAttribute('role')).toBe('region');
    expect(block.tabIndex).toBe(0);
  });

  it('cuts a very long text and says how much is shown', async () => {
    await open({ record: { key: 'big.txt', name: 'big.txt', contentType: 'text/plain', size: 250_000 }, originalText: 'a'.repeat(250_000) });
    await until(() => Boolean(panel().querySelector('pre')), 'the text');
    expect(panel().querySelector('pre')!.textContent).toHaveLength(200_000);
    expect(panel().textContent).toContain('Showing the first 200,000 of 250,000 characters.');
  });

  it('says an empty text file is empty', async () => {
    await open({ record: { key: 'empty.txt', name: 'empty.txt', contentType: 'text/plain', size: 0 }, originalText: '' });
    await until(() => panel().textContent!.includes('This file is empty.'), 'the empty note');
  });

  it('has no preview for a type that has none, or for a file over the preview limit', async () => {
    await open({ record: { key: 'a.docx', name: 'a.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } });
    expect(panel().textContent).toContain('No preview for this type');
    expect(panel().textContent).toContain('Download the file to open it.');
    await mounted!.unmount();

    await open({ record: { contentType: 'application/pdf', size: PREVIEW_MAX_BYTES + 1 } });
    expect(panel().textContent).toContain('No preview for this type');
    expect(panel().textContent).toContain(`larger than ${formatBytes(PREVIEW_MAX_BYTES)}`);
    expect(api.calls.some((call) => call.query.preview === '1')).toBe(false);
  });
});

/* ── Markdown ─────────────────────────────────────────────────────────────── */

describe('Markdown tab', () => {
  const ready = { markdownStatus: 'succeeded', markdownKey: 'q3.md', markdownSize: 12 * KB };

  it('shows a finished conversion: its size and its text, as plain text', async () => {
    await open({ record: ready, markdownText: '# Heading\n\n<i>raw</i>' });
    await tab('Markdown');
    await until(() => Boolean(panel().querySelector('pre')), 'the Markdown');
    expect(panel().textContent).toContain('Ready');
    expect(panel().textContent).toContain(`Markdown copy · ${formatBytes(12 * KB)}`);
    const block = panel().querySelector('pre')!;
    expect(block.textContent).toBe('# Heading\n\n<i>raw</i>');
    expect(block.querySelector('h1, i')).toBeNull();
    expect(block.getAttribute('aria-label')).toBe('Markdown of Q3 report.pdf');
    expect(api.calls.some((call) => call.query.variant === 'markdown' && call.query.preview === '1')).toBe(true);
    expect(qa('button').some((button) => button.getAttribute('aria-label') === 'Copy Markdown')).toBe(true);
  });

  it('does not read a Markdown copy that is over the preview limit', async () => {
    await open({ record: { ...ready, markdownSize: PREVIEW_MAX_BYTES + 1 } });
    await tab('Markdown');
    expect(panel().textContent).toContain(`larger than ${formatBytes(PREVIEW_MAX_BYTES)}`);
    expect(api.calls.some((call) => call.query.variant === 'markdown')).toBe(false);
  });

  it('follows a conversion that is running, and tells the host when it ends', async () => {
    let status = 'pending';
    await open({
      records: () => (status === 'pending' ? { markdownStatus: 'pending', updatedAt: isoAgo(30_000) } : { ...ready }),
      markdownText: 'done text',
    });
    await tab('Markdown');
    expect(panel().textContent).toContain('Converting…');
    expect(panel().textContent).toContain('This page updates by itself');
    expect(buttonByText('Retry conversion')).toBeUndefined();
    expect(onChanged).not.toHaveBeenCalled();

    status = 'succeeded';
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['files'] });
    });
    await until(() => panel().textContent!.includes('done text'), 'the finished copy');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  describe('a conversion that has been pending for so long that its job was probably lost', () => {
    it('says so, and starts it anew on Convert again', async () => {
      let state: Record<string, unknown> = { markdownStatus: 'pending', updatedAt: isoAgo(10 * 60_000) };
      await open({
        records: () => state,
        convertAnswer: () => {
          state = { markdownStatus: 'pending', updatedAt: isoAgo(0) };
          return jsonResponse({ record: fileRecord(state) }, 202);
        },
      });
      await tab('Markdown');
      expect(panel().textContent).toContain('Converting…');
      expect(panel().textContent).toContain('This conversion has not finished for a while.');
      expect(panel().textContent).not.toContain('This page updates by itself');
      expect(buttonByText('Retry conversion')).toBeUndefined();

      await click(buttonByText('Convert again'));
      const posts = api.to('POST', '/api/files/buckets/docs/convert');
      await until(() => api.to('POST', '/api/files/buckets/docs/convert').length === 1, 'the request');
      expect(posts[0]!.body).toEqual({ key: fileRecord().key });
      expect(onChanged).toHaveBeenCalledTimes(1);
      // The new run is as fresh as a conversion can be: the page waits for it again.
      await until(() => panel().textContent!.includes('This page updates by itself'), 'the waiting state');
      expect(buttonByText('Convert again')).toBeUndefined();
    });

    it('does not say so before the time has come', async () => {
      await open({ record: { markdownStatus: 'pending', updatedAt: isoAgo(2 * 60_000) } });
      await tab('Markdown');
      expect(panel().textContent).toContain('This page updates by itself');
      expect(panel().textContent).not.toContain('has not finished for a while');
      expect(buttonByText('Convert again')).toBeUndefined();
    });

    it('does not say so to someone who can only read, who has no button for it', async () => {
      await open({ record: { markdownStatus: 'pending', updatedAt: isoAgo(10 * 60_000) }, level: 'read' });
      await until(() => drawerText().includes('read-only access'), 'the read-only note');
      await tab('Markdown');
      expect(panel().textContent).toContain('This conversion has not finished for a while.');
      expect(buttonByText('Convert again')).toBeUndefined();
      expect(panel().textContent).toContain('read-only access');
    });

    it('goes by the time the file was created when it was never updated', async () => {
      await open({ record: { markdownStatus: 'pending', updatedAt: undefined, createdAt: isoAgo(10 * 60_000) } });
      await tab('Markdown');
      expect(panel().textContent).toContain('This conversion has not finished for a while.');
      expect(buttonByText('Convert again')).toBeTruthy();
    });

    it('speaks Turkish', async () => {
      await open({ record: { markdownStatus: 'pending', updatedAt: isoAgo(10 * 60_000) } }, { locale: 'tr' });
      await tab('Markdown');
      expect(buttonByText('Yeniden dönüştür')).toBeTruthy();
    });
  });

  describe('a Markdown copy that is there while the last conversion says otherwise', () => {
    const copy = { markdownKey: 'q3.md', markdownSize: 3 * KB };

    it('keeps showing the earlier copy while a new conversion runs', async () => {
      await open({ record: { ...copy, markdownStatus: 'pending', updatedAt: isoAgo(30_000) }, markdownText: 'earlier text' });
      await tab('Markdown');
      await until(() => Boolean(panel().querySelector('pre')), 'the earlier copy');
      expect(panel().textContent).toContain('Converting…');
      expect(panel().querySelector('pre')!.textContent).toBe('earlier text');
      expect(panel().textContent).toContain(`Markdown copy · ${formatBytes(3 * KB)}`);
    });

    it('keeps showing it after a conversion failed, says so, and offers Retry conversion', async () => {
      await open({ record: { ...copy, markdownStatus: 'failed', markdownError: 'The file is password protected.' }, markdownText: 'earlier text' });
      await tab('Markdown');
      await until(() => Boolean(panel().querySelector('pre')), 'the earlier copy');
      expect(panel().textContent).toContain('The Markdown conversion failed');
      expect(panel().textContent).toContain('The file is password protected.');
      expect(panel().textContent).toContain('The earlier Markdown copy is still here.');
      expect(panel().querySelector('pre')!.textContent).toBe('earlier text');
      expect(buttonByText('Retry conversion')).toBeTruthy();
    });

    it('keeps showing it after a conversion was skipped, with the reason, and offers Convert again', async () => {
      await open({ record: { ...copy, markdownStatus: 'skipped', markdownError: 'The file is larger than the limit for conversion.' }, markdownText: 'earlier text' });
      await tab('Markdown');
      await until(() => Boolean(panel().querySelector('pre')), 'the earlier copy');
      expect(panel().textContent).toContain('The file is larger than the limit for conversion.');
      expect(panel().textContent).toContain('The earlier Markdown copy is still here.');
      expect(buttonByText('Convert again')).toBeTruthy();
      expect(buttonByText('Convert to Markdown')).toBeUndefined();
    });

    it('offers nothing more for a copy that is current', async () => {
      await open({ record: { ...copy, markdownStatus: 'succeeded' } });
      await tab('Markdown');
      await until(() => Boolean(panel().querySelector('pre')), 'the copy');
      expect(buttonByText('Convert again')).toBeUndefined();
      expect(buttonByText('Retry conversion')).toBeUndefined();
      expect(buttonByText('Convert to Markdown')).toBeUndefined();
    });

    it('shows no copy for a record that says it succeeded but has none', async () => {
      await open({ record: { markdownStatus: 'succeeded', markdownKey: undefined } });
      await tab('Markdown');
      expect(panel().querySelector('pre')).toBeNull();
      expect(api.calls.some((call) => call.query.variant === 'markdown')).toBe(false);
      expect(buttonByText('Convert to Markdown')).toBeTruthy();
    });

    it('offers the Markdown download in the header exactly when there is a copy', async () => {
      await open({ record: { ...copy, markdownStatus: 'failed', markdownError: 'Broken.' } });
      expect(buttonByText('Download Markdown')).toBeTruthy();
      await mounted!.unmount();

      await open({ record: { markdownStatus: 'succeeded', markdownKey: undefined } });
      expect(buttonByText('Download Markdown')).toBeUndefined();
    });
  });

  describe('text recognition (OCR)', () => {
    const copy = { markdownKey: 'q3.md', markdownSize: 3 * KB, markdownStatus: 'succeeded' };
    const modeLabel = (label: string) => qa('label').find((l) => l.textContent?.trim() === label);

    it('says how many pages the last run read, and how many of the file', async () => {
      await open({ record: { ...copy, markdownExtraction: { ocr: { mode: 'auto' }, result: { sourceType: 'mixed', engine: 'local', pageCount: 5, ocrPages: 3 } } } });
      await tab('Markdown');
      expect(panel().querySelector('[role="status"]')!.textContent).toContain('OCR · 3/5 pages');
      await mounted!.unmount();

      await open({ record: { ...copy, markdownExtraction: { ocr: { mode: 'always' }, result: { sourceType: 'ocr', pageCount: 1, ocrPages: 1 } } } });
      await tab('Markdown');
      expect(panel().querySelector('[role="status"]')!.textContent).toContain('OCR · 1 page');
      await mounted!.unmount();

      await open({ record: { ...copy, markdownExtraction: { ocr: { mode: 'auto', images: true }, result: { sourceType: 'ocr', ocrImages: 2 } } } });
      await tab('Markdown');
      expect(panel().querySelector('[role="status"]')!.textContent).toContain('OCR · images');
    });

    it('shows no OCR badge for a plain conversion, or a run that found nothing to read', async () => {
      await open({ record: { ...copy } });
      await tab('Markdown');
      expect(panel().querySelector('[role="status"]')!.textContent).not.toContain('OCR');
      await mounted!.unmount();

      await open({ record: { ...copy, markdownExtraction: { ocr: { mode: 'auto' }, result: { sourceType: 'converted', pageCount: 4 } } } });
      await tab('Markdown');
      expect(panel().querySelector('[role="status"]')!.textContent).not.toContain('OCR');
    });

    it('keeps asking the server for the file’s own settings until the options are opened', async () => {
      await open({ record: { markdownStatus: 'skipped' } });
      await tab('Markdown');
      expect(panel().textContent).not.toContain('Read scanned pages (OCR)');
      await click(buttonByText('Convert to Markdown'));
      await until(() => api.to('POST', '/api/files/buckets/docs/convert').length === 1, 'the request');
      expect(api.to('POST', '/api/files/buckets/docs/convert')[0]!.body).toEqual({ key: fileRecord().key });
    });

    it('converts with the options that were opened, starting from what the file was last converted with', async () => {
      await open({ record: { markdownStatus: 'skipped', markdownExtraction: { ocr: { mode: 'auto', languages: ['de'] } } } });
      await tab('Markdown');
      await click(buttonByText('Text recognition options'));
      expect(panel().textContent).toContain('Read scanned pages (OCR)');
      // Auto is chosen already; the file’s own languages are shown.
      expect(panel().textContent).toContain('de');
      await click(modeLabel('Every page'));
      await click(buttonByText('Convert to Markdown'));
      await until(() => api.to('POST', '/api/files/buckets/docs/convert').length === 1, 'the request');
      expect(api.to('POST', '/api/files/buckets/docs/convert')[0]!.body).toEqual({ key: fileRecord().key, ocr: { mode: 'always', languages: ['de'] } });
    });

    it('sends null when the options are opened and turned off: the plain conversion', async () => {
      await open({ record: { markdownStatus: 'failed', markdownError: 'Broken.', markdownExtraction: { ocr: { mode: 'auto' } } } });
      await tab('Markdown');
      await click(buttonByText('Text recognition options'));
      await click(modeLabel('Off'));
      await click(buttonByText('Retry conversion'));
      await until(() => api.to('POST', '/api/files/buckets/docs/convert').length === 1, 'the request');
      expect(api.to('POST', '/api/files/buckets/docs/convert')[0]!.body).toEqual({ key: fileRecord().key, ocr: null });
    });

    it('offers to read a current copy again with OCR, and only to someone who may change files', async () => {
      await open({ record: { ...copy } });
      await tab('Markdown');
      expect(buttonByText('Convert again')).toBeUndefined();
      await click(buttonByText('Convert again with text recognition…'));
      await click(modeLabel('Auto (scanned pages only)'));
      await click(buttonByText('Convert again'));
      await until(() => api.to('POST', '/api/files/buckets/docs/convert').length === 1, 'the request');
      expect(api.to('POST', '/api/files/buckets/docs/convert')[0]!.body).toEqual({ key: fileRecord().key, ocr: { mode: 'auto' } });
      await mounted!.unmount();

      await open({ record: { ...copy }, level: 'read' });
      await tab('Markdown');
      expect(buttonByText('Convert again with text recognition…')).toBeUndefined();
    });
  });

  it('tells why a conversion failed and starts it again on Retry conversion', async () => {
    let state: Record<string, unknown> = { markdownStatus: 'failed', markdownError: 'The file is password protected.' };
    await open({
      records: () => state,
      convertAnswer: () => {
        state = { markdownStatus: 'pending' };
        return jsonResponse({ record: fileRecord(state) }, 202);
      },
    });
    await tab('Markdown');
    expect(panel().textContent).toContain('The Markdown conversion failed');
    expect(panel().textContent).toContain('The file is password protected.');

    await click(buttonByText('Retry conversion'));
    await until(() => panel().textContent!.includes('Converting…'), 'the new state');
    const posts = api.to('POST', '/api/files/buckets/docs/convert');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ key: fileRecord().key });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(buttonByText('Retry conversion')).toBeUndefined();
  });

  it('says so when no reason was recorded', async () => {
    await open({ record: { markdownStatus: 'failed' } });
    await tab('Markdown');
    expect(panel().textContent).toContain('No reason was recorded.');
  });

  it('tells why a conversion was skipped when there is no copy, and offers to convert it', async () => {
    const reason = 'The file is larger than the limit for Markdown conversion.';
    await open({ record: { markdownStatus: 'skipped', markdownError: reason } });
    await tab('Markdown');
    expect(panel().textContent).toContain(reason);
    // The status line carries it too, for whoever reads the page aloud.
    expect(panel().querySelector('[role="status"]')!.textContent).toContain(`Not converted: ${reason}`);
    expect(panel().textContent).toContain('This file has no Markdown copy.');
    expect(buttonByText('Convert to Markdown')).toBeTruthy();
    expect(panel().querySelector('pre')).toBeNull();
  });

  it('says nothing about a reason for a file that was never converted', async () => {
    await open({ record: { markdownStatus: 'skipped', markdownError: undefined } });
    await tab('Markdown');
    expect(panel().textContent).toContain('This file has no Markdown copy.');
    expect(panel().querySelector('[role="status"]')!.textContent).toContain('Not converted');
    expect(panel().querySelector('[role="status"]')!.textContent).not.toContain('Not converted:');
  });

  it('offers to convert a file that was never converted', async () => {
    await open({ record: { markdownStatus: 'skipped' } });
    await tab('Markdown');
    expect(panel().textContent).toContain('This file has no Markdown copy.');
    await click(buttonByText('Convert to Markdown'));
    await until(() => api.to('POST', '/api/files/buckets/docs/convert').length === 1, 'the request');
  });

  it('words a refused conversion in the language of the viewer', async () => {
    await open({
      record: { markdownStatus: 'skipped' },
      convertAnswer: () => jsonResponse({ error: 'unsupported type', code: 'conversion_unsupported' }, 415),
    });
    await tab('Markdown');
    await click(buttonByText('Convert to Markdown'));
    await until(() => Boolean(panel().querySelector('[role="alert"]')), 'the alert');
    expect(panel().querySelector('[role="alert"]')!.textContent).toBe('This file type cannot be converted to Markdown.');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('says why a conversion was refused when the file belongs to a session somebody else started', async () => {
    const sentence = 'This session was started by someone else, and you are not allowed to change it.';
    await open({ record: { markdownStatus: 'skipped' }, convertAnswer: () => jsonResponse({ error: sentence }, 403) });
    await tab('Markdown');
    await click(buttonByText('Convert to Markdown'));
    await until(() => Boolean(panel().querySelector('[role="alert"]')), 'the alert');
    expect(panel().querySelector('[role="alert"]')!.textContent).toBe(sentence);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('words a conversion the gates refused as a missing permission', async () => {
    const gate = 'Forbidden: files requires write permission';
    await open({
      record: { markdownStatus: 'skipped' },
      convertAnswer: () => jsonResponse({ error: gate, code: 'forbidden', message: gate, service: 'files', required: 'write' }, 403),
    });
    await tab('Markdown');
    await click(buttonByText('Convert to Markdown'));
    await until(() => Boolean(panel().querySelector('[role="alert"]')), 'the alert');
    expect(panel().querySelector('[role="alert"]')!.textContent).toBe('You do not have permission to do this.');
  });

  it('shows someone who can only read the state but no button to change it', async () => {
    await open({ record: { markdownStatus: 'failed', markdownError: 'Broken.' }, level: 'read' });
    await until(() => drawerText().includes('read-only access'), 'the read-only note');
    await tab('Markdown');
    expect(panel().textContent).toContain('Broken.');
    expect(buttonByText('Retry conversion')).toBeUndefined();
    expect(panel().textContent).toContain('read-only access');
  });
});

/* ── Details ──────────────────────────────────────────────────────────────── */

describe('Details tab', () => {
  const rows = () => {
    const out: Record<string, string> = {};
    const list = panel().querySelector('dl')!;
    const terms = [...list.querySelectorAll('dt')];
    for (const term of terms) out[term.textContent!] = term.nextElementSibling!.textContent!;
    return out;
  };

  it('lists the key, size, type, SHA-256, origin, uploader and times', async () => {
    const record = fileRecord({ updatedAt: isoAgo(60_000) });
    await open({ record: record as unknown as Record<string, unknown> });
    await tab('Details');
    const details = rows();
    expect(details['Name']).toBe('Q3 report.pdf');
    expect(details['Key']).toContain(record.key);
    expect(details['Size']).toBe(`${formatBytes(4_812_345)} (4,812,345 bytes)`);
    expect(details['Content type']).toBe('application/pdf');
    expect(details['Checksum (SHA-256)']).toContain(String(record.checksum));
    expect(details['Origin']).toBe('Upload');
    expect(details['Uploaded by']).toBe('Ada Lovelace');
    expect(details['Created']).toContain('2 hours ago');
    expect(details['Updated']).toContain('1 minute ago');
    expect(details['Session']).toBeUndefined();
    expect(qa('button').some((button) => button.getAttribute('aria-label') === 'Copy key of Q3 report.pdf')).toBe(true);
    expect(qa('button').some((button) => button.getAttribute('aria-label') === 'Copy checksum')).toBe(true);
  });

  it('names a checksum that is not a SHA-256 plainly, and says when there is none', async () => {
    await open({ record: { checksum: 'd41d8cd98f00b204e9800998ecf8427e' } });
    await tab('Details');
    expect(Object.keys(rows())).toContain('Checksum');
    expect(rows()['Checksum']).toContain('d41d8cd98f00b204e9800998ecf8427e');
    await mounted!.unmount();

    await open({ record: { checksum: undefined, contentType: undefined } });
    await tab('Details');
    expect(rows()['Checksum']).toBe('Not recorded');
    expect(rows()['Content type']).toBe('Not recorded');
  });

  it('says where a file came from', async () => {
    for (const [origin, label] of [
      [undefined, 'Upload'],
      ['agent_output', 'Agent output'],
      ['import', 'Imported from storage'],
    ] as const) {
      await open({ record: { origin } });
      await tab('Details');
      expect(rows()['Origin'], String(origin)).toBe(label);
      await mounted!.unmount();
    }
  });

  it('names the uploader the way the file list does: a person, a system actor, or nobody', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ createdByName: 'Ada Lovelace', createdBy: 'user-1' }, 'Ada Lovelace'],
      [{ createdByName: undefined, createdBy: 'system:cron' }, 'system:cron'],
      [{ createdByName: undefined, createdBy: '' }, 'system'],
      [{ createdByName: undefined, createdBy: '6a3f2c1e-1111-2222-3333-444455556666' }, '—'],
    ];
    for (const [record, expected] of cases) {
      await open({ record });
      await tab('Details');
      expect(rows()['Uploaded by'], JSON.stringify(record)).toBe(expected);
      await mounted!.unmount();
    }
  });

  it('keeps the session semantics of a session file: link, expiry and the uploader', async () => {
    const soon = new Date(Date.now() + 6 * 24 * 3_600_000).toISOString();
    await open({
      record: {
        purpose: 'conversation',
        agentKey: 'support',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        uploadedBy: 'user-2',
        uploadedByName: 'Grace Hopper',
        expiresAt: soon,
      },
    });
    await tab('Details');
    const details = rows();
    expect(details['Session']).toContain('Session file');
    expect(details['Session']).toContain('Open session');
    expect(details['Session']).toContain('support · conv-1');
    const link = panel().querySelector<HTMLAnchorElement>('a[href^="/dashboard/agents/"]')!;
    expect(link.getAttribute('href')).toBe('/dashboard/agents/agent-1/sessions/conv-1');
    expect(details['Expires']).toContain('in 6 days');
    expect(details['Expires']).toContain('Removed automatically');
    expect(details['Uploaded by']).toBe('Grace Hopper');
  });

  it('shows an expired and a never-expiring session file, and a session whose agent is gone', async () => {
    await open({ record: { purpose: 'conversation', agentKey: 'support', agentId: 'agent-1', conversationId: 'conv-1', expiresAt: isoAgo(3_600_000 * 30) } });
    await tab('Details');
    expect(rows()['Expires']).toContain('Expired · ');
    await mounted!.unmount();

    await open({ record: { purpose: 'conversation', agentKey: 'support', agentId: undefined, conversationId: 'conv-9', expiresAt: null } });
    await tab('Details');
    expect(rows()['Expires']).toContain('Does not expire');
    expect(rows()['Session']).toContain('support · conv-9');
    expect(panel().querySelector('a[href^="/dashboard/agents/"]')).toBeNull();
  });

  it('prints the calls of the client API for this file, each with a copy button', async () => {
    const record = fileRecord({ markdownStatus: 'succeeded', markdownKey: 'q3.md', markdownSize: 10 });
    await open({ record: record as unknown as Record<string, unknown> });
    await tab('Details');
    const snippets = qa('pre code', panel()).map((code) => code.textContent!);
    expect(snippets).toHaveLength(3);
    const encoded = encodeURIComponent(String(record.key));
    const origin = window.location.origin;
    expect(snippets[0]).toBe(
      `curl -H "Authorization: Bearer YOUR_API_TOKEN" \\\n  "${origin}/api/client/v1/files/buckets/docs/objects/${encoded}/download" \\\n  -o downloaded-file`,
    );
    expect(snippets[1]).toContain(`/objects/${encoded}/download?variant=markdown"`);
    expect(snippets[2]).toBe(`curl -X DELETE -H "Authorization: Bearer YOUR_API_TOKEN" \\\n  "${origin}/api/client/v1/files/buckets/docs/objects/${encoded}"`);

    const copy = qa('button').find((button) => button.getAttribute('aria-label') === 'Copy the snippet: Download the file')!;
    await click(copy);
    expect(writeText).toHaveBeenCalledWith(snippets[0]);
  });

  it('has no Markdown snippet before there is a Markdown copy, and keeps a hostile key out of the shell', async () => {
    const hostile = `a'b"c$(touch x)\`!;rm -rf.txt`;
    await open({ record: { key: hostile, name: 'plain.txt' } });
    await tab('Details');
    const snippets = qa('pre code', panel()).map((code) => code.textContent!);
    expect(snippets).toHaveLength(2);
    for (const snippet of snippets) {
      const url = /"(http[^"]+)"/.exec(snippet)![1]!;
      expect(url).toMatch(/^[A-Za-z0-9\-._~:/?&=%@+,;#]+$/);
      expect(snippet.split('\n').length).toBeLessThanOrEqual(3);
      expect(snippet).not.toContain('plain.txt');
    }
  });
});

/* ── Actions ──────────────────────────────────────────────────────────────── */

describe('actions', () => {
  it('describes the file in the header: name, type, size, folder and age', async () => {
    await open({});
    const header = drawerText();
    expect(q('.mantine-Drawer-title')!.textContent).toBe('Q3 report.pdf');
    expect(header).toContain('PDF');
    expect(header).toContain(formatBytes(4_812_345));
    expect(header).toContain('reports/2026');
    expect(header).toContain('Added 2 hours ago');
  });

  it('downloads the original under the name the server gave it', async () => {
    await open({});
    await click(buttonByText('Download'));
    await until(() => anchorClicks.length === 1, 'the saved file');
    const call = api.calls.find((candidate) => candidate.query.download === 'original')!;
    expect(call.query).toEqual({ download: 'original', variant: 'original' });
    expect(anchorClicks[0]!.download).toBe('served-name.bin');
  });

  it('offers the Markdown download only when there is a copy, and asks for that variant', async () => {
    await open({ record: { markdownStatus: 'skipped' } });
    expect(buttonByText('Download Markdown')).toBeUndefined();
    await mounted!.unmount();

    await open({ record: { markdownStatus: 'succeeded', markdownKey: 'q3.md', markdownSize: 10 } });
    await click(buttonByText('Download Markdown'));
    await until(() => anchorClicks.length === 1, 'the saved file');
    expect(api.calls.some((candidate) => candidate.query.download === 'markdown' && candidate.query.variant === 'markdown')).toBe(true);
  });

  it('says what went wrong with a download, and lets it be dismissed', async () => {
    await open({ downloadAnswer: () => jsonResponse({ error: 'The storage provider did not answer.' }, 502) });
    await click(buttonByText('Download'));
    await until(() => Boolean(drawer()!.querySelector('[role="alert"]')), 'the alert');
    expect(drawer()!.querySelector('[role="alert"]')!.textContent).toContain('The storage provider did not answer.');
    await click(drawer()!.querySelector('[role="alert"] button'));
    expect(drawer()!.querySelector('[role="alert"]')).toBeNull();
  });

  it('copies the key and says so for a moment', async () => {
    await open({});
    await click(buttonByText('Copy key'));
    expect(writeText).toHaveBeenCalledWith(fileRecord().key);
    expect(buttonByText('Key copied')).toBeTruthy();
  });

  it('closes from the close button and on Escape', async () => {
    await open({});
    await click(qa('button').find((button) => button.getAttribute('aria-label') === 'Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  describe('Delete…', () => {
    it('asks first, deletes, says so and hands the key to the host', async () => {
      await open({ record: { markdownStatus: 'succeeded', markdownKey: 'q3.md', markdownSize: 10 } });
      await click(buttonByText('Delete…'));
      await until(() => dialogs().length > 0, 'the question');
      const question = dialogs()[0]!.textContent!;
      expect(question).toContain('Delete file?');
      expect(question).toContain('You are about to delete Q3 report.pdf. This cannot be undone.');
      expect(question).toContain('Its Markdown copy is deleted with it.');
      expect(api.to('DELETE', new RegExp(OBJECTS)).length).toBe(0);

      await click(buttonByText('Delete', dialogs()[0]!));
      await until(() => onDeleted.mock.calls.length === 1, 'the deletion');
      expect(onDeleted).toHaveBeenCalledWith(fileRecord().key);
      expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
      expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Q3 report.pdf has been removed' }));
    });

    it('does not mention a Markdown copy that does not exist, and does nothing when cancelled', async () => {
      await open({});
      await click(buttonByText('Delete…'));
      await until(() => dialogs().length > 0, 'the question');
      expect(dialogs()[0]!.textContent).not.toContain('Markdown copy');
      await click(buttonByText('Cancel', dialogs()[0]!));
      await wait(30);
      expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false);
      expect(onDeleted).not.toHaveBeenCalled();
    });

    it('shows a refusal inside the question, in the viewer’s language, and keeps the file', async () => {
      await open({ deleteAnswer: () => jsonResponse({ error: 'Bucket is not active.', code: 'bucket_inactive' }, 409) });
      await click(buttonByText('Delete…'));
      await until(() => dialogs().length > 0, 'the question');
      await click(buttonByText('Delete', dialogs()[0]!));
      await until(() => dialogs()[0]?.textContent?.includes('This bucket is disabled. Enable it to make changes.') ?? false, 'the refusal');
      expect(onDeleted).not.toHaveBeenCalled();
      expect(notify.show).not.toHaveBeenCalled();
    });

    it('says why a file of somebody else’s session cannot be deleted, in the server’s sentence, and keeps the file', async () => {
      const sentence = 'This session was started by someone else, and you are not allowed to change it.';
      await open({ deleteAnswer: () => jsonResponse({ error: sentence }, 403) });
      await click(buttonByText('Delete…'));
      await until(() => dialogs().length > 0, 'the question');
      await click(buttonByText('Delete', dialogs()[0]!));
      await until(() => dialogs()[0]?.textContent?.includes(sentence) ?? false, 'the refusal');
      expect(dialogs()[0]!.textContent).not.toContain('You do not have permission to do this.');
      expect(onDeleted).not.toHaveBeenCalled();
    });

    it('leaves Escape to the question: it closes the question, not the drawer', async () => {
      await open({});
      await click(buttonByText('Delete…'));
      await until(() => dialogs().length > 0, 'the question');
      await press('Escape');
      await until(() => dialogs().length === 0, 'the question closing');
      expect(onClose).not.toHaveBeenCalled();
      await press('Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});

/* ── Access ───────────────────────────────────────────────────────────────── */

describe('access', () => {
  it('hides what changes files from someone who can only read, and keeps what reads them', async () => {
    await open({ level: 'read' });
    await until(() => drawerText().includes('read-only access'), 'the read-only note');
    expect(buttonByText('Delete…')).toBeUndefined();
    expect(buttonByText('Download')).toBeTruthy();
    expect(buttonByText('Copy key')).toBeTruthy();
  });

  it('shows the write actions to someone who may write', async () => {
    await open({ level: 'write' });
    await until(() => Boolean(buttonByText('Delete…')), 'the delete button');
    expect(drawerText()).not.toContain('read-only access');
  });
});

/* ── A bucket that takes no changes ───────────────────────────────────────── */

describe('a bucket that takes no changes', () => {
  const DISABLED = 'This bucket is disabled, so its files can be viewed and downloaded but not deleted or converted. Enable the bucket to change them.';
  const DELETING = 'This bucket is being deleted, so nothing in it can be changed.';

  it('keeps the files of a disabled bucket readable and offers no way to change them, and says why', async () => {
    await open({ record: { markdownStatus: 'failed', markdownError: 'Broken.' } }, { props: { bucket: bucketView({ status: 'disabled' }) } });
    await until(() => drawerText().includes(DISABLED), 'the note');
    expect(buttonByText('Delete…')).toBeUndefined();
    expect(buttonByText('Download')).toBeTruthy();
    expect(buttonByText('Copy key')).toBeTruthy();
    // Not the note about the person's access: they may write, the bucket does not take it.
    expect(drawerText()).not.toContain('read-only access');

    await tab('Markdown');
    expect(panel().textContent).toContain('Broken.');
    expect(buttonByText('Retry conversion')).toBeUndefined();
    expect(panel().textContent).toContain(DISABLED);
    await tab('Details');
    expect(panel().textContent).toContain('Q3 report.pdf');
  });

  it('says the bucket is being deleted, not that it could be enabled', async () => {
    await open({ record: { markdownStatus: 'skipped' } }, { props: { bucket: bucketView({ status: 'disabled', deleting: true }) } });
    await until(() => drawerText().includes(DELETING), 'the note');
    expect(drawerText()).not.toContain(DISABLED);
    expect(buttonByText('Delete…')).toBeUndefined();
    await tab('Markdown');
    expect(buttonByText('Convert to Markdown')).toBeUndefined();
    expect(panel().textContent).toContain(DELETING);
  });

  it('puts the person’s access first when both apply', async () => {
    await open({ level: 'read' }, { props: { bucket: bucketView({ status: 'disabled' }) } });
    await until(() => drawerText().includes('read-only access'), 'the read-only note');
    expect(drawerText()).not.toContain(DISABLED);
  });

  it('leaves an active bucket as it was: Delete and Convert are there', async () => {
    await open({ record: { markdownStatus: 'skipped' } }, { props: { bucket: bucketView({ status: 'active' }) } });
    await until(() => Boolean(buttonByText('Delete…')), 'the delete button');
    expect(drawerText()).not.toContain(DISABLED);
    await tab('Markdown');
    expect(buttonByText('Convert to Markdown')).toBeTruthy();
  });

  it('says it in Turkish too', async () => {
    await open({ record: { markdownStatus: 'skipped' } }, { locale: 'tr', props: { bucket: bucketView({ status: 'disabled' }) } });
    await until(() => drawerText().includes('Bu bucket devre dışı'), 'the Turkish note');
    expect(buttonByText('Sil…')).toBeUndefined();
  });
});

/* ── States ───────────────────────────────────────────────────────────────── */

describe('states', () => {
  it('draws nothing, and asks for nothing, while no file is selected', async () => {
    await open({}, { key: null });
    expect(drawer()).toBeNull();
    expect(api.calls.some((call) => OBJECTS.test(call.path))).toBe(false);
  });

  it('shows a loading state titled with the file name until the record arrives', async () => {
    let release: (value: Response) => void = () => {};
    await open(
      { recordAnswer: () => new Promise<Response>((resolve) => (release = resolve)) },
      { key: 'reports/2026/slow.pdf', settle: 'drawer' },
    );
    expect(q('.mantine-Drawer-title')!.textContent).toBe('slow.pdf');
    expect(drawerText()).toContain('Loading the file…');
    expect(drawer()!.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => {
      release(jsonResponse({ record: fileRecord({ key: 'reports/2026/slow.pdf', name: 'Slow report.pdf' }) }));
    });
    await until(() => q('.mantine-Drawer-title')!.textContent === 'Slow report.pdf', 'the record');
  });

  it('says a file that is gone is gone', async () => {
    await open({ recordAnswer: () => jsonResponse({ error: 'File not found' }, 404) });
    await until(() => drawerText().includes('This file no longer exists.'), 'the message');
    expect(q('[role="tab"]')).toBeNull();
  });

  it('says why a file of somebody else’s session cannot be opened, in the server’s sentence', async () => {
    const sentence = 'This session was started by someone else, and you are not allowed to view it.';
    await open({ recordAnswer: () => jsonResponse({ error: sentence }, 403) });
    await until(() => drawerText().includes(sentence), 'the reason');
    expect(drawerText()).not.toContain('You do not have permission to do this.');
    expect(q('[role="tab"]')).toBeNull();
  });

  it('words an open the gates refused as a missing permission', async () => {
    const gate = 'Forbidden: files requires read permission';
    await open({ recordAnswer: () => jsonResponse({ error: gate, code: 'forbidden', message: gate, service: 'files', required: 'read' }, 403) });
    await until(() => drawerText().includes('You do not have permission to do this.'), 'the message');
    expect(drawerText()).not.toContain('Forbidden');
  });

  it('says why the file could not be loaded and tries again on request', async () => {
    let fail = true;
    await open({ recordAnswer: () => (fail ? jsonResponse({ error: 'The server is busy.' }, 500) : jsonResponse({ record: fileRecord() })) });
    await until(() => drawerText().includes('The server is busy.'), 'the failure');
    fail = false;
    await click(buttonByText('Try again'));
    await until(() => Boolean(q('[role="tab"]')), 'the file');
  });

  it('goes back to the Preview tab when another file is opened', async () => {
    await open({});
    await tab('Details');
    expect(activeTab()).toBe('Details');
    await act(async () => {
      setKey(fileRecord().key + '-other');
    });
    await until(() => q('.mantine-Drawer-title') !== null, 'the drawer');
    await until(() => activeTab() === 'Preview', 'the first tab');
  });
});

describe('language', () => {
  it('speaks Turkish: tabs, actions and detail labels', async () => {
    await open({ record: { markdownStatus: 'succeeded', markdownKey: 'q3.md', markdownSize: 10 } }, { locale: 'tr' });
    const labels = qa('[role="tab"]').map((candidate) => candidate.textContent?.trim());
    expect(labels).toEqual(['Önizleme', 'Markdown', 'Ayrıntılar']);
    expect(buttonByText('İndir')).toBeTruthy();
    expect(buttonByText('Markdown’ı indir')).toBeTruthy();
    expect(buttonByText('Anahtarı kopyala')).toBeTruthy();
    expect(buttonByText('Sil…')).toBeTruthy();
    expect(drawerText()).toContain('Eklendi: 2 saat önce');
    await tab('Ayrıntılar');
    const terms = qa('dt', panel()).map((term) => term.textContent);
    expect(terms).toEqual(expect.arrayContaining(['Anahtar', 'Boyut', 'İçerik türü', 'Sağlama toplamı (SHA-256)', 'Kaynak', 'Yükleyen']));
    expect(panel().textContent).toContain('(4.812.345 bayt)');
  });
});
