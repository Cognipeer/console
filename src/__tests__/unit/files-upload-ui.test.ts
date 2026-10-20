// @vitest-environment jsdom
/**
 * The "Upload files" screen in a DOM, against a mocked `fetch` and a scripted `XMLHttpRequest`: the drop zone and
 * its limits hint, files flagged before anything is sent, the queue (progress, errors, retry, two at a time), the
 * destination folder with the key each file will get, the Markdown option, the summary and checklist, the
 * question on closing with uploads in flight, and what someone who can only read sees. (The rules and the
 * scheduler alone are in files-upload-model.test.ts.)
 */

import { act, createElement as h } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadFilesForm, type UploadFilesFormProps } from '@/components/files/upload/UploadFilesForm';
import { formatBytes } from '@/components/files/shared';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  mount,
  q,
  qa,
  setInput,
  text,
  wait,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import { bucketView, fileRecord, FakeXhr, limitsPayload, makeFile, newQueryClient, until } from '../helpers/filesUploadDetailHarness';

let mounted: Mounted | null = null;
let api: ApiMock;
const onClose = vi.fn();
const onUploaded = vi.fn();

beforeAll(() => installDomStubs());
beforeEach(() => {
  FakeXhr.reset();
  onClose.mockReset();
  onUploaded.mockReset();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/* ── Helpers ─────────────────────────────────────────────────────────────── */

interface OpenOptions {
  props?: Partial<UploadFilesFormProps>;
  limits?: Parameters<typeof limitsPayload>[0];
  level?: 'read' | 'write';
  locale?: 'en' | 'tr';
}

async function open(options: OpenOptions = {}) {
  api = installApiMock([
    ['GET', '/api/files/limits', () => limitsPayload(options.limits)],
    ['GET', '/api/auth/session', () => ({ effectivePermissions: { files: options.level ?? 'write' } })],
  ]);
  mounted = await mount(
    h(
      QueryClientProvider,
      { client: newQueryClient() },
      h(UploadFilesForm, { opened: true, onClose, onUploaded, bucket: bucketView(), folder: '', ...options.props }),
    ),
    options.locale ?? 'en',
  );
  // The overlay draws on its second render, and the limits arrive after that.
  await until(() => Boolean(q('input[type="file"]')), 'the form');
  await until(() => !text().includes('Checking the upload limits') && !text().includes('Yükleme sınırları kontrol'), 'the limits');
}

const fileInput = () => q<HTMLInputElement>('input[type="file"]')!;

async function pick(files: File[]) {
  const input = fileInput();
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** The name field of a row that can still be edited, found by the name of the file as it was picked. */
const rowInput = (name: string) => q<HTMLInputElement>(`input[aria-label="Name of ${name}"]`);
const rows = () => qa('ul[aria-label="Files to upload"] > li');
/** A row by the name it carries now: the field's value while it can be edited, its text once it is going out or stored. */
const rowOf = (name: string) =>
  rows().find((li) => {
    const field = li.querySelector<HTMLInputElement>('input');
    return field ? field.value === name : (li.textContent ?? '').includes(name);
  }) ?? null;
const rowText = (name: string) => rowOf(name)?.textContent ?? '';

async function clickButton(label: string | RegExp) {
  const button = buttonByText(label);
  if (!button) throw new Error(`no button: ${String(label)}`);
  await click(button);
}

async function startUploads(count: number) {
  await clickButton(count === 1 ? 'Upload 1 file' : `Upload ${count} files`);
  await until(() => FakeXhr.instances.length >= Math.min(count, 2), 'the first uploads');
}

async function answer(xhr: FakeXhr, status: number, json: unknown) {
  await act(async () => {
    xhr.respond(status, json);
  });
}

const created = (name: string) => ({ record: fileRecord({ key: `stored/${name}`, name }) });

/* ── The drop zone and the limits ─────────────────────────────────────────── */

describe('drop zone', () => {
  it('prints what the server will take, from the limits of this bucket', async () => {
    await open({
      limits: {
        maxFileBytes: 1000,
        allowedMimeTypes: ['text/*', 'application/pdf'],
        quota: { usedBytes: 1000, limitBytes: 6000, filesUsed: 0, filesLimit: null },
      },
    });
    expect(api.calls.find((call) => call.path === '/api/files/limits')?.query).toEqual({ bucketKey: 'docs' });
    const page = text();
    expect(page).toContain('Drop files here');
    expect(page).toContain(`Up to ${formatBytes(1000)} per file`);
    expect(page).toContain('up to 20 files at once');
    expect(page).toContain('allowed types: text/*, application/pdf');
    expect(page).toContain(`${formatBytes(5000)} of storage left`);
    expect(fileInput().accept).toBe('text/*,application/pdf');
    expect(fileInput().multiple).toBe(true);
  });

  it('says so when any type is allowed and when the limits could not be loaded', async () => {
    await open();
    expect(text()).toContain('any file type');
    expect(fileInput().accept).toBe('');
    await mounted!.unmount();

    api = installApiMock([['GET', '/api/files/limits', () => new Response(JSON.stringify({ error: 'no' }), { status: 500 })]]);
    mounted = await mount(
      h(QueryClientProvider, { client: newQueryClient() }, h(UploadFilesForm, { opened: true, onClose, onUploaded, bucket: bucketView(), folder: '' })),
    );
    await until(() => text().includes('The upload limits could not be loaded'), 'the failure line');
  });

  it('adds the files of a drop, leaves folders out and says so, and always cancels the drop', async () => {
    await open();
    const zone = fileInput().parentElement!;
    const dropped = makeFile('dropped.txt');
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [dropped],
        items: [
          { kind: 'file', getAsFile: () => dropped, webkitGetAsEntry: () => ({ isDirectory: false }) },
          { kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true }) },
        ],
      },
    });
    await act(async () => {
      zone.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(rowInput('dropped.txt')).not.toBeNull();
    expect(qa('li').filter((li) => li.querySelector('input[aria-label^="Name of"]'))).toHaveLength(1);
    expect(text()).toContain('Skipped folders: 1.');
  });

  it('turns a drop away without adding anything when files cannot be added, but still cancels it', async () => {
    await open({ level: 'read' });
    await until(() => text().includes('read-only access'), 'the read-only note');
    const dropped = makeFile('dropped.txt');
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [dropped], items: [] } });
    // Dragging over the zone is cancelled as well, or the browser would take the drop for itself.
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(over, 'dataTransfer', { value: { types: ['Files'], dropEffect: 'none' } });
    await act(async () => {
      fileInput().parentElement!.dispatchEvent(over);
      fileInput().parentElement!.dispatchEvent(event);
    });
    expect(over.defaultPrevented).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(rowInput('dropped.txt')).toBeNull();
  });

  it('adds picked files, ignores a file that is already in the list and stops at twenty', async () => {
    await open();
    await pick([makeFile('a.txt'), makeFile('b.txt', { lastModified: 2 })]);
    await pick([makeFile('a.txt')]);
    expect(text()).toContain('Already in the list: 1.');
    expect(qa('input[aria-label^="Name of"]')).toHaveLength(2);

    await pick(Array.from({ length: 22 }, (_, index) => makeFile(`bulk-${index}.txt`, { lastModified: 100 + index })));
    expect(qa('input[aria-label^="Name of"]')).toHaveLength(20);
    expect(text()).toContain('Not added: 4. At most 20 files can be queued at once.');
  });
});

