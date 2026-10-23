// @vitest-environment jsdom
/**
 * The shared pieces of the Document Store screens in a DOM: the chips, badges and hints in both languages, the
 * hooks (project scope, access, listing, polling) and the mutations with what they refresh, against a mocked
 * `fetch`. (The pure rules, the API client and the message modules are in files-foundation.test.ts.)
 */

import { act, createElement as h, useReducer, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import { notifyActiveProjectChanged } from '@/components/layout/useEffectivePermissions';
import { uploadFile, type ProviderHealth } from '@/components/files/filesApi';
import {
  BucketStatusBadge,
  CopyButton,
  FileKindChip,
  FileKindIcon,
  MarkdownStatusBadge,
  ProviderHealthChip,
  ReadOnlyHint,
  RelativeTime,
  StorageLocation,
  markdownFileName,
  saveBlob,
  useNow,
} from '@/components/files/shared';
import { locationPathOf } from '@/components/files/shared/StorageLocation';
import { useFilesAccess } from '@/components/files/useFilesAccess';
import {
  DELETE_POLL_MAX_MS,
  MARKDOWN_POLL_MAX_MS,
  filesKeys,
  flattenObjectPages,
  getFilesProjectScope,
  useArchiveObjects,
  useBatchDeleteObjects,
  useBucket,
  useBuckets,
  useConvertObject,
  useDeleteBucket,
  useDeleteObject,
  useDownloadObject,
  useFileProviders,
  useFilesInvalidation,
  useFilesLimits,
  useFilesProject,
  useImportFromStorage,
  useObject,
  useObjectText,
  useObjects,
  useTestFileProvider,
  useUpdateBucket,
  useUploadObject,
} from '@/components/files/useFilesQueries';
import {
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  text,
  wait,
  type ApiMock,
  type Mounted,
  type RouteHandler,
} from '../helpers/iamCenterUi';

beforeAll(() => {
  installDomStubs();
});

const mounted: Mounted[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const item of mounted.splice(0)) await item.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function show(element: ReactNode, locale: 'en' | 'tr' = 'en') {
  const item = await mount(element, locale);
  mounted.push(item);
  return item;
}

/** Shows `element` inside a marked box, so a test reads the element’s own text (the Mantine provider adds style tags to the host). */
async function showSubject(element: ReactNode, locale: 'en' | 'tr' = 'en') {
  const item = await show(h('div', { 'data-subject': '' }, element), locale);
  return item.host.querySelector<HTMLElement>('[data-subject]')!;
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

interface Probe<T> {
  result: { current: T };
  /** Every value the hook returned, in order. */
  history: T[];
  /** Renders the probe again with another hook body (for hooks whose arguments change). */
  rerender: (hook: () => T) => Promise<void>;
}

/** Mounts `hook` in a component under a query client and keeps the latest value in `result.current`. */
async function renderHookIn<T>(client: QueryClient, hook: () => T, locale: 'en' | 'tr' = 'en'): Promise<Probe<T>> {
  const result = { current: undefined as T };
  const history: T[] = [];
  let currentHook = hook;
  let force: () => void = () => {};
  function HookProbe() {
    const [, bump] = useReducer((count: number) => count + 1, 0);
    force = bump as () => void;
    result.current = currentHook();
    history.push(result.current);
    return null;
  }
  await show(h(QueryClientProvider, { client }, h(HookProbe)), locale);
  return {
    result,
    history,
    rerender: async (next) => {
      currentHook = next;
      await act(async () => {
        force();
      });
    },
  };
}

/** Waits (really) until `check` holds. */
async function until(check: () => boolean, label: string, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await wait(10);
  }
}

/**
 * Moves fake time forward inside `act`. It goes one millisecond further than asked: a timer that a tick itself
 * schedules for "now" (the query client announcing an answer) is due one millisecond later, so without the extra
 * millisecond the answer of the last poll would not have reached the component yet.
 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(1);
  });
}

function useFakeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
}

const record = (key: string, extra: Record<string, unknown> = {}) => ({
  id: key,
  key,
  name: key.split('/').pop(),
  size: 10,
  contentType: 'application/pdf',
  markdownStatus: 'skipped',
  ...extra,
});

const bucketView = (key: string, extra: Record<string, unknown> = {}) => ({
  id: key,
  key,
  name: key,
  providerKey: 'local',
  status: 'active',
  stats: { fileCount: 0, totalBytes: 0 },
  providerHealth: { state: 'builtin' },
  ...extra,
});

const bucketDetail = (key: string, extra: Record<string, unknown> = {}) => ({ ...bucketView(key), usedBy: [], storageLocation: null, ...extra });

const count = (api: ApiMock, method: string, path: string | RegExp) => api.to(method, path).length;

/* ── components ──────────────────────────────────────────────────────────── */

describe.each(['en', 'tr'] as const)('shared components (%s)', (locale) => {
  const words = (locale === 'en' ? en : tr).files.common;
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

  it('says where a Markdown copy stands', async () => {
    await show(h(MarkdownStatusBadge, { status: 'succeeded' }), locale);
    expect(text()).toContain(words.markdown.ready);
  });

  it('shows a conversion in progress', async () => {
    await show(h(MarkdownStatusBadge, { status: 'pending' }), locale);
    expect(text()).toContain(words.markdown.pending);
  });

  it('keeps the reason of a failed conversion one hover or focus away', async () => {
    await show(h(MarkdownStatusBadge, { status: 'failed', error: 'Scanned pages could not be read' }), locale);
    expect(text()).toContain(words.markdown.failed);
    const button = document.querySelector('button[aria-label]');
    expect(button?.getAttribute('aria-label')).toBe(`${words.markdown.failureTitle}: Scanned pages could not be read`);
  });

  it('admits when no reason was recorded', async () => {
    await show(h(MarkdownStatusBadge, { status: 'failed' }), locale);
    expect(document.querySelector('button[aria-label]')?.getAttribute('aria-label')).toContain(words.markdown.failureUnknown);
  });

  it('shows a quiet dash for a file that was not converted', async () => {
    const skipped = await showSubject(h(MarkdownStatusBadge, { status: 'skipped' }), locale);
    expect(skipped.textContent).toContain('—');
    expect(skipped.textContent).toContain(words.markdown.skipped);
    const nothing = await showSubject(h(MarkdownStatusBadge, { status: undefined }), locale);
    expect(nothing.textContent).toBe('—');
  });

  it('adds the reason a conversion was skipped to the dash, to the eye and to a screen reader', async () => {
    const reason = 'The file is larger than the 20 MB conversion limit';
    const skipped = await showSubject(h(MarkdownStatusBadge, { status: 'skipped', error: reason }), locale);
    expect(skipped.querySelector('span[title]')?.getAttribute('title')).toBe(`${words.markdown.skipped}: ${reason}`);
    expect(skipped.textContent).toContain(`${words.markdown.skipped}: ${reason}`);
    // no reason recorded: the dash says only that nothing was converted
    const plain = await showSubject(h(MarkdownStatusBadge, { status: 'skipped', error: '   ' }), locale);
    expect(plain.querySelector('span[title]')?.getAttribute('title')).toBe(words.markdown.skipped);
    // a reason with no skipped status is not shown: it belongs to a status that has a place for it
    const stray = await showSubject(h(MarkdownStatusBadge, { status: undefined, error: reason }), locale);
    expect(stray.textContent).toBe('—');
    expect(stray.querySelector('[title]')).toBeNull();
  });

  it('shows a connected provider with when it was tested', async () => {
    const health: ProviderHealth = { state: 'ok', testedAt: hoursAgo(2) };
    await show(h(ProviderHealthChip, { health, href: '/dashboard/providers/p1' }), locale);
    expect(text()).toContain(`${words.health.ok} · `);
    expect(document.querySelector('a')).toBeNull();
  });

  it('sends a failed provider to its page, with the reason', async () => {
    const health: ProviderHealth = { state: 'failed', testedAt: hoursAgo(1), message: 'Access denied' };
    await show(h(ProviderHealthChip, { health, href: '/dashboard/providers/p1', showReason: true }), locale);
    expect(text()).toContain(words.health.failed);
    expect(text()).toContain('Access denied');
    const link = document.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/dashboard/providers/p1');
    expect(link?.textContent).toBe(words.health.openProvider);
  });

  it('words an untested, a disabled and a built-in provider', async () => {
    await show(h(ProviderHealthChip, { health: { state: 'untested' }, href: '/x' }), locale);
    expect(text()).toContain(words.health.untested);
    expect(text()).toContain(words.health.untestedReason);
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/x');
    await show(h(ProviderHealthChip, { health: { state: 'inactive', message: 'Switched off' } }), locale);
    expect(text()).toContain(words.health.inactive);
    expect(text()).toContain('Switched off');
    await show(h(ProviderHealthChip, { health: { state: 'builtin' }, href: '/y' }), locale);
    expect(text()).toContain(words.health.builtin);
    expect(document.querySelector('a[href="/y"]')).toBeNull();
  });

  it('can leave the time out, and draws nothing without a health', async () => {
    const timeless = await showSubject(h(ProviderHealthChip, { health: { state: 'ok', testedAt: hoursAgo(3) }, hideTime: true }), locale);
    expect(timeless.textContent).toContain(words.health.ok);
    expect(timeless.textContent?.includes(' · ')).toBe(false);
    const empty = await showSubject(h(ProviderHealthChip, { health: undefined }), locale);
    expect(empty.textContent).toBe('');
  });

  it('prints a storage location in monospace with a copy button, and names the local disk', async () => {
    const remote = await showSubject(h(StorageLocation, { location: 's3://bucket/prefix/tenant/p/docs/' }), locale);
    expect(remote.textContent).toContain('s3://bucket/prefix/tenant/p/docs/');
    expect(remote.querySelector('.ds-mono')).not.toBeNull();
    expect(remote.querySelector(`button[aria-label="${words.storage.copy}"]`)).not.toBeNull();

    const quiet = await showSubject(h(StorageLocation, { location: 's3://bucket/x/', copyable: false }), locale);
    expect(quiet.querySelector('button')).toBeNull();

    const local = await showSubject(h(StorageLocation, { location: null }), locale);
    expect(local.textContent).toContain(words.storage.thisServerDisk);
    expect(local.textContent).toContain(words.storage.thisServerDiskHint);
    expect(local.querySelector('button')).toBeNull();

    const unknown = await showSubject(h(StorageLocation, { location: undefined }), locale);
    expect(unknown.textContent).toBe('—');
  });

  it('does not call a missing address the local disk when the provider keeps its files elsewhere', async () => {
    // an S3 or Azure provider whose settings name no bucket or container yet, or a provider that is gone
    const notKnown = await showSubject(h(StorageLocation, { location: null, localDisk: false }), locale);
    expect(notKnown.textContent).toContain(words.storage.unknown);
    expect(notKnown.textContent).toContain(words.storage.unknownHint);
    expect(notKnown.textContent).not.toContain(words.storage.thisServerDisk);
    expect(notKnown.querySelector('button')).toBeNull();

    // `localDisk` only decides what a missing address means; an address is printed as it is
    const printed = await showSubject(h(StorageLocation, { location: 's3://docs/team/', localDisk: false }), locale);
    expect(printed.textContent).toContain('s3://docs/team/');
    expect(printed.textContent).not.toContain(words.storage.unknown);
  });

  it('copies the path of a location, without the server named after it', async () => {
    const withHost = 's3://docs/team/ \u00b7 minio.local:9000';
    expect(locationPathOf(withHost)).toBe('s3://docs/team/');
    expect(locationPathOf('s3://docs/team/')).toBe('s3://docs/team/');
    expect(locationPathOf('azure://account/container/team/')).toBe('azure://account/container/team/');
    // only a trailing " · host" is the server; a dot in a folder name is part of the path
    expect(locationPathOf('s3://docs/a \u00b7 b/c/')).toBe('s3://docs/a \u00b7 b/c/');

    const shown = await showSubject(h(StorageLocation, { location: withHost }), locale);
    // the whole location is printed, so two servers with one bucket name can be told apart
    expect(shown.textContent).toContain(withHost);
    expect(shown.querySelector('button[aria-label]')).not.toBeNull();
  });

  it('words the status of a bucket', async () => {
    expect((await showSubject(h(BucketStatusBadge, { status: 'active' }), locale)).textContent).toContain(words.bucketStatus.active);
    expect((await showSubject(h(BucketStatusBadge, { status: 'disabled' }), locale)).textContent).toContain(words.bucketStatus.disabled);
    expect((await showSubject(h(BucketStatusBadge, { status: 'active', deleting: true }), locale)).textContent).toContain(words.bucketStatus.deleting);
  });

  it('says that the deletion of a bucket failed, with the reason one hover or focus away', async () => {
    const reason = 'The storage provider refused the request';
    const failed = await showSubject(h(BucketStatusBadge, { status: 'disabled', deleteError: reason }), locale);
    expect(failed.textContent).toContain(words.bucketStatus.deleteFailed);
    expect(failed.textContent).not.toContain(words.bucketStatus.disabled);
    expect(failed.querySelector('.ds-badge-err')).not.toBeNull();
    expect(failed.querySelector('button[aria-label]')?.getAttribute('aria-label')).toBe(`${words.bucketStatus.deleteFailed}: ${reason}`);

    // the failure outranks the status, also when the queue was unavailable and the bucket stayed active
    const stillActive = await showSubject(h(BucketStatusBadge, { status: 'active', deleteError: reason }), locale);
    expect(stillActive.textContent).toContain(words.bucketStatus.deleteFailed);
    expect(stillActive.textContent).not.toContain(words.bucketStatus.active);
  });

  it('shows a deletion that is running over the failure of the run before it', async () => {
    const running = await showSubject(h(BucketStatusBadge, { status: 'disabled', deleting: true, deleteError: 'An earlier run stopped' }), locale);
    expect(running.textContent).toContain(words.bucketStatus.deleting);
    expect(running.textContent).not.toContain(words.bucketStatus.deleteFailed);
    expect(running.querySelector('button')).toBeNull();
    // an empty note is no failure
    const blank = await showSubject(h(BucketStatusBadge, { status: 'active', deleteError: '' }), locale);
    expect(blank.textContent).toContain(words.bucketStatus.active);
    const none = await showSubject(h(BucketStatusBadge, { status: 'active', deleteError: null }), locale);
    expect(none.textContent).toContain(words.bucketStatus.active);
  });

  it('names the class of a file, with PDF as it is', async () => {
    const labels: Array<[Parameters<typeof FileKindChip>[0]['file'], string]> = [
      [{ contentType: 'application/pdf' }, 'PDF'],
      [{ contentType: 'image/png' }, words.kind.image],
      [{ name: 'notes.md' }, words.kind.text],
      [{ name: 'deck.pptx' }, words.kind.office],
      [{ contentType: 'application/zip' }, words.kind.other],
    ];
    for (const [file, label] of labels) {
      const chip = await showSubject(h(FileKindChip, { file }), locale);
      expect(chip.textContent).toBe(label);
    }
  });

  it('draws the icon of a file as decoration', async () => {
    const icon = await showSubject(h(FileKindIcon, { file: { contentType: 'application/pdf', name: 'a.pdf' } }), locale);
    expect(icon.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(icon.textContent).toBe('');
  });

  it('says why the write controls are not there', async () => {
    const inline = await showSubject(h(ReadOnlyHint, {}), locale);
    expect(inline.textContent).toContain(words.readOnly.hint);
    expect(inline.querySelector('[role="note"]')).not.toBeNull();
    const banner = await showSubject(h(ReadOnlyHint, { variant: 'banner' }), locale);
    expect(banner.textContent).toContain(words.readOnly.hint);
    expect(banner.querySelector('[role="note"]')).not.toBeNull();
  });

  it('prints a time as words with the exact time behind it, and a dash when there is none', async () => {
    const when = hoursAgo(5);
    const known = await showSubject(h(RelativeTime, { value: when }), locale);
    const time = known.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(new Date(when).toISOString());
    expect(time?.getAttribute('title')).toBeTruthy();
    expect(time?.textContent?.length).toBeGreaterThan(0);

    const none = await showSubject(h(RelativeTime, { value: null }), locale);
    expect(none.textContent).toBe('—');
    const bad = await showSubject(h(RelativeTime, { value: 'not a date', fallback: 'n/a' }), locale);
    expect(bad.textContent).toBe('n/a');
  });

  it('copies a value and says so', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    const copy = await showSubject(h(CopyButton, { value: 'docs/a.pdf' }), locale);
    const button = copy.querySelector<HTMLButtonElement>(`button[aria-label="${words.copy.copy}"]`);
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    await wait(20);
    expect(writeText).toHaveBeenCalledWith('docs/a.pdf');
    expect(document.body.textContent).toContain(words.copy.copied);
  });
});

/* ── saving a download, uploading a file ─────────────────────────────────── */

function stubDownloads() {
  const saved: Array<{ download: string; href: string; blob: Blob }> = [];
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  let counter = 0;
  window.URL.createObjectURL = vi.fn((blob: Blob) => {
    counter += 1;
    const url = `blob:test/${counter}`;
    blobs.set(url, blob);
    return url;
  }) as never;
  window.URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  }) as never;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    saved.push({ download: this.download, href: this.getAttribute('href') ?? '', blob: blobs.get(this.getAttribute('href') ?? '')! });
  });
  return { saved, revoked };
}

