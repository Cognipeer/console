// @vitest-environment jsdom
/**
 * The Extraction section of the Knowledge Engine module screens in a DOM, against a mocked `fetch`: it sits after
 * Chunking, shows the stored setting, and what a save sends (the setting when on, an explicit null to clear it on an
 * existing module, nothing for a module that never had one).
 */

import { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import CreateRagModuleModal from '@/components/rag/CreateRagModuleModal';
import EditRagModuleModal from '@/components/rag/EditRagModuleModal';
import { buttonByText, click, installApiMock, installDomStubs, mount, qa, text, wait, type ApiMock, type Mounted } from '../helpers/iamCenterUi';
import { until } from '../helpers/filesUploadDetailHarness';

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));

let mounted: Mounted | null = null;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const storedModule = {
  key: 'kb',
  name: 'Support KB',
  embeddingModelKey: 'embed',
  vectorProviderKey: 'vp',
  vectorIndexKey: 'idx',
  chunkConfig: { strategy: 'recursive_character' as const, chunkSize: 1000, chunkOverlap: 100 },
};

function install(patchAnswer: (body: unknown) => unknown = () => ({ module: { key: 'kb' } })) {
  api = installApiMock([
    ['GET', '/api/models', (call) => ({
      models: call.query.category === 'embedding'
        ? [{ key: 'embed', name: 'Embed' }]
        : call.query.category === 'ocr' ? [{ key: 'doc-ocr', name: 'Doc OCR' }] : [],
    })],
    ['GET', '/api/vector/providers', () => ({ providers: [{ key: 'vp', label: 'VP', status: 'active', driverCapabilities: {} }] })],
    ['GET', '/api/vector/indexes', () => ({ indexes: [{ key: 'idx', name: 'Idx', providerKey: 'vp', dimension: 8 }] })],
    ['GET', '/api/reranker', () => ({ rerankers: [] })],
    ['PATCH', '/api/rag/modules/kb', (call) => patchAnswer(call.body)],
  ]);
}

async function openEdit(module: Record<string, unknown>) {
  install();
  const onUpdated = vi.fn();
  mounted = await mount(h(EditRagModuleModal, { opened: true, onClose: vi.fn(), onUpdated, module: module as never }));
  await until(() => text().includes('Edit Knowledge Engine module'), 'the screen');
  await until(() => api.to('GET', '/api/vector/indexes').length > 0, 'the lists');
  await wait(20);
  return onUpdated;
}

const modeLabel = (label: string) => qa('label').find((l) => l.textContent?.trim() === label);

async function save() {
  await click(buttonByText('Save changes'));
  await until(() => api.to('PATCH', '/api/rag/modules/kb').length === 1, 'the save');
  return api.to('PATCH', '/api/rag/modules/kb')[0]!.body as Record<string, unknown>;
}

describe('the Extraction section', () => {
  it('sits after Chunking in the create screen and starts with OCR off', async () => {
    install();
    mounted = await mount(h(CreateRagModuleModal, { opened: true, onClose: vi.fn(), onCreated: vi.fn() }));
    await until(() => text().includes('Extraction'), 'the section');
    const page = text();
    expect(page.indexOf('Chunking')).toBeLessThan(page.indexOf('Extraction'));
    expect(page.lastIndexOf('Retrieval')).toBeGreaterThan(page.indexOf('How text is read out of uploaded files'));
    expect(page).toContain('Read scanned pages (OCR)');
    expect(page).not.toContain('Maximum pages per document');
    // The summary says so, too.
    expect(page).toMatch(/OCR\s*Off/);
  });

  it('shows the module’s stored setting in the edit screen', async () => {
    await openEdit({ ...storedModule, extraction: { ocr: { mode: 'always', maxPages: 25 } } });
    expect(text()).toContain('Read scanned pages (OCR)');
    expect(text()).toContain('Maximum pages per document');
    expect(text()).toContain('Every page · Local engine · tr, en');
    expect(text()).toContain('Applies to files uploaded from now on.');
  });

  it('saves the setting when it is on, and never changes the re-index state for it', async () => {
    await openEdit(storedModule);
    await click(modeLabel('Auto (scanned pages only)'));
    expect(text()).toContain('Auto · Local engine · tr, en');
    expect(text()).toContain('not needed');
    const body = await save();
    expect(body.extraction).toEqual({ ocr: { mode: 'auto' } });
    // Changing OCR re-reads nothing: no re-index run was started.
    expect(api.calls.some((call) => call.path.endsWith('/reindex'))).toBe(false);
  });

  it('clears a stored setting with an explicit null when it is turned off', async () => {
    await openEdit({ ...storedModule, extraction: { ocr: { mode: 'auto', modelKey: 'doc-ocr' } } });
    await click(modeLabel('Off'));
    const body = await save();
    expect(body).toHaveProperty('extraction', null);
  });

  it('sends no extraction key for a module that never had one', async () => {
    await openEdit(storedModule);
    const body = await save();
    expect(body).not.toHaveProperty('extraction');
  });
});

