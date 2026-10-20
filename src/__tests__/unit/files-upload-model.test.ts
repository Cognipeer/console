/**
 * The Document Store upload screen without a DOM: the rules of the queue's rows (limits, names, folders, the key a
 * file will get), the summary numbers, the drop reader, and the engine that sends the files two at a time.
 * (The screen itself is in files-upload-ui.test.ts.)
 */

import { describe, expect, it, vi } from 'vitest';
import { composeUploadKeyHint, generateFileRelativeKey } from '@/lib/services/files/fileService';
import type { FileRecordView } from '@/lib/services/files';
import type { FilesLimits, UploadFileOptions } from '@/components/files/filesApi';
import {
  collectDropped,
  effectiveContentType,
  fileIdentity,
  fileIssue,
  FOLDER_MAX_LENGTH,
  isValidContentType,
  keyStem,
  MAX_QUEUE_FILES,
  parseFolder,
  previewObjectKey,
  quotaWarning,
  storageLeft,
  summarizeQueue,
  summarizeTypes,
  UPLOAD_CONCURRENCY,
  type QueueItem,
} from '@/components/files/upload/uploadModel';
import { UploadQueueEngine, type RunResult, type UploadFn } from '@/components/files/upload/uploadQueueEngine';

/* ── Fixtures ────────────────────────────────────────────────────────────── */

function file(name: string, options: { size?: number; type?: string; lastModified?: number } = {}): File {
  const made = new File(['x'], name, { type: options.type ?? 'text/plain', lastModified: options.lastModified ?? 1 });
  if (options.size !== undefined) Object.defineProperty(made, 'size', { value: options.size });
  return made;
}

function item(name: string, over: Partial<QueueItem> & { size?: number; type?: string } = {}): QueueItem {
  const { size, type, ...rest } = over;
  return {
    id: `id-${name}`,
    file: file(name, { size, type }),
    name,
    contentType: '',
    status: 'queued',
    waiting: false,
    progress: 0,
    ...rest,
  };
}

function limits(over: Partial<FilesLimits> = {}): FilesLimits {
  return {
    maxFileBytes: 1000,
    maxRequestBytes: 2000,
    allowedMimeTypes: null,
    quota: { usedBytes: 0, limitBytes: null, filesUsed: 0, filesLimit: null },
    ...over,
  };
}

const record = (key: string) => ({ id: key, key, name: key }) as unknown as FileRecordView;

/* ── Folders ─────────────────────────────────────────────────────────────── */

describe('parseFolder', () => {
  it('reads the folder the way the upload route does', () => {
    expect(parseFolder('')).toEqual({ folder: '', problem: null });
    expect(parseFolder('   ')).toEqual({ folder: '', problem: null });
    expect(parseFolder('reports')).toEqual({ folder: 'reports/', problem: null });
    expect(parseFolder('reports/')).toEqual({ folder: 'reports/', problem: null });
    expect(parseFolder('/reports/2026')).toEqual({ folder: 'reports/2026/', problem: null });
    expect(parseFolder('a//b')).toEqual({ folder: 'a/b/', problem: null });
    expect(parseFolder('a\\b')).toEqual({ folder: 'a/b/', problem: null });
    expect(parseFolder(' ü/ğ ')).toEqual({ folder: 'ü/ğ/', problem: null });
  });

  it('names the reason a folder would be refused', () => {
    expect(parseFolder('../x').problem).toBe('dot_segments');
    expect(parseFolder('a/./b').problem).toBe('dot_segments');
    expect(parseFolder('a/..').problem).toBe('dot_segments');
    expect(parseFolder('a\u0001b').problem).toBe('control_chars');
    expect(parseFolder('x'.repeat(FOLDER_MAX_LENGTH + 1)).problem).toBe('too_long');
    expect(parseFolder('x'.repeat(FOLDER_MAX_LENGTH)).problem).toBeNull();
  });

  it('agrees with the server on which folders are refused and what the accepted ones become', () => {
    const inputs = [
      '',
      '   ',
      'reports',
      'reports/',
      '/reports/2026',
      'a//b',
      'a\\b',
      '../x',
      'a/./b',
      'a/..',
      'a\u0001b',
      'x'.repeat(FOLDER_MAX_LENGTH + 1),
      'x'.repeat(FOLDER_MAX_LENGTH),
      'ü/ğ',
      ' spaced / folder ',
    ];
    for (const input of inputs) {
      const server = composeUploadKeyHint({ folder: input });
      const mine = parseFolder(input);
      if ('error' in server) {
        expect(mine.problem, `refused: ${JSON.stringify(input)}`).not.toBeNull();
      } else {
        expect(mine.problem, `accepted: ${JSON.stringify(input)}`).toBeNull();
        expect(mine.folder, `folder of ${JSON.stringify(input)}`).toBe(server.keyHint ?? '');
      }
    }
  });
});