/* ── Flagging before upload ───────────────────────────────────────────────── */

describe('files over the limit or of a type that is not allowed', () => {
  it('are flagged on their row and in the checklist, and are not sent', async () => {
    await open({ limits: { maxFileBytes: 1000, allowedMimeTypes: ['text/*', 'application/pdf'] } });
    await pick([
      makeFile('ok.txt', { size: 10 }),
      makeFile('big.txt', { size: 5000, lastModified: 2 }),
      makeFile('pic.png', { size: 10, type: 'image/png', lastModified: 3 }),
    ]);

    expect(rowText('big.txt')).toContain(`Too large (limit ${formatBytes(1000)})`);
    expect(rowText('pic.png')).toContain('Type not allowed (image/png)');
    expect(rowText('ok.txt')).toContain('Ready');
    const todo = qa('li.todo').map((li) => li.textContent);
    expect(todo).toEqual(expect.arrayContaining(['Over the size limit: 1', 'Type not allowed: 1']));
    expect(text()).toContain('1 of 3 ready');
    expect(buttonByText('Upload 1 file')).toBeTruthy();

    await startUploads(1);
    await wait(40);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(FakeXhr.instances[0]!.body).toMatchObject({ fileName: 'ok.txt' });
  });

  it('become sendable again once the name or the type is fixed', async () => {
    await open();
    await pick([makeFile('doc.txt')]);
    await setInput(rowInput('doc.txt')!, 'a/b.txt');
    expect(rowText('a/b.txt')).toContain('The name cannot contain “/”');
    expect(buttonByText('Upload')?.hasAttribute('disabled')).toBe(true);

    await setInput(rowInput('doc.txt')!, '   ');
    expect(rowText('   ')).toContain('Enter a file name');
    await setInput(rowInput('doc.txt')!, 'doc.txt');
    expect(rowText('doc.txt')).toContain('Ready');
    expect(buttonByText('Upload 1 file')?.hasAttribute('disabled')).toBe(false);
  });

  it('lets a single file carry its own content type, and flags one that is not a type', async () => {
    await open();
    await pick([makeFile('data.bin', { type: '' })]);
    const field = qa<HTMLInputElement>('input').find((input) => input.placeholder === 'application/octet-stream');
    expect(field).toBeTruthy();
    await setInput(field!, 'nope');
    expect(text()).toContain('Not a valid content type');
    await setInput(field!, 'application/x-custom');
    await startUploads(1);
    expect(FakeXhr.instances[0]!.body).toMatchObject({ contentType: 'application/x-custom' });
  });
});