describe('saveBlob', () => {
  it('offers the blob as a download and releases the address a little later', () => {
    useFakeClock();
    const { saved, revoked } = stubDownloads();
    const blob = new Blob(['data']);
    saveBlob(blob, 'report.pdf');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.download).toBe('report.pdf');
    expect(saved[0]!.blob).toBe(blob);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(revoked).toEqual(['blob:test/1']);
  });
});

describe('uploadFile', () => {
  it('reads the file into a data URL and sends it with its own name and type', async () => {
    const api = installApiMock([['POST', '/api/files/buckets/docs/objects', () => ({ record: record('notes.txt') })]]);
    const { record: created } = await uploadFile('docs', new File(['hello'], 'notes.txt', { type: 'text/plain' }), {
      folder: 'x/',
      convertToMarkdown: true,
    });
    expect(created.key).toBe('notes.txt');
    const body = api.calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ fileName: 'notes.txt', contentType: 'text/plain', folder: 'x/', convertToMarkdown: true });
    expect(String(body.data)).toMatch(/^data:text\/plain;base64,/);
    expect(atob(String(body.data).split(',')[1]!)).toBe('hello');
  });

  it('sends a file with no type as binary, and a renamed file under its new name', async () => {
    const api = installApiMock([['POST', '/api/files/buckets/docs/objects', () => ({ record: record('x') })]]);
    await uploadFile('docs', new File(['x'], 'blob.bin'), { name: '  renamed.bin ' });
    const body = api.calls[0]!.body as Record<string, unknown>;
    expect(body.fileName).toBe('renamed.bin');
    expect(body.contentType).toBe('application/octet-stream');
    expect(body).not.toHaveProperty('folder');
    expect(body).not.toHaveProperty('convertToMarkdown');
  });
});