/* ── The key a file gets ─────────────────────────────────────────────────── */

describe('key preview', () => {
  const NAMES = [
    'Report Q3.PDF',
    'şirket raporu.pdf',
    'archive.tar.gz',
    '.env',
    '..hidden.txt',
    'UPPER_case-File.TXT',
    'noextension',
    'a b  c.docx',
    'emoji 🎉.png',
    `${'x'.repeat(300)}.md`,
    'weird!@#$%^&*()name.txt',
    '  spaced.txt  ',
    'tab\tname.txt',
    'trailing-dot.',
    'a.b.c.d',
    '-lead.txt',
    '___.txt',
  ];

  it('is the stem and extension the server builds the key from', () => {
    for (const name of NAMES) {
      const real = generateFileRelativeKey(name);
      const { stem, extension } = keyStem(name);
      expect(real.endsWith(extension), `extension of ${JSON.stringify(name)} in ${real}`).toBe(true);
      const withoutExtension = real.slice(0, real.length - extension.length);
      expect(withoutExtension, `stem of ${JSON.stringify(name)}`).toMatch(new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+-[0-9a-f]{8}$`));
    }
  });

  it('shows the folder, the stem, an ellipsis for the unique part and the extension', () => {
    expect(previewObjectKey('', 'Report Q3.PDF')).toBe('report-q3-….PDF');
    expect(previewObjectKey('reports/2026/', 'Şirket Raporu Q3.pdf')).toBe('reports/2026/irket-raporu-q3-….pdf');
    expect(previewObjectKey('a/', 'noextension')).toBe('a/noextension-…');
    expect(previewObjectKey('', '.env')).toBe('env-…');
  });

  it('falls back to a plain stem for a name with nothing usable', () => {
    expect(keyStem('🎉🎉.png')).toEqual({ stem: 'file', extension: '.png' });
    expect(keyStem('   ')).toEqual({ stem: 'uploaded-file', extension: '' });
  });
});

/* ── What a file may be ──────────────────────────────────────────────────── */

describe('content type', () => {
  it('sends the override, else the browser type, else a generic one', () => {
    expect(effectiveContentType({ file: file('a.bin', { type: '' }), contentType: '' })).toBe('application/octet-stream');
    expect(effectiveContentType({ file: file('a.txt', { type: 'text/plain' }), contentType: '' })).toBe('text/plain');
    expect(effectiveContentType({ file: file('a.txt', { type: 'text/plain' }), contentType: ' text/csv ' })).toBe('text/csv');
  });

  it('accepts the shape the server accepts', () => {
    expect(isValidContentType('text/plain')).toBe(true);
    expect(isValidContentType('application/vnd.ms-excel; charset=utf-8')).toBe(true);
    expect(isValidContentType('plain')).toBe(false);
    expect(isValidContentType('text/')).toBe(false);
    expect(isValidContentType('te xt/plain')).toBe(false);
  });
});

describe('fileIssue', () => {
  it('flags a file over the size limit before anything is sent', () => {
    expect(fileIssue(item('big.txt', { size: 1001 }), limits())).toEqual({ kind: 'too_large', limit: 1000 });
    expect(fileIssue(item('edge.txt', { size: 1000 }), limits())).toBeNull();
  });

  it('flags a type that is not on the allowlist, wildcards included', () => {
    const allowed = limits({ allowedMimeTypes: ['text/*', 'application/pdf'] });
    expect(fileIssue(item('a.png', { type: 'image/png' }), allowed)).toEqual({ kind: 'type_not_allowed', type: 'image/png' });
    expect(fileIssue(item('a.txt', { type: 'text/markdown' }), allowed)).toBeNull();
    expect(fileIssue(item('a.pdf', { type: 'application/pdf' }), allowed)).toBeNull();
    expect(fileIssue(item('a.bin', { type: '' }), allowed)).toEqual({ kind: 'type_not_allowed', type: 'application/octet-stream' });
    // An empty allowlist means any type.
    expect(fileIssue(item('a.png', { type: 'image/png' }), limits({ allowedMimeTypes: [] }))).toBeNull();
  });

  it('flags a name that is empty or carries a slash, and a content type that is not one', () => {
    expect(fileIssue(item('a.txt', { name: '  ' }), limits())).toEqual({ kind: 'name_required' });
    expect(fileIssue(item('a.txt', { name: 'x/y.txt' }), limits())).toEqual({ kind: 'name_slash' });
    expect(fileIssue(item('a.txt', { contentType: 'nope' }), limits())).toEqual({ kind: 'content_type_invalid' });
  });

  it('judges only a row that has not been stored, and nothing before the limits are known', () => {
    expect(fileIssue(item('big.txt', { size: 5000, status: 'done' }), limits())).toBeNull();
    expect(fileIssue(item('big.txt', { size: 5000, status: 'uploading' }), limits())).toBeNull();
    expect(fileIssue(item('big.txt', { size: 5000, status: 'failed' }), limits())).toEqual({ kind: 'too_large', limit: 1000 });
    expect(fileIssue(item('big.txt', { size: 5000 }), undefined)).toBeNull();
  });
});

describe('summarizeQueue', () => {
  it('counts what is ready, what is flagged and what is already going', () => {
    const rows = [
      item('ok.txt', { size: 10 }),
      item('retry.txt', { size: 20, status: 'failed', error: 'x' }),
      item('big.txt', { size: 5000 }),
      item('pic.png', { size: 10, type: 'image/png' }),
      item('nameless.txt', { name: '' }),
      item('sending.txt', { status: 'uploading' }),
      item('waiting.txt', { waiting: true }),
      item('stored.txt', { status: 'done' }),
    ];
    const summary = summarizeQueue(rows, limits({ allowedMimeTypes: ['text/*'] }));
    expect(summary).toMatchObject({
      total: 8,
      uploading: 1,
      done: 1,
      failed: 1,
      waiting: 1,
      tooLarge: 1,
      typeNotAllowed: 1,
      nameProblems: 1,
      readyBytes: 30,
    });
    expect(summary.readyIds).toEqual(['id-ok.txt', 'id-retry.txt']);
  });
});

describe('quota', () => {
  const quota = (over: Partial<FilesLimits['quota']>) => limits({ quota: { usedBytes: 0, limitBytes: null, filesUsed: 0, filesLimit: null, ...over } });

  it('knows what is left, and that unlimited has no end', () => {
    expect(storageLeft(quota({ usedBytes: 300, limitBytes: 1000 }))).toBe(700);
    expect(storageLeft(quota({ usedBytes: 2000, limitBytes: 1000 }))).toBe(0);
    expect(storageLeft(quota({ limitBytes: null }))).toBeNull();
    expect(storageLeft(undefined)).toBeNull();
  });

  it('warns when the files about to go would not fit, and only then', () => {
    expect(quotaWarning(quota({ usedBytes: 900, limitBytes: 1000 }), 200, 2)).toEqual({ kind: 'storage', left: 100 });
    expect(quotaWarning(quota({ usedBytes: 900, limitBytes: 1000 }), 100, 2)).toBeNull();
    expect(quotaWarning(quota({ filesUsed: 9, filesLimit: 10 }), 10, 3)).toEqual({ kind: 'files', left: 1 });
    expect(quotaWarning(quota({ usedBytes: 900, limitBytes: 1000 }), 5000, 0)).toBeNull();
    expect(quotaWarning(undefined, 5000, 3)).toBeNull();
  });
});

describe('summarizeTypes', () => {
  it('lists the first few types and says how many were left out', () => {
    const types = Array.from({ length: 9 }, (_, index) => `t${index}/x`);
    expect(summarizeTypes(types, 3)).toEqual({ shown: 't0/x, t1/x, t2/x', hidden: 6, all: types.join(', ') });
    expect(summarizeTypes(['a/b', ' a/b ', ''], 6)).toEqual({ shown: 'a/b', hidden: 0, all: 'a/b' });
  });
});

describe('collectDropped', () => {
  const entry = (fileOrFolder: File | 'folder') => ({
    kind: 'file',
    getAsFile: () => (fileOrFolder === 'folder' ? null : fileOrFolder),
    webkitGetAsEntry: () => ({ isDirectory: fileOrFolder === 'folder' }),
  });

  it('takes the files of a drop and counts the folders instead of failing on them', () => {
    const a = file('a.txt');
    const b = file('b.txt');
    expect(collectDropped({ files: [a], items: [entry(a), entry('folder'), entry(b), { kind: 'string', getAsFile: () => null }] })).toEqual({
      files: [a, b],
      folders: 1,
    });
  });

  it('falls back to the plain file list when the browser gives no items', () => {
    const a = file('a.txt');
    expect(collectDropped({ files: [a] })).toEqual({ files: [a], folders: 0 });
    expect(collectDropped({ files: [a], items: [] })).toEqual({ files: [a], folders: 0 });
  });

  it('treats the same file picked twice as one', () => {
    expect(fileIdentity(file('a.txt', { size: 5, lastModified: 9 }))).toBe(fileIdentity(file('a.txt', { size: 5, lastModified: 9 })));
    expect(fileIdentity(file('a.txt', { size: 5, lastModified: 9 }))).not.toBe(fileIdentity(file('a.txt', { size: 6, lastModified: 9 })));
  });
});

/* ── The engine ──────────────────────────────────────────────────────────── */

interface Call {
  bucketKey: string;
  file: File;
  options: UploadFileOptions;
  resolve: (key?: string) => void;
  reject: (error: unknown) => void;
}

/** An upload function the test settles by hand; `peak()` is the most uploads that were ever open at once. */
function fakeUpload() {
  const calls: Call[] = [];
  let active = 0;
  let peak = 0;
  const upload: UploadFn = (bucketKey, source, options) =>
    new Promise((resolve, reject) => {
      active += 1;
      peak = Math.max(peak, active);
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        active -= 1;
        action();
      };
      calls.push({
        bucketKey,
        file: source,
        options,
        resolve: (key = source.name) => finish(() => resolve({ record: record(key) })),
        reject: (error) => finish(() => reject(error)),
      });
      options.signal?.addEventListener('abort', () => finish(() => reject(new DOMException('aborted', 'AbortError'))), { once: true });
    });
  return { upload, calls, peak: () => peak };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function engineWith(upload: UploadFn, extra: { maxFiles?: number; concurrency?: number } = {}) {
  const settled: RunResult[] = [];
  const engine = new UploadQueueEngine({
    bucketKey: 'docs',
    upload,
    handlers: {
      describeError: (error) => (error instanceof Error ? `E:${error.message}` : 'E'),
      onSettled: (result) => settled.push(result),
    },
    ...extra,
  });
  return { engine, settled };
}

const SETTINGS = { folder: 'reports/', convertToMarkdown: true };
const stamped = (count: number) => Array.from({ length: count }, (_, index) => file(`f${index}.txt`, { lastModified: index + 1 }));
const status = (engine: UploadQueueEngine) => engine.getSnapshot().map((row) => `${row.name}:${row.status}${row.waiting ? '+w' : ''}`);

describe('UploadQueueEngine', () => {
  it('sends at most two files at a time and starts the next as soon as a slot frees', async () => {
    expect(UPLOAD_CONCURRENCY).toBe(2);
    const fake = fakeUpload();
    const { engine, settled } = engineWith(fake.upload);
    engine.add(stamped(5));
    engine.start(engine.getSnapshot().map((row) => row.id), SETTINGS);

    expect(fake.calls).toHaveLength(2);
    expect(status(engine)).toEqual(['f0.txt:uploading', 'f1.txt:uploading', 'f2.txt:queued+w', 'f3.txt:queued+w', 'f4.txt:queued+w']);
    expect(engine.busy).toBe(true);

    fake.calls[1]!.resolve();
    await flush();
    expect(fake.calls.map((call) => call.file.name)).toEqual(['f0.txt', 'f1.txt', 'f2.txt']);

    fake.calls[0]!.resolve();
    fake.calls[2]!.resolve();
    await flush();
    expect(fake.calls).toHaveLength(5);
    fake.calls[3]!.resolve();
    fake.calls[4]!.resolve();
    await flush();

    expect(fake.peak()).toBe(2);
    expect(status(engine).every((row) => row.endsWith(':done'))).toBe(true);
    expect(engine.busy).toBe(false);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.records.map((r) => r.key).sort()).toEqual(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
    expect(settled[0]!.failed).toBe(0);
  });

  it('hands each upload the name, folder, Markdown choice and a signal', () => {
    const fake = fakeUpload();
    const { engine } = engineWith(fake.upload);
    engine.add([file('a.txt'), file('b.txt', { lastModified: 2 })]);
    const [first, second] = engine.getSnapshot();
    engine.rename(first!.id, '  Renamed.txt ');
    engine.setContentType(second!.id, ' text/csv ');
    engine.start([first!.id, second!.id], { folder: 'x/y/', convertToMarkdown: false });

    expect(fake.calls[0]!.bucketKey).toBe('docs');
    expect(fake.calls[0]!.options).toMatchObject({ name: 'Renamed.txt', folder: 'x/y/', convertToMarkdown: false });
    expect(fake.calls[0]!.options.contentType).toBeUndefined();
    expect(fake.calls[0]!.options.signal).toBeInstanceOf(AbortSignal);
    expect(fake.calls[1]!.options.contentType).toBe('text/csv');
  });

  it('sends nothing for the folder at the bucket root', () => {
    const fake = fakeUpload();
    const { engine } = engineWith(fake.upload);
    engine.add([file('a.txt')]);
    engine.start(engine.getSnapshot().map((row) => row.id), { folder: '', convertToMarkdown: true });
    expect('folder' in fake.calls[0]!.options).toBe(false);
  });

  it('moves the bar a percent at a time', () => {
    const fake = fakeUpload();
    const { engine } = engineWith(fake.upload);
    engine.add([file('a.txt')]);
    engine.start(engine.getSnapshot().map((row) => row.id), SETTINGS);
    const seen: number[] = [];
    engine.subscribe(() => seen.push(engine.getSnapshot()[0]!.progress));

    const report = fake.calls[0]!.options.onProgress!;
    report({ loaded: 1, total: 1000, fraction: 0.001 });
    report({ loaded: 5, total: 1000, fraction: 0.005 });
    report({ loaded: 10, total: 1000, fraction: 0.01 });
    report({ loaded: 15, total: 1000, fraction: 0.015 });
    report({ loaded: 500, total: 1000, fraction: 0.5 });
    expect(seen).toEqual([0.001, 0.01, 0.5]);
  });

  it('keeps a failed file on its row with the sentence, lets the others finish and reports the run once', async () => {
    const fake = fakeUpload();
    const { engine, settled } = engineWith(fake.upload);
    engine.add(stamped(3));
    engine.start(engine.getSnapshot().map((row) => row.id), SETTINGS);
    fake.calls[0]!.reject(new Error('boom'));
    await flush();
    fake.calls[1]!.resolve();
    fake.calls[2]!.resolve();
    await flush();

    expect(status(engine)).toEqual(['f0.txt:failed', 'f1.txt:done', 'f2.txt:done']);
    expect(engine.getSnapshot()[0]!.error).toBe('E:boom');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.failed).toBe(1);
    expect(settled[0]!.records).toHaveLength(2);
  });

  it('falls back to the error text when describing the error throws', async () => {
    const fake = fakeUpload();
    const settled: RunResult[] = [];
    const engine = new UploadQueueEngine({
      bucketKey: 'docs',
      upload: fake.upload,
      handlers: {
        describeError: () => {
          throw new Error('nope');
        },
        onSettled: (result) => settled.push(result),
      },
    });
    engine.add([file('a.txt')]);
    engine.start(engine.getSnapshot().map((row) => row.id), SETTINGS);
    fake.calls[0]!.reject(new Error('disk full'));
    await flush();
    expect(engine.getSnapshot()[0]).toMatchObject({ status: 'failed', error: 'disk full' });
  });

  it('retries one failed file as a run of its own, with the same settings applied again', async () => {
    const fake = fakeUpload();
    const { engine, settled } = engineWith(fake.upload);
    engine.add(stamped(2));
    const ids = engine.getSnapshot().map((row) => row.id);
    engine.start(ids, SETTINGS);
    fake.calls[0]!.reject(new Error('timeout'));
    fake.calls[1]!.resolve();
    await flush();
    expect(settled).toHaveLength(1);

    engine.rename(ids[0]!, 'fixed.txt');
    engine.start([ids[0]!], { folder: 'other/', convertToMarkdown: false });
    expect(engine.getSnapshot()[0]).toMatchObject({ status: 'uploading', error: undefined, progress: 0 });
    expect(fake.calls[2]!.options).toMatchObject({ name: 'fixed.txt', folder: 'other/', convertToMarkdown: false });
    fake.calls[2]!.resolve('fixed.txt');
    await flush();

    expect(engine.getSnapshot()[0]).toMatchObject({ status: 'done' });
    expect(settled).toHaveLength(2);
    expect(settled[1]!.records.map((r) => r.key)).toEqual(['fixed.txt']);
  });

  it('lets rows join a run that is going and ignores rows that are not ready', () => {
    const fake = fakeUpload();
    const { engine } = engineWith(fake.upload, { concurrency: 1 });
    engine.add(stamped(3));
    const ids = engine.getSnapshot().map((row) => row.id);
    engine.start([ids[0]!], SETTINGS);
    engine.start([ids[0]!, ids[1]!], SETTINGS);
    expect(status(engine)).toEqual(['f0.txt:uploading', 'f1.txt:queued+w', 'f2.txt:queued']);
    engine.rename(ids[1]!, 'nope.txt');
    expect(engine.getSnapshot()[1]!.name).toBe('f1.txt');
  });

  it('cancels an upload that is removed from the list, frees its slot and does not count it as a failure', async () => {
    const fake = fakeUpload();
    const { engine, settled } = engineWith(fake.upload, { concurrency: 1 });
    engine.add(stamped(2));
    const ids = engine.getSnapshot().map((row) => row.id);
    engine.start(ids, SETTINGS);
    const firstSignal = fake.calls[0]!.options.signal!;

    engine.remove(ids[0]!);
    expect(firstSignal.aborted).toBe(true);
    await flush();
    expect(fake.calls).toHaveLength(2);
    expect(status(engine)).toEqual(['f1.txt:uploading']);
    fake.calls[1]!.resolve();
    await flush();

    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ failed: 0 });
    expect(settled[0]!.records.map((r) => r.key)).toEqual(['f1.txt']);
  });

  it('stops everything on cancelAll: uploads are aborted, rows are ready again and no run is reported', async () => {
    const fake = fakeUpload();
    const { engine, settled } = engineWith(fake.upload);
    engine.add(stamped(4));
    engine.start(engine.getSnapshot().map((row) => row.id), SETTINGS);
    const signals = fake.calls.map((call) => call.options.signal!);

    engine.cancelAll();
    await flush();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(fake.calls).toHaveLength(2);
    expect(status(engine)).toEqual(['f0.txt:queued', 'f1.txt:queued', 'f2.txt:queued', 'f3.txt:queued']);
    expect(engine.busy).toBe(false);
    expect(settled).toHaveLength(0);
  });

  it('ignores the answer of an upload that was cancelled and still came back', async () => {
    // An upload that does not notice the abort and answers (or fails) later anyway.
    const answers: Array<{ ok: () => void; fail: () => void }> = [];
    const upload: UploadFn = (_bucketKey, source) =>
      new Promise((resolve, reject) => {
        answers.push({ ok: () => resolve({ record: record(source.name) }), fail: () => reject(new Error('late')) });
      });
    const { engine, settled } = engineWith(upload);
    engine.add([file('a.txt'), file('b.txt', { lastModified: 2 })]);
    engine.start(engine.getSnapshot().map((row) => row.id), SETTINGS);
    engine.cancelAll();
    answers[0]!.ok();
    answers[1]!.fail();
    await flush();

    expect(status(engine)).toEqual(['a.txt:queued', 'b.txt:queued']);
    expect(settled).toHaveLength(0);
  });

  it('caps the batch, skips a file that is already in the list and makes room again for uploaded ones', async () => {
    expect(MAX_QUEUE_FILES).toBe(20);
    const fake = fakeUpload();
    const { engine } = engineWith(fake.upload, { maxFiles: 3 });
    expect(engine.add(stamped(5))).toEqual({ added: 3, duplicates: 0, overflow: 2 });
    expect(engine.add([stamped(1)[0]!])).toEqual({ added: 0, duplicates: 1, overflow: 0 });

    const ids = engine.getSnapshot().map((row) => row.id);
    engine.start([ids[0]!], SETTINGS);
    fake.calls[0]!.resolve();
    await flush();
    // The uploaded row no longer counts against the cap, and the same file may be sent again.
    expect(engine.add([file('new.txt', { lastModified: 99 }), stamped(1)[0]!])).toEqual({ added: 1, duplicates: 0, overflow: 1 });
  });

  it('notifies subscribers of every change and stops after unsubscribing', () => {
    const { engine } = engineWith(fakeUpload().upload);
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    engine.add([file('a.txt')]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    engine.add([file('b.txt', { lastModified: 2 })]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
