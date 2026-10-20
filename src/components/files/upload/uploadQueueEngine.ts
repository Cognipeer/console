/**
 * The upload queue's engine: the rows, and a scheduler that sends at most `concurrency` files at a time.
 * Plain TypeScript with a subscribe/snapshot pair, so the React hook is a few lines (`useUploadQueue`) and the
 * scheduling rules (bounded concurrency, retry, abort, one "run finished" per run) are tested without a DOM.
 *
 * A *run* starts when rows are handed over with `start()` and ends when nothing is uploading or waiting any more;
 * `handlers.onSettled` is called once per run with the records the server created in it.
 */

import type { FileRecordView } from '@/lib/services/files';
import { uploadFile, type UploadFileOptions, type UploadObjectResult } from '../filesApi';
import { fileIdentity, MAX_QUEUE_FILES, UPLOAD_CONCURRENCY, type QueueItem } from './uploadModel';

export type UploadFn = (bucketKey: string, file: File, options: UploadFileOptions) => Promise<UploadObjectResult>;

/** What a run sends its files with; chosen when the run starts, fixed for the files in it. */
export interface RunSettings {
  /** `''` is the bucket root, otherwise no leading slash and one trailing slash. */
  folder: string;
  convertToMarkdown: boolean;
}

export interface RunResult {
  /** The records the server created during the run (failed and cancelled files are not in it). */
  records: FileRecordView[];
  failed: number;
}

export interface QueueHandlers {
  /** The sentence a failed row shows. */
  describeError(error: unknown, item: QueueItem): string;
  /** A run finished. Called once per run, with the records it created. */
  onSettled(result: RunResult): void;
}

export interface AddResult {
  added: number;
  /** Files that were already in the list. */
  duplicates: number;
  /** Files that did not fit in the batch (`MAX_QUEUE_FILES`). */
  overflow: number;
}

export interface UploadQueueOptions {
  bucketKey: string;
  handlers: QueueHandlers;
  /** Replaces the real upload call (tests). */
  upload?: UploadFn;
  concurrency?: number;
  maxFiles?: number;
}

export class UploadQueueEngine {
  /** Read at the moment a row finishes, so a caller can keep it pointing at its latest closures. */
  handlers: QueueHandlers;

  private items: readonly QueueItem[] = [];
  private readonly listeners = new Set<() => void>();
  private waiting: string[] = [];
  private readonly settingsById = new Map<string, RunSettings>();
  private readonly running = new Map<string, AbortController>();
  private runOpen = false;
  private runRecords: FileRecordView[] = [];
  private runFailures = 0;
  private counter = 0;

  private readonly bucketKey: string;
  private readonly upload: UploadFn;
  private readonly concurrency: number;
  private readonly maxFiles: number;

  constructor(options: UploadQueueOptions) {
    this.bucketKey = options.bucketKey;
    this.handlers = options.handlers;
    this.upload = options.upload ?? uploadFile;
    this.concurrency = Math.max(1, options.concurrency ?? UPLOAD_CONCURRENCY);
    this.maxFiles = options.maxFiles ?? MAX_QUEUE_FILES;
  }

  /* ── The store ─────────────────────────────────────────────────────────── */

  getSnapshot = (): readonly QueueItem[] => this.items;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private commit(next: readonly QueueItem[]): void {
    this.items = next;
    this.listeners.forEach((listener) => listener());
  }