/* ── hooks ───────────────────────────────────────────────────────────────── */

describe('useNow', () => {
  const START = Date.parse('2026-03-01T10:00:00.000Z');

  it('renews the time on its interval, renews it at once when switched on, and stands still while off', async () => {
    useFakeClock();
    vi.setSystemTime(START);
    const probe = await renderHookIn(newClient(), () => useNow(30_000, true));
    expect(probe.result.current).toBe(START);

    await advance(29_000);
    expect(probe.result.current).toBe(START);
    await advance(1_000);
    expect(probe.result.current).toBe(START + 30_000);
    await advance(30_000);
    expect(probe.result.current).toBe(START + 60_000);

    const timersWhileOn = vi.getTimerCount();
    await probe.rerender(() => useNow(30_000, false));
    expect(vi.getTimerCount()).toBe(timersWhileOn - 1);
    const stoppedAt = probe.result.current;
    await advance(5 * 60_000);
    expect(probe.result.current).toBe(stoppedAt);

    // switched on again: the value is the present at once, not the present one interval from now
    await probe.rerender(() => useNow(30_000, true));
    expect(probe.result.current).toBe(Date.now());
    expect(probe.result.current).toBeGreaterThan(stoppedAt);
    expect(vi.getTimerCount()).toBe(timersWhileOn);
  });

  it('runs on the interval it was given, and is on unless told otherwise', async () => {
    useFakeClock();
    vi.setSystemTime(START);
    const probe = await renderHookIn(newClient(), () => useNow(1_000));
    await advance(3_000);
    expect(probe.result.current).toBe(START + 3_000);

    // another interval replaces the timer: the next renewal comes that long after the change
    await probe.rerender(() => useNow(10_000));
    const changedAt = Date.now();
    expect(probe.result.current).toBe(changedAt);
    await advance(9_000);
    expect(probe.result.current).toBe(changedAt);
    await advance(1_000);
    expect(probe.result.current).toBe(changedAt + 10_000);
  });
});