/* ── Sending ──────────────────────────────────────────────────────────────── */

describe('sending', () => {
  it('sends two files at a time, shows progress, and reports the stored records once', async () => {
    await open();
    await pick(Array.from({ length: 5 }, (_, index) => makeFile(`f${index}.txt`, { lastModified: index + 1 })));
    await startUploads(5);
    await wait(40);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(text()).toContain('Waiting…');
    expect(buttonByText('Uploading…')?.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      FakeXhr.instances[0]!.progress(50, 100);
    });
    expect(rowText('f0.txt')).toContain('Uploading · 50%');
    await act(async () => {
      FakeXhr.instances[0]!.progress(100, 100);
    });
    expect(rowText('f0.txt')).toContain('Saving…');

    await answer(FakeXhr.instances[0]!, 201, created('f0.txt'));
    await until(() => FakeXhr.instances.length === 3, 'the third upload');
    await wait(30);
    expect(FakeXhr.instances).toHaveLength(3);
    expect(rowText('f0.txt')).toContain('Uploaded');
    expect(rowText('f0.txt')).toContain('Stored as stored/f0.txt');

    await answer(FakeXhr.instances[1]!, 201, created('f1.txt'));
    await until(() => FakeXhr.instances.length === 4, 'the fourth upload');
    await answer(FakeXhr.instances[2]!, 201, created('f2.txt'));
    await until(() => FakeXhr.instances.length === 5, 'the fifth upload');
    await answer(FakeXhr.instances[3]!, 201, created('f3.txt'));
    await answer(FakeXhr.instances[4]!, 201, created('f4.txt'));

    await until(() => onUploaded.mock.calls.length === 1, 'the report');
    expect(onUploaded.mock.calls[0]![0].map((record: { name: string }) => record.name).sort()).toEqual(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
    expect(text()).toContain('5 of 5 uploaded');
    expect(buttonByText('Done')).toBeTruthy();
    expect(buttonByText('Close')).toBeTruthy();
    // The bucket's content and the quota are read again once the run is over.
    await until(() => api.to('GET', '/api/files/limits').length >= 2, 'the limits read again');
  });

  it('sends the name, folder, content type and Markdown choice of each file as the form shows them', async () => {
    await open({ props: { folder: 'reports/' } });
    await pick([makeFile('a.txt', { type: 'text/plain' }), makeFile('b.bin', { type: '', lastModified: 2 })]);
    await setInput(rowInput('a.txt')!, '  Renamed A.txt ');
    await startUploads(2);

    const bodies = FakeXhr.instances.map((xhr) => xhr.body!);
    expect(bodies[0]).toMatchObject({ fileName: 'Renamed A.txt', contentType: 'text/plain', folder: 'reports/', convertToMarkdown: true });
    expect(bodies[1]).toMatchObject({ fileName: 'b.bin', contentType: 'application/octet-stream' });
    expect(String(bodies[0]!.data)).toMatch(/^data:.*;base64,/);
    expect(FakeXhr.instances[0]!.method).toBe('POST');
    expect(FakeXhr.instances[0]!.url).toBe('/api/files/buckets/docs/objects');
  });

  it('turns Markdown conversion off for the run when the switch is turned off', async () => {
    await open();
    const row = qa('label.form-toggle-row').find((label) => label.textContent?.includes('Convert to Markdown'))!;
    expect(row.textContent).toContain('runs in the background');
    const toggle = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(true);
    expect(text()).toContain('Markdown copy');
    await click(toggle);
    expect(toggle.checked).toBe(false);

    await pick([makeFile('a.txt')]);
    await startUploads(1);
    expect(FakeXhr.instances[0]!.body).toMatchObject({ convertToMarkdown: false });
  });

  it('submits when Enter sends the form', async () => {
    await open();
    await pick([makeFile('a.txt')]);
    const form = q<HTMLFormElement>('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await until(() => FakeXhr.instances.length === 1, 'the upload');
  });

  it.each([
    [413, { error: 'File exceeds the limit.', code: 'file_too_large' }, `Failed: Too large (limit ${formatBytes(1_000_000)})`],
    [415, { error: 'Content type "text/plain" is not in the allowlist.', code: 'content_type_not_allowed' }, 'Failed: Content type "text/plain" is not in the allowlist.'],
    [409, { error: 'Bucket is not active.', code: 'bucket_inactive' }, 'Failed: This bucket is disabled. Enable it to make changes.'],
    [429, { error: 'Storage quota exceeded: 10 MB of 10 MB used.' }, 'Failed: Storage quota exceeded: 10 MB of 10 MB used.'],
    [502, { error: 'The storage provider did not answer.' }, 'Failed: The storage provider did not answer.'],
  ])('shows a %s on the row of the file that got it', async (status, body, expected) => {
    await open();
    await pick([makeFile('a.txt')]);
    await startUploads(1);
    await answer(FakeXhr.instances[0]!, status, body);
    await until(() => rowText('a.txt').includes('Failed'), 'the failure');
    expect(rowText('a.txt')).toContain(expected);
    expect(onUploaded).not.toHaveBeenCalled();
    expect(qa('button').some((button) => button.getAttribute('aria-label') === 'Retry uploading a.txt')).toBe(true);
  });

  it('keeps the other files going when one fails, and sends the failed one again on Retry', async () => {
    await open();
    await pick([makeFile('a.txt'), makeFile('b.txt', { lastModified: 2 })]);
    await startUploads(2);
    await answer(FakeXhr.instances[0]!, 502, { error: 'The storage provider did not answer.' });
    await answer(FakeXhr.instances[1]!, 201, created('b.txt'));
    await until(() => onUploaded.mock.calls.length === 1, 'the first report');
    expect(onUploaded.mock.calls[0]![0]).toHaveLength(1);
    expect(rowText('a.txt')).toContain('Failed');
    expect(rowText('b.txt')).toContain('Uploaded');
    expect(text()).toContain('1 of 2 uploaded');

    // The name may be changed before the retry.
    await setInput(rowInput('a.txt')!, 'a-again.txt');
    await click(qa('button').find((button) => button.getAttribute('aria-label') === 'Retry uploading a-again.txt'));
    await until(() => FakeXhr.instances.length === 3, 'the retry');
    expect(FakeXhr.instances[2]!.body).toMatchObject({ fileName: 'a-again.txt' });
    await answer(FakeXhr.instances[2]!, 201, created('a-again.txt'));
    await until(() => onUploaded.mock.calls.length === 2, 'the second report');
    expect(onUploaded.mock.calls[1]![0]).toHaveLength(1);
    expect(text()).toContain('2 of 2 uploaded');
  });

  it('takes a file off the list, and cancels it when it is on its way', async () => {
    await open();
    await pick([makeFile('a.txt'), makeFile('b.txt', { lastModified: 2 })]);
    await click(qa('button').find((button) => button.getAttribute('aria-label') === 'Remove b.txt'));
    expect(rowInput('b.txt')).toBeNull();

    await startUploads(1);
    await click(qa('button').find((button) => button.getAttribute('aria-label') === 'Remove a.txt'));
    expect(FakeXhr.instances[0]!.aborted).toBe(true);
    expect(rowInput('a.txt')).toBeNull();
    expect(onUploaded).not.toHaveBeenCalled();
  });
});

/* ── The destination ──────────────────────────────────────────────────────── */

describe('destination', () => {
  it('shows bucket › folder, and the key each file will be stored under as the folder and the name change', async () => {
    await open({ props: { folder: 'reports/' } });
    await pick([makeFile('Şirket Raporu Q3.pdf', { type: 'application/pdf' })]);

    expect(text()).toContain('Marketing assets');
    expect(text()).toContain('›');
    expect(rowText('Şirket Raporu Q3.pdf')).toContain('Saved as reports/irket-raporu-q3-….pdf');

    const folder = qa<HTMLInputElement>('input').find((input) => input.placeholder === 'Bucket root')!;
    expect(folder.value).toBe('reports/');
    await setInput(folder, 'reports/2026');
    expect(rowText('Şirket Raporu Q3.pdf')).toContain('Saved as reports/2026/irket-raporu-q3-….pdf');

    await setInput(rowInput('Şirket Raporu Q3.pdf')!, 'Q3.PDF');
    expect(rowText('Q3.PDF')).toContain('Saved as reports/2026/q3-….PDF');

    await setInput(folder, '');
    expect(rowText('Q3.PDF')).toContain('Saved as q3-….PDF');
    expect(text()).toContain('bucket root');
  });

  it('refuses a folder the server would refuse, and sends nothing until it is fixed', async () => {
    await open();
    await pick([makeFile('a.txt')]);
    const folder = qa<HTMLInputElement>('input').find((input) => input.placeholder === 'Bucket root')!;
    await setInput(folder, '../secret');
    expect(text()).toContain('A folder cannot contain “.” or “..”.');
    expect(buttonByText('Upload 1 file')?.hasAttribute('disabled')).toBe(true);
    expect(qa('li.todo').map((li) => li.textContent)).toContain('Destination folder is valid');

    await setInput(folder, 'ok');
    expect(buttonByText('Upload 1 file')?.hasAttribute('disabled')).toBe(false);
  });

  it('lists the run in the summary: files, size, destination, Markdown', async () => {
    await open({ props: { folder: 'a/' } });
    await pick([makeFile('a.txt', { size: 2048 }), makeFile('b.txt', { size: 1024, lastModified: 2 })]);
    const summary = q('.form-summary')!.textContent ?? '';
    expect(summary).toContain('Files2');
    expect(summary).toContain(`Total size${formatBytes(3072)}`);
    expect(summary).toContain('Destinationa/');
    expect(summary).toContain('Markdown copyOn');
    expect(summary).toContain('Files selected');
    expect(summary).toContain('Every file is within the size limit');
  });

  it('warns, without blocking, when the files would not fit in the storage that is left', async () => {
    await open({ limits: { maxFileBytes: 10_000, quota: { usedBytes: 9_500, limitBytes: 10_000, filesUsed: 0, filesLimit: null } } });
    await pick([makeFile('a.txt', { size: 400 }), makeFile('b.txt', { size: 400, lastModified: 2 })]);
    expect(q('.form-summary')!.textContent).toContain(`${formatBytes(800)} to upload, but the project has ${formatBytes(500)} of storage left`);
    expect(buttonByText('Upload 2 files')?.hasAttribute('disabled')).toBe(false);
  });
});

/* ── Closing ──────────────────────────────────────────────────────────────── */

describe('closing', () => {
  it('closes at once when nothing is going out', async () => {
    await open();
    await pick([makeFile('a.txt')]);
    await clickButton('Cancel');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain('Stop uploading?');
  });

  it('asks first while uploads are in flight, and only cancels them when told to', async () => {
    await open();
    await pick([makeFile('a.txt')]);
    await startUploads(1);

    await clickButton('Cancel');
    await until(() => text().includes('Stop uploading?'), 'the question');
    expect(onClose).not.toHaveBeenCalled();
    await clickButton('Keep uploading');
    await until(() => !text().includes('Stop uploading?'), 'the question closing');
    expect(onClose).not.toHaveBeenCalled();
    expect(FakeXhr.instances[0]!.aborted).toBe(false);

    await clickButton('Cancel');
    await until(() => text().includes('Stop uploading?'), 'the question again');
    await clickButton('Cancel uploads and close');
    await until(() => onClose.mock.calls.length === 1, 'the close');
    expect(FakeXhr.instances[0]!.aborted).toBe(true);
  });

  it('asks only once when Escape is pressed again while the question is open', async () => {
    await open();
    await pick([makeFile('a.txt')]);
    await startUploads(1);

    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await until(() => text().includes('Stop uploading?'), 'the question');
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await wait(30);
    // The second Escape dismissed the question (keep uploading). Had the form asked again for it, a second
    // question would be on screen now.
    expect(buttonByText('Keep uploading')).toBeUndefined();
    await wait(60);
    expect(buttonByText('Keep uploading')).toBeUndefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(FakeXhr.instances[0]!.aborted).toBe(false);
  });

  it('warns the browser before a reload while uploads are in flight, and not otherwise', async () => {
    await open();
    await pick([makeFile('a.txt')]);
    const idle = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);

    await startUploads(1);
    const busy = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(busy);
    expect(busy.defaultPrevented).toBe(true);
  });

  it('reads Close once a file is stored, and closing needs no question when the run is over', async () => {
    await open();
    await pick([makeFile('a.txt')]);
    await startUploads(1);
    await answer(FakeXhr.instances[0]!, 201, created('a.txt'));
    await until(() => onUploaded.mock.calls.length === 1, 'the report');
    expect(buttonByText('Cancel')).toBeUndefined();
    await clickButton('Close');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('aborts what is still going out when the screen goes away', async () => {
    await open();
    await pick([makeFile('a.txt')]);
    await startUploads(1);
    await mounted!.unmount();
    mounted = null;
    expect(FakeXhr.instances[0]!.aborted).toBe(true);
  });

  it('starts empty each time it opens', async () => {
    await open();
    await pick([makeFile('a.txt')]);
    expect(rowInput('a.txt')).not.toBeNull();
    await mounted!.unmount();
    await open();
    expect(rowInput('a.txt')).toBeNull();
    expect(text()).toContain('No files added yet.');
  });
});

/* ── Who may upload ───────────────────────────────────────────────────────── */

describe('access', () => {
  it('shows someone who can only read the note, and no way to add or send a file', async () => {
    await open({ level: 'read' });
    await until(() => text().includes('read-only access'), 'the read-only note');
    expect(buttonByText('Browse files')?.hasAttribute('disabled')).toBe(true);
    expect(buttonByText('Upload')?.hasAttribute('disabled')).toBe(true);
  });

  it('explains why nothing can be added to a disabled bucket', async () => {
    await open({ props: { bucket: bucketView({ status: 'disabled' }) } });
    expect(text()).toContain('This bucket is disabled, so files cannot be uploaded.');
    expect(buttonByText('Browse files')?.hasAttribute('disabled')).toBe(true);
  });

  it('does the same for a bucket that is being deleted', async () => {
    await open({ props: { bucket: bucketView({ deleting: true }) } });
    expect(text()).toContain('This bucket is disabled, so files cannot be uploaded.');
  });
});

describe('language', () => {
  it('speaks Turkish, with the same limits and statuses', async () => {
    await open({ locale: 'tr', limits: { maxFileBytes: 1000 } });
    const page = text();
    expect(page).toContain('Dosya yükle');
    expect(page).toContain('Dosyaları buraya bırakın');
    expect(page).toContain(`Dosya başına en fazla ${formatBytes(1000)}`);
    await pick([makeFile('a.txt', { size: 10 }), makeFile('b.txt', { size: 5000, lastModified: 2 })]);
    expect(q<HTMLInputElement>('input[aria-label="a.txt dosyasının adı"]')).not.toBeNull();
    expect(text()).toContain('Hazır');
    expect(text()).toContain(`Çok büyük (sınır ${formatBytes(1000)})`);
    expect(buttonByText('1 dosya yükle')).toBeTruthy();
    expect(text()).toContain('1 / 2 hazır');
  });
});