  private patch(id: string, changes: Partial<QueueItem>): void {
    if (!this.items.some((item) => item.id === id)) return;
    this.commit(this.items.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }

  private find(id: string): QueueItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  /** Some row is uploading or waiting for its turn. */
  get busy(): boolean {
    return this.running.size > 0 || this.waiting.length > 0;
  }

  /* ── The rows ──────────────────────────────────────────────────────────── */

  /**
   * Adds files as ready rows. A file that is already in the list (same name, size and modification time) is
   * skipped, and so is whatever does not fit in the batch: rows that are not uploaded yet count against the
   * cap, uploaded ones do not.
   */
  add(files: readonly File[]): AddResult {
    const open = this.items.filter((item) => item.status !== 'done');
    const known = new Set(open.map((item) => fileIdentity(item.file)));
    let room = Math.max(0, this.maxFiles - open.length);
    const added: QueueItem[] = [];
    let duplicates = 0;
    let overflow = 0;
    for (const file of files) {
      const identity = fileIdentity(file);
      if (known.has(identity)) {
        duplicates += 1;
        continue;
      }
      if (room <= 0) {
        overflow += 1;
        continue;
      }
      known.add(identity);
      room -= 1;
      this.counter += 1;
      added.push({ id: `upload-${this.counter}`, file, name: file.name, contentType: '', status: 'queued', waiting: false, progress: 0 });
    }
    if (added.length > 0) this.commit([...this.items, ...added]);
    return { added: added.length, duplicates, overflow };
  }

  /** Takes a row out of the list; an upload in flight is cancelled. A stored file stays stored. */
  remove(id: string): void {
    this.running.get(id)?.abort();
    this.waiting = this.waiting.filter((waitingId) => waitingId !== id);
    this.settingsById.delete(id);
    this.commit(this.items.filter((item) => item.id !== id));
    this.settleIfIdle();
  }

  /** Renames a row that has not been sent (or whose send failed). */
  rename(id: string, name: string): void {
    const item = this.find(id);
    if (!item || item.waiting || (item.status !== 'queued' && item.status !== 'failed')) return;
    this.patch(id, { name });
  }

  setContentType(id: string, contentType: string): void {
    const item = this.find(id);
    if (!item || item.waiting || (item.status !== 'queued' && item.status !== 'failed')) return;
    this.patch(id, { contentType });
  }

  /* ── The run ───────────────────────────────────────────────────────────── */

  /**
   * Hands rows to the scheduler. Only rows that are queued or failed and not already waiting are taken (a failed
   * row starts over). Safe to call while a run is going: the rows join it.
   */
  start(ids: readonly string[], settings: RunSettings): void {
    const taken = new Set<string>();
    for (const id of ids) {
      const item = this.find(id);
      if (!item || item.waiting || (item.status !== 'queued' && item.status !== 'failed')) continue;
      taken.add(id);
      this.settingsById.set(id, settings);
      this.waiting.push(id);
    }
    if (taken.size === 0) return;
    this.runOpen = true;
    this.commit(
      this.items.map((item) => (taken.has(item.id) ? { ...item, status: 'queued' as const, waiting: true, progress: 0, error: undefined } : item)),
    );
    this.pump();
  }

  /** Stops everything: running uploads are aborted, waiting rows go back to ready. Nothing is reported as a run. */
  cancelAll(): void {
    const hadWork = this.running.size > 0 || this.waiting.length > 0;
    this.waiting = [];
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    this.settingsById.clear();
    this.runOpen = false;
    this.runRecords = [];
    this.runFailures = 0;
    if (hadWork) {
      this.commit(
        this.items.map((item) =>
          item.status === 'uploading' || item.waiting ? { ...item, status: 'queued' as const, waiting: false, progress: 0 } : item,
        ),
      );
    }
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      const item = this.find(id);
      if (!item || !item.waiting) continue;
      this.launch(item);
    }
    this.settleIfIdle();
  }

  private launch(item: QueueItem): void {
    const settings = this.settingsById.get(item.id) ?? { folder: '', convertToMarkdown: true };
    const controller = new AbortController();
    this.running.set(item.id, controller);
    this.patch(item.id, { status: 'uploading', waiting: false, progress: 0 });

    // The bar moves a percent at a time: a large file reports its progress far more often than that.
    let lastPercent = -1;
    const contentType = item.contentType.trim();
    let call: Promise<UploadObjectResult>;
    try {
      call = this.upload(this.bucketKey, item.file, {
        name: item.name.trim(),
        ...(contentType ? { contentType } : {}),
        convertToMarkdown: settings.convertToMarkdown,
        ...(settings.folder ? { folder: settings.folder } : {}),
        signal: controller.signal,
        onProgress: ({ fraction }) => {
          if (controller.signal.aborted) return;
          const percent = Math.floor(fraction * 100);
          if (percent === lastPercent) return;
          lastPercent = percent;
          this.patch(item.id, { progress: fraction });
        },
      });
    } catch (error) {
      call = Promise.reject(error);
    }

    call
      .then(
        ({ record }) => {
          if (controller.signal.aborted) return;
          this.runRecords.push(record);
          this.patch(item.id, { status: 'done', progress: 1, record, error: undefined });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          this.runFailures += 1;
          let message: string;
          try {
            message = this.handlers.describeError(error, item);
          } catch {
            message = error instanceof Error ? error.message : String(error);
          }
          this.patch(item.id, { status: 'failed', error: message });
        },
      )
      .finally(() => {
        // `cancelAll` already dropped the entry; a removed row's entry goes here.
        if (this.running.get(item.id) === controller) this.running.delete(item.id);
        this.settingsById.delete(item.id);
        this.pump();
      });
  }

  private settleIfIdle(): void {
    if (!this.runOpen || this.running.size > 0 || this.waiting.length > 0) return;
    this.runOpen = false;
    const result: RunResult = { records: this.runRecords, failed: this.runFailures };
    this.runRecords = [];
    this.runFailures = 0;
    this.handlers.onSettled(result);
  }
}