describe('useFilesProject', () => {
  it('changes when the app switches project, and drops what the old project cached', async () => {
    const client = newClient();
    client.setQueryData(['files', 'project:stale', 'buckets'], ['left over']);
    client.setQueryData(['providers'], 'keep');

    const probe = await renderHookIn(client, () => useFilesProject());
    const first = probe.result.current;
    expect(first).toBe(getFilesProjectScope());
    expect(client.getQueryData(['files', 'project:stale', 'buckets'])).toBeUndefined();
    expect(client.getQueryData(['providers'])).toBe('keep');

    client.setQueryData(filesKeys.buckets(first), ['cached for the old project']);
    await act(async () => {
      notifyActiveProjectChanged();
    });
    expect(probe.result.current).not.toBe(first);
    expect(probe.result.current).toBe(getFilesProjectScope());
    expect(client.getQueryData(filesKeys.buckets(first))).toBeUndefined();
    expect(client.getQueryData(['providers'])).toBe('keep');
  });

  it('is the same for every component, so they share one cache', async () => {
    const client = newClient();
    const first = await renderHookIn(client, () => useFilesProject());
    const second = await renderHookIn(client, () => useFilesProject());
    expect(second.result.current).toBe(first.result.current);
    await act(async () => {
      notifyActiveProjectChanged();
    });
    expect(second.result.current).toBe(first.result.current);
  });
});

describe('useBuckets', () => {
  it('does not show the old project’s buckets after a switch', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const api = installApiMock([
      [
        'GET',
        '/api/files/buckets',
        async () => {
          call += 1;
          if (call === 1) return { buckets: [bucketView('old-project-bucket')] };
          await gate;
          return { buckets: [bucketView('new-project-bucket')] };
        },
      ],
    ]);
    const probe = await renderHookIn(newClient(), () => useBuckets());
    await until(() => probe.result.current.data !== undefined, 'the first project’s buckets');
    expect(probe.result.current.data?.map((item) => item.key)).toEqual(['old-project-bucket']);

    await act(async () => {
      notifyActiveProjectChanged();
    });
    await wait(10);
    expect(count(api, 'GET', '/api/files/buckets')).toBe(2);
    expect(probe.result.current.data).toBeUndefined();
    expect(probe.result.current.isPending).toBe(true);

    release();
    await until(() => probe.result.current.data !== undefined, 'the second project’s buckets');
    expect(probe.result.current.data?.map((item) => item.key)).toEqual(['new-project-bucket']);
  });

  it('turns a refusal into a FilesApiError the screen can branch on', async () => {
    installApiMock([['GET', '/api/files/buckets', () => jsonResponse({ error: 'Forbidden' }, 403)]]);
    const probe = await renderHookIn(newClient(), () => useBuckets());
    await until(() => probe.result.current.isError, 'the error');
    expect(probe.result.current.error).toMatchObject({ name: 'FilesApiError', status: 403 });
  });
});

describe('useFilesAccess', () => {
  it('allows writing until the engine says otherwise, then follows its level', async () => {
    installApiMock([['GET', '/api/auth/session', () => ({ effectivePermissions: { files: 'read', agents: 'admin' } })]]);
    const probe = await renderHookIn(newClient(), () => useFilesAccess());
    expect(probe.history[0]).toEqual({ level: null, canWrite: true });
    await until(() => probe.result.current.level !== null, 'the permissions');
    expect(probe.result.current).toEqual({ level: 'read', canWrite: false });
  });

  it('lets write and admin change files', async () => {
    for (const level of ['write', 'admin']) {
      installApiMock([['GET', '/api/auth/session', () => ({ effectivePermissions: { files: level } })]]);
      const probe = await renderHookIn(newClient(), () => useFilesAccess());
      await until(() => probe.result.current.level === level, `level ${level}`);
      expect(probe.result.current.canWrite).toBe(true);
    }
  });
});

describe('useObjects', () => {
  it('pages through a folder by cursor and re-lists when the filters change', async () => {
    const api = installApiMock([
      [
        'GET',
        '/api/files/buckets/docs/objects',
        (call) =>
          call.query.cursor === 'c1'
            ? { items: [record('b.pdf')], folders: ['x/', 'y/'] }
            : call.query.search
              ? { items: [record(`found-${call.query.search}.pdf`)], folders: [] }
              : { items: [record('a.pdf'), record('b.pdf')], folders: ['x/'], prefix: '', nextCursor: 'c1' },
      ],
    ]);
    const probe = await renderHookIn(newClient(), () => useObjects('docs', { prefix: '' }));
    await until(() => probe.result.current.data !== undefined, 'the first page');
    expect(probe.result.current.hasNextPage).toBe(true);
    expect(api.calls[0]!.query).toEqual({ prefix: '' });

    await act(async () => {
      await probe.result.current.fetchNextPage();
    });
    expect(api.calls[1]!.query).toEqual({ prefix: '', cursor: 'c1' });
    await until(() => probe.result.current.hasNextPage === false, 'the last page');
    const flat = flattenObjectPages(probe.result.current.data?.pages);
    expect(flat.items.map((item) => item.key)).toEqual(['a.pdf', 'b.pdf']);
    expect(flat.folders).toEqual(['x/', 'y/']);

    await probe.rerender(() => useObjects('docs', { prefix: '', search: ' rep ', type: 'pdf' }));
    await until(() => probe.result.current.data?.pages[0]?.items[0]?.key === 'found-rep.pdf', 'the search results');
    expect(api.calls.at(-1)!.query).toEqual({ prefix: '', search: 'rep', type: 'pdf' });
  });

  it('does not list a bucket it was not given', async () => {
    const api = installApiMock([]);
    const probe = await renderHookIn(newClient(), () => useObjects(null, {}));
    await wait(20);
    expect(api.calls).toHaveLength(0);
    expect(probe.result.current.fetchStatus).toBe('idle');
  });
});

describe('the other reads', () => {
  it('reads a file’s text only when asked to, and the providers and limits of the project', async () => {
    const api = installApiMock([
      ['GET', '/api/files/buckets/docs/objects/a.md', () => new Response('# Title', { status: 200, headers: { 'Content-Type': 'text/plain' } })],
      ['GET', '/api/files/providers', () => ({ providers: [{ key: 'local', providerHealth: { state: 'builtin' }, storageLocationBase: null }] })],
      ['GET', '/api/files/limits', () => ({ maxFileBytes: 5, maxRequestBytes: 9, allowedMimeTypes: null, quota: { usedBytes: 0, limitBytes: null, filesUsed: 0, filesLimit: null } })],
    ]);
    const probe = await renderHookIn(newClient(), () => ({
      text: useObjectText('docs', 'a.md', 'markdown', { enabled: false }),
      providers: useFileProviders(),
      limits: useFilesLimits({ bucketKey: 'docs' }),
    }));
    await until(() => probe.result.current.providers.data !== undefined && probe.result.current.limits.data !== undefined, 'providers and limits');
    expect(api.to('GET', '/api/files/limits')[0]!.query).toEqual({ bucketKey: 'docs' });
    expect(probe.result.current.providers.data?.[0]?.key).toBe('local');
    expect(probe.result.current.limits.data?.maxFileBytes).toBe(5);
    expect(count(api, 'GET', '/api/files/buckets/docs/objects/a.md')).toBe(0);

    await probe.rerender(() => ({
      text: useObjectText('docs', 'a.md', 'markdown', { enabled: true }),
      providers: useFileProviders(),
      limits: useFilesLimits({ bucketKey: 'docs' }),
    }));
    await until(() => probe.result.current.text.data === '# Title', 'the text');
    expect(api.to('GET', '/api/files/buckets/docs/objects/a.md')[0]!.query).toEqual({ variant: 'markdown', preview: '1' });
  });
});

describe('mutations refresh what they change', () => {
  /** A bucket page and a list mounted together, the way the screens keep them. */
  async function mountBucketPage(api: ApiMock) {
    const client = newClient();
    const probe = await renderHookIn(client, () => ({
      list: useBuckets(),
      detail: useBucket('docs'),
      objects: useObjects('docs', { prefix: '' }),
      record: useObject('docs', 'a.pdf'),
      limits: useFilesLimits({ bucketKey: 'docs' }),
      update: useUpdateBucket(),
      deleteBucket: useDeleteBucket(),
      upload: useUploadObject(),
      deleteObject: useDeleteObject(),
      batchDelete: useBatchDeleteObjects(),
      convert: useConvertObject(),
      importFromStorage: useImportFromStorage(),
      testProvider: useTestFileProvider(),
      providers: useFileProviders(),
    }));
    await until(
      () => {
        const r = probe.result.current;
        return Boolean(r.list.data && r.detail.data && r.objects.data && r.record.data && r.limits.data && r.providers.data);
      },
      'the first reads',
    );
    // one read of each so far
    expect(count(api, 'GET', '/api/files/buckets')).toBe(1);
    expect(count(api, 'GET', '/api/files/buckets/docs')).toBe(1);
    expect(count(api, 'GET', '/api/files/buckets/docs/objects')).toBe(1);
    expect(count(api, 'GET', '/api/files/buckets/docs/objects/a.pdf')).toBe(1);
    return { client, probe };
  }

  const readRoutes = (): Array<[string, string | RegExp, RouteHandler]> => [
    ['GET', '/api/files/buckets', () => ({ buckets: [bucketView('docs')] })],
    ['GET', '/api/files/buckets/docs', () => ({ bucket: bucketDetail('docs') })],
    ['GET', '/api/files/buckets/docs/objects', () => ({ items: [record('a.pdf')], folders: [] })],
    ['GET', '/api/files/buckets/docs/objects/a.pdf', () => ({ record: record('a.pdf') })],
    ['GET', '/api/files/limits', () => ({ maxFileBytes: 5, maxRequestBytes: 9, allowedMimeTypes: null, quota: { usedBytes: 0, limitBytes: null, filesUsed: 0, filesLimit: null } })],
    ['GET', '/api/files/providers', () => ({ providers: [] })],
  ];

  it('renaming a bucket refreshes the bucket and the list, not its files', async () => {
    const api = installApiMock([...readRoutes(), ['PATCH', '/api/files/buckets/docs', () => ({ bucket: bucketView('docs', { name: 'New' }) })]]);
    const { probe } = await mountBucketPage(api);
    await act(async () => {
      await probe.result.current.update.mutateAsync({ bucketKey: 'docs', patch: { name: 'New' } });
    });
    expect(api.to('PATCH', '/api/files/buckets/docs')[0]!.body).toEqual({ name: 'New' });
    expect(count(api, 'GET', '/api/files/buckets')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs/objects')).toBe(1);
    expect(count(api, 'GET', '/api/files/limits')).toBe(1);
  });

  it('uploading refreshes the files, the stats of the bucket and of the list, and the quota', async () => {
    const api = installApiMock([...readRoutes(), ['POST', '/api/files/buckets/docs/objects', () => ({ record: record('new.pdf') })]]);
    const { probe } = await mountBucketPage(api);
    await act(async () => {
      await probe.result.current.upload.mutateAsync({ bucketKey: 'docs', input: { fileName: 'new.pdf', data: 'data:application/pdf;base64,AA==' } });
    });
    expect(count(api, 'GET', '/api/files/buckets')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs/objects')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs/objects/a.pdf')).toBe(2);
    expect(count(api, 'GET', '/api/files/limits')).toBe(2);
    expect(count(api, 'GET', '/api/files/providers')).toBe(1);
  });

  it('deleting a file refreshes the listing and the stats, and does not ask about the deleted file again', async () => {
    const api = installApiMock([...readRoutes(), ['DELETE', '/api/files/buckets/docs/objects/a.pdf', () => ({ deleted: true })]]);
    const { probe } = await mountBucketPage(api);
    await act(async () => {
      await probe.result.current.deleteObject.mutateAsync({ bucketKey: 'docs', key: 'a.pdf' });
    });
    expect(count(api, 'GET', '/api/files/buckets/docs/objects')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs/objects/a.pdf')).toBe(1);
  });

  it('deleting many files forgets only the ones that were deleted', async () => {
    const api = installApiMock([
      ...readRoutes(),
      ['POST', '/api/files/buckets/docs/objects/batch-delete', () => ({ deleted: ['a.pdf'], failed: [{ key: 'b.pdf', error: 'in use' }] })],
    ]);
    const { probe } = await mountBucketPage(api);
    let outcome: { deleted: string[]; failed: Array<{ key: string; error: string }> } | undefined;
    await act(async () => {
      outcome = await probe.result.current.batchDelete.mutateAsync({ bucketKey: 'docs', keys: ['a.pdf', 'b.pdf'] });
    });
    expect(outcome).toEqual({ deleted: ['a.pdf'], failed: [{ key: 'b.pdf', error: 'in use' }] });
    expect(count(api, 'GET', '/api/files/buckets/docs/objects')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs/objects/a.pdf')).toBe(1);
  });

  it('a bucket that is gone is not asked about again; one that is being deleted is refreshed', async () => {
    const api = installApiMock([
      ...readRoutes(),
      ['DELETE', '/api/files/buckets/docs', (call) => (call.query.deleteFiles ? jsonResponse({ ok: true }, 202) : { ok: true })],
    ]);
    const { probe } = await mountBucketPage(api);

    let outcome: unknown;
    await act(async () => {
      outcome = await probe.result.current.deleteBucket.mutateAsync({ bucketKey: 'docs' });
    });
    expect(outcome).toEqual({ status: 'deleted' });
    expect(count(api, 'GET', '/api/files/buckets')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs')).toBe(1);
    expect(count(api, 'GET', '/api/files/buckets/docs/objects')).toBe(1);

    await act(async () => {
      outcome = await probe.result.current.deleteBucket.mutateAsync({ bucketKey: 'docs', deleteFiles: true });
    });
    expect(outcome).toEqual({ status: 'deleting' });
    expect(api.to('DELETE', '/api/files/buckets/docs')[1]!.query).toEqual({ deleteFiles: 'true' });
    expect(count(api, 'GET', '/api/files/buckets')).toBe(3);
    expect(count(api, 'GET', '/api/files/buckets/docs')).toBe(2);
  });

  it('deletes the bucket alone, or asks again for the files to go too, by what is passed', async () => {
    const api = installApiMock([
      ...readRoutes(),
      ['DELETE', '/api/files/buckets/docs', (call) => (call.query.deleteFiles ? jsonResponse({ ok: true }, 202) : { success: true })],
    ]);
    const { probe } = await mountBucketPage(api);

    let outcome: unknown;
    await act(async () => {
      outcome = await probe.result.current.deleteBucket.mutateAsync({ bucketKey: 'docs', force: true });
    });
    expect(outcome).toEqual({ status: 'deleted' });
    expect(api.to('DELETE', '/api/files/buckets/docs')[0]!.query).toEqual({ force: 'true' });

    // both given: the files go (the server lets that win), and only that is asked for
    await act(async () => {
      outcome = await probe.result.current.deleteBucket.mutateAsync({ bucketKey: 'docs', deleteFiles: true, force: false });
    });
    expect(outcome).toEqual({ status: 'deleting' });
    expect(api.to('DELETE', '/api/files/buckets/docs')[1]!.query).toEqual({ deleteFiles: 'true' });
  });

  it('reads the bucket and the list again when a delete is refused, because the refusal can mean they changed', async () => {
    const refusals = [
      { status: 409, body: { error: 'The bucket is being deleted', code: 'bucket_deleting' } },
      { status: 409, body: { error: 'Another bucket keeps files here', code: 'storage_location_shared' } },
      { status: 503, body: { error: 'The queue is not available', code: 'queue_unavailable' } },
    ];
    let asked = 0;
    const api = installApiMock([
      ...readRoutes(),
      ['DELETE', '/api/files/buckets/docs', () => jsonResponse(refusals[asked]!.body, refusals[asked++]!.status)],
    ]);
    const { probe } = await mountBucketPage(api);

    for (const [index, refusal] of refusals.entries()) {
      await act(async () => {
        await expect(probe.result.current.deleteBucket.mutateAsync({ bucketKey: 'docs', deleteFiles: true })).rejects.toMatchObject({
          name: 'FilesApiError',
          status: refusal.status,
          code: refusal.body.code,
        });
      });
      expect(count(api, 'GET', '/api/files/buckets/docs')).toBe(index + 2);
      expect(count(api, 'GET', '/api/files/buckets')).toBe(index + 2);
    }
    // what is in the bucket did not change, so its files are not listed again
    expect(count(api, 'GET', '/api/files/buckets/docs/objects')).toBe(1);
  });

  it('starting a conversion shows the pending record at once and re-reads it', async () => {
    const api = installApiMock([
      ...readRoutes(),
      ['POST', '/api/files/buckets/docs/convert', () => ({ record: record('a.pdf', { markdownStatus: 'pending' }) })],
    ]);
    const { client, probe } = await mountBucketPage(api);
    await act(async () => {
      await probe.result.current.convert.mutateAsync({ bucketKey: 'docs', key: 'a.pdf' });
    });
    expect(api.to('POST', '/api/files/buckets/docs/convert')[0]!.body).toEqual({ key: 'a.pdf' });
    expect(client.getQueryData<{ markdownStatus: string }>(filesKeys.object(getFilesProjectScope(), 'docs', 'a.pdf'))).toBeDefined();
    expect(count(api, 'GET', '/api/files/buckets/docs/objects/a.pdf')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs/objects')).toBe(2);
  });

  it('an import that found nothing leaves everything as it was; one that found files refreshes them', async () => {
    let imported = 0;
    const api = installApiMock([
      ...readRoutes(),
      ['POST', '/api/files/buckets/docs/import', () => ({ scanned: 10, imported, skipped: 10 - imported })],
    ]);
    const { probe } = await mountBucketPage(api);
    await act(async () => {
      await probe.result.current.importFromStorage.mutateAsync({ bucketKey: 'docs', input: { limit: 10 } });
    });
    expect(count(api, 'GET', '/api/files/buckets/docs/objects')).toBe(1);
    imported = 3;
    await act(async () => {
      await probe.result.current.importFromStorage.mutateAsync({ bucketKey: 'docs' });
    });
    expect(count(api, 'GET', '/api/files/buckets/docs/objects')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets')).toBe(2);
  });

  it('testing a provider refreshes everything that shows its health', async () => {
    const api = installApiMock([
      ...readRoutes(),
      ['POST', '/api/providers/rec-1/test', () => ({ ok: true, latencyMs: 4, message: 'Connected' })],
    ]);
    const { probe } = await mountBucketPage(api);
    await act(async () => {
      await probe.result.current.testProvider.mutateAsync('rec-1');
    });
    expect(count(api, 'GET', '/api/files/buckets')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs')).toBe(2);
    expect(count(api, 'GET', '/api/files/providers')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs/objects')).toBe(1);
  });

  it('lets a screen that uploads file by file refresh once at the end', async () => {
    const api = installApiMock(readRoutes());
    const client = newClient();
    const probe = await renderHookIn(client, () => ({ list: useBuckets(), objects: useObjects('docs', { prefix: '' }), refresh: useFilesInvalidation() }));
    await until(() => Boolean(probe.result.current.list.data && probe.result.current.objects.data), 'the first reads');
    await act(async () => {
      await probe.result.current.refresh.bucketContent('docs');
    });
    expect(count(api, 'GET', '/api/files/buckets')).toBe(2);
    expect(count(api, 'GET', '/api/files/buckets/docs/objects')).toBe(2);
  });
});

describe('downloads', () => {
  it('saves a file under the name the server gave, and a Markdown copy under its derived name otherwise', async () => {
    const { saved } = stubDownloads();
    installApiMock([
      [
        'GET',
        /^\/api\/files\/buckets\/docs\/objects\/.+/,
        (call) =>
          call.path.endsWith('served.pdf')
            ? new Response('pdf', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="Served Name.pdf"' } })
            : new Response('md', { status: 200 }),
      ],
    ]);
    const probe = await renderHookIn(newClient(), () => useDownloadObject());
    await act(async () => {
      await probe.result.current.mutateAsync({ bucketKey: 'docs', key: 'served.pdf', fileName: 'served.pdf' });
    });
    await act(async () => {
      await probe.result.current.mutateAsync({ bucketKey: 'docs', key: 'dir/report.pdf', fileName: 'report.pdf', variant: 'markdown' });
    });
    expect(saved.map((item) => item.download)).toEqual(['Served Name.pdf', markdownFileName('report.pdf')]);
    expect(saved[1]!.download).toBe('report.md');
  });

  it('saves a selection as one zip named after the bucket', async () => {
    const { saved } = stubDownloads();
    const api = installApiMock([
      ['POST', '/api/files/buckets/docs/objects/archive', () => new Response('ZIP', { status: 200, headers: { 'Content-Type': 'application/zip' } })],
    ]);
    const probe = await renderHookIn(newClient(), () => useArchiveObjects());
    await act(async () => {
      await probe.result.current.mutateAsync({ bucketKey: 'docs', keys: ['a.pdf', 'b.pdf'] });
    });
    expect(api.calls[0]!.body).toEqual({ keys: ['a.pdf', 'b.pdf'] });
    expect(saved.map((item) => item.download)).toEqual(['docs-files.zip']);
  });

  it('reports a selection that is too large by its code', async () => {
    stubDownloads();
    installApiMock([['POST', '/api/files/buckets/docs/objects/archive', () => jsonResponse({ error: 'Too large', code: 'archive_too_large' }, 413)]]);
    const probe = await renderHookIn(newClient(), () => useArchiveObjects());
    await act(async () => {
      await probe.result.current.mutateAsync({ bucketKey: 'docs', keys: ['a.pdf'] }).catch(() => undefined);
    });
    await until(() => probe.result.current.error !== null, 'the error');
    expect(probe.result.current.error).toMatchObject({ status: 413, code: 'archive_too_large' });
  });
});

/* ── polling ─────────────────────────────────────────────────────────────── */

interface FastCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

/**
 * A `fetch` whose answers need no event-loop turn (only promise hops), so a fake clock moves everything that
 * depends on it, and a poll that is due has also been answered.
 */
function installFastFetch(handler: (call: FastCall) => { status?: number; body?: unknown }) {
  const calls: FastCall[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const call: FastCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status = 200, body } = handler(call);
    const payload = body === undefined ? '' : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, statusText: '', headers: new Headers(), text: async () => payload } as unknown as Response;
  });
  return calls;
}

const reads = (calls: FastCall[], path: string | RegExp) =>
  calls.filter((call) => call.method === 'GET' && (typeof path === 'string' ? call.path === path : path.test(call.path))).length;

describe('polling', () => {
  const OBJECT = '/api/files/buckets/docs/objects/a.pdf';

  it('asks again while a conversion is pending and stops once it has settled', async () => {
    useFakeClock();
    let answered = 0;
    const calls = installFastFetch(() => ({ body: { record: record('a.pdf', { markdownStatus: ++answered < 3 ? 'pending' : 'succeeded' }) } }));
    const probe = await renderHookIn(newClient(), () => useObject('docs', 'a.pdf'));
    await advance(0);
    expect(reads(calls, OBJECT)).toBe(1);
    expect(probe.result.current.data?.markdownStatus).toBe('pending');
    await advance(1_500);
    expect(reads(calls, OBJECT)).toBe(1);
    await advance(700);
    expect(reads(calls, OBJECT)).toBe(2);
    await advance(2_000);
    expect(reads(calls, OBJECT)).toBe(3);
    expect(probe.result.current.data?.markdownStatus).toBe('succeeded');
    await advance(10 * 60_000);
    expect(reads(calls, OBJECT)).toBe(3);
  });

  it('slows down as a conversion drags on, and gives up on one that never settles', async () => {
    useFakeClock();
    const calls = installFastFetch(() => ({ body: { record: record('a.pdf', { markdownStatus: 'pending' }) } }));
    await renderHookIn(newClient(), () => useObject('docs', 'a.pdf'));
    await advance(0);
    await advance(28_000);
    const firstHalfMinute = reads(calls, OBJECT);
    expect(firstHalfMinute).toBeGreaterThanOrEqual(14);
    expect(firstHalfMinute).toBeLessThanOrEqual(15);

    await advance(60_000);
    const secondStretch = reads(calls, OBJECT) - firstHalfMinute;
    expect(secondStretch).toBeLessThan(firstHalfMinute * 2);
    expect(secondStretch).toBeGreaterThanOrEqual(14);

    await advance(MARKDOWN_POLL_MAX_MS + 30_000);
    const total = reads(calls, OBJECT);
    expect(total).toBeLessThan(70);
    await advance(10 * 60_000);
    expect(reads(calls, OBJECT)).toBe(total);
  });

  it('starts the clock again when another file begins converting', async () => {
    useFakeClock();
    let items = [record('a.pdf', { markdownStatus: 'pending' })];
    const calls = installFastFetch(() => ({ body: { items, folders: [] } }));
    const client = newClient();
    await renderHookIn(client, () => useObjects('docs', { prefix: '' }));
    await advance(0);
    await advance(MARKDOWN_POLL_MAX_MS + 30_000);
    const LISTING = '/api/files/buckets/docs/objects';
    const stopped = reads(calls, LISTING);
    await advance(5 * 60_000);
    expect(reads(calls, LISTING)).toBe(stopped);

    items = [record('a.pdf', { markdownStatus: 'pending' }), record('b.pdf', { markdownStatus: 'pending' })];
    await act(async () => {
      await client.invalidateQueries({ queryKey: filesKeys.objectsOf(getFilesProjectScope(), 'docs') });
    });
    expect(reads(calls, LISTING)).toBe(stopped + 1);
    await advance(2_000);
    expect(reads(calls, LISTING)).toBe(stopped + 2);
    await advance(2_000);
    expect(reads(calls, LISTING)).toBe(stopped + 3);
  });

  it('keeps polling a listing whose pending file is still the same one only until the limit', async () => {
    useFakeClock();
    const calls = installFastFetch(() => ({ body: { items: [record('a.pdf', { markdownStatus: 'pending' })], folders: [] } }));
    const client = newClient();
    await renderHookIn(client, () => useObjects('docs', { prefix: '' }));
    await advance(0);
    await advance(MARKDOWN_POLL_MAX_MS + 30_000);
    const stopped = reads(calls, '/api/files/buckets/docs/objects');
    // a refresh with the very same pending file does not start the clock again
    await act(async () => {
      await client.invalidateQueries({ queryKey: filesKeys.objectsOf(getFilesProjectScope(), 'docs') });
    });
    await advance(60_000);
    expect(reads(calls, '/api/files/buckets/docs/objects')).toBe(stopped + 1);
  });

  it('polls a bucket while it is being deleted and stops when it is gone', async () => {
    useFakeClock();
    let gone = false;
    const calls = installFastFetch(() =>
      gone
        ? { status: 404, body: { error: 'Bucket not found', code: 'bucket_not_found' } }
        : { body: { bucket: bucketDetail('docs', { deleting: true, status: 'disabled' }) } },
    );
    const probe = await renderHookIn(newClient(), () => useBucket('docs'));
    await advance(0);
    await advance(2_000);
    await advance(2_000);
    expect(reads(calls, '/api/files/buckets/docs')).toBe(3);
    gone = true;
    await advance(2_000);
    expect(reads(calls, '/api/files/buckets/docs')).toBe(4);
    expect(probe.result.current.error).toMatchObject({ status: 404, code: 'bucket_not_found' });
    await advance(10 * 60_000);
    expect(reads(calls, '/api/files/buckets/docs')).toBe(4);
  });

  it('polls the list while any bucket is being deleted and stops when none is', async () => {
    useFakeClock();
    let deleting = true;
    const calls = installFastFetch(() => ({ body: { buckets: [bucketView('docs', { deleting }), bucketView('other')] } }));
    await renderHookIn(newClient(), () => useBuckets());
    await advance(0);
    await advance(2_000);
    expect(reads(calls, '/api/files/buckets')).toBe(2);
    deleting = false;
    await advance(2_000);
    expect(reads(calls, '/api/files/buckets')).toBe(3);
    await advance(10 * 60_000);
    expect(reads(calls, '/api/files/buckets')).toBe(3);
  });

  it('starts the clock again when a conversion that looked lost is asked for again', async () => {
    useFakeClock();
    vi.setSystemTime(Date.parse('2026-03-01T10:00:00.000Z'));
    let askedAt = new Date().toISOString();
    const calls = installFastFetch(() => ({ body: { record: record('a.pdf', { markdownStatus: 'pending', updatedAt: askedAt }) } }));
    const client = newClient();
    await renderHookIn(client, () => useObject('docs', 'a.pdf'));
    await advance(0);
    await advance(MARKDOWN_POLL_MAX_MS + 30_000);
    const stopped = reads(calls, OBJECT);
    await advance(5 * 60_000);
    expect(reads(calls, OBJECT)).toBe(stopped);

    // "Convert again": the same file, pending again, asked for now
    askedAt = new Date().toISOString();
    await act(async () => {
      await client.invalidateQueries({ queryKey: filesKeys.object(getFilesProjectScope(), 'docs', 'a.pdf') });
    });
    expect(reads(calls, OBJECT)).toBe(stopped + 1);
    await advance(2_000);
    expect(reads(calls, OBJECT)).toBe(stopped + 2);
    await advance(2_000);
    expect(reads(calls, OBJECT)).toBe(stopped + 3);
  });

  it('starts the clock again when the deletion of a bucket that looked lost is asked for again', async () => {
    useFakeClock();
    vi.setSystemTime(Date.parse('2026-03-01T10:00:00.000Z'));
    let askedAt = new Date().toISOString();
    const calls = installFastFetch(() => ({ body: { bucket: bucketDetail('docs', { deleting: true, status: 'disabled', updatedAt: askedAt }) } }));
    const client = newClient();
    await renderHookIn(client, () => useBucket('docs'));
    await advance(0);
    await advance(DELETE_POLL_MAX_MS + 60_000);
    const stopped = reads(calls, '/api/files/buckets/docs');
    await advance(10 * 60_000);
    expect(reads(calls, '/api/files/buckets/docs')).toBe(stopped);

    // "Delete again": the bucket is marked as deleting once more, which moves its update time
    askedAt = new Date().toISOString();
    await act(async () => {
      await client.invalidateQueries({ queryKey: filesKeys.bucket(getFilesProjectScope(), 'docs') });
    });
    expect(reads(calls, '/api/files/buckets/docs')).toBe(stopped + 1);
    await advance(2_000);
    expect(reads(calls, '/api/files/buckets/docs')).toBe(stopped + 2);
    await advance(2_000);
    expect(reads(calls, '/api/files/buckets/docs')).toBe(stopped + 3);
  });

  it('starts the clock of the list again when any of its buckets is asked to be deleted again', async () => {
    useFakeClock();
    vi.setSystemTime(Date.parse('2026-03-01T10:00:00.000Z'));
    let askedAt = new Date().toISOString();
    const calls = installFastFetch(() => ({ body: { buckets: [bucketView('docs', { deleting: true, updatedAt: askedAt }), bucketView('other')] } }));
    const client = newClient();
    await renderHookIn(client, () => useBuckets());
    await advance(0);
    await advance(DELETE_POLL_MAX_MS + 60_000);
    const stopped = reads(calls, '/api/files/buckets');
    await advance(10 * 60_000);
    expect(reads(calls, '/api/files/buckets')).toBe(stopped);

    askedAt = new Date().toISOString();
    await act(async () => {
      await client.invalidateQueries({ queryKey: filesKeys.buckets(getFilesProjectScope()) });
    });
    expect(reads(calls, '/api/files/buckets')).toBe(stopped + 1);
    await advance(2_000);
    expect(reads(calls, '/api/files/buckets')).toBe(stopped + 2);
  });

  it('does not poll a bucket whose deletion failed, nor a list with no deletion running', async () => {
    useFakeClock();
    const calls = installFastFetch((call) =>
      call.path === '/api/files/buckets'
        ? { body: { buckets: [bucketView('docs', { deleting: false, status: 'disabled', deleteError: 'The provider refused' })] } }
        : { body: { bucket: bucketDetail('docs', { deleting: false, status: 'disabled', deleteError: 'The provider refused' }) } },
    );
    await renderHookIn(newClient(), () => ({ list: useBuckets(), bucket: useBucket('docs') }));
    await advance(0);
    await advance(10 * 60_000);
    expect(reads(calls, '/api/files/buckets')).toBe(1);
    expect(reads(calls, '/api/files/buckets/docs')).toBe(1);
  });

  it('does not poll files whose conversions have all settled', async () => {
    useFakeClock();
    const calls = installFastFetch(() => ({
      body: { items: [record('a.pdf', { markdownStatus: 'succeeded' }), record('b.pdf', { markdownStatus: 'failed' }), record('c.pdf')], folders: [] },
    }));
    await renderHookIn(newClient(), () => useObjects('docs', { prefix: '' }));
    await advance(0);
    await advance(10 * 60_000);
    expect(reads(calls, '/api/files/buckets/docs/objects')).toBe(1);
  });

  it('stops polling a file that disappeared', async () => {
    useFakeClock();
    let gone = false;
    const calls = installFastFetch(() =>
      gone ? { status: 404, body: { error: 'File not found' } } : { body: { record: record('a.pdf', { markdownStatus: 'pending' }) } },
    );
    await renderHookIn(newClient(), () => useObject('docs', 'a.pdf'));
    await advance(0);
    gone = true;
    await advance(2_000);
    const atGone = reads(calls, OBJECT);
    expect(atGone).toBe(2);
    await advance(10 * 60_000);
    expect(reads(calls, OBJECT)).toBe(atGone);
  });
});
