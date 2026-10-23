/**
 * "Import from storage" is a scan the server does a page at a time (`POST /files/buckets/:key/import` answers with
 * a `nextCursor` until the whole prefix has been read). This is the loop around it, as a pure function over an
 * injected step so the counts, the stop button and a resume after a failure are tested without a server.
 */

import { isFilesApiError, type ImportInput, type ImportFromStorageResult } from '../filesApi';

/** Objects read per request (the server's default; its largest is 500). */
export const IMPORT_PAGE_SIZE = 200;
/** A scan that has not ended after this many requests is stopped: the cursor is not getting anywhere. */
export const MAX_IMPORT_PAGES = 5000;

export interface ImportProgress {
  /** Requests made so far. */
  pages: number;
  scanned: number;
  imported: number;
  skipped: number;
  /** Where the next request continues; absent at the start and once the scan has ended. */
  cursor?: string;
}

export const EMPTY_IMPORT_PROGRESS: ImportProgress = { pages: 0, scanned: 0, imported: 0, skipped: 0 };

/** The progress after one more answer. */
export function addImportPage(progress: ImportProgress, page: ImportFromStorageResult): ImportProgress {
  return {
    pages: progress.pages + 1,
    scanned: progress.scanned + page.scanned,
    imported: progress.imported + page.imported,
    skipped: progress.skipped + page.skipped,
    ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
  };
}

export type ImportOutcome = 'done' | 'stopped' | 'failed';

/**
 * Whether a second try of a failed step is worth offering. Another bucket using the storage location is the one
 * refusal that is a standing fact of the bucket's setup and not a moment: asking again answers the same until that
 * other bucket is gone, so the dialog tells the person and offers to close. Anything else - a lost connection, the
 * storage having a bad moment, a scan that was still running, a bucket switched off in the meantime - can be gone on
 * the next try, and the scan goes on from where it stopped.
 */
export function canRetryImport(error: unknown): boolean {
  return !(isFilesApiError(error) && error.code === 'storage_location_shared');
}

export interface ImportRun {
  outcome: ImportOutcome;
  /** What was done, also when the run did not finish: a resume passes it back as `from`. */
  progress: ImportProgress;
  /** The failure of the request that ended a `failed` run. */
  error?: unknown;
}

/**
 * Runs the scan to its end. `shouldStop` is asked before each request (the Stop button); a request that fails ends
 * the run as `failed` with the progress made. Never throws.
 */
export async function runImportScan(options: {
  step: (input: ImportInput) => Promise<ImportFromStorageResult>;
  /** Continue a run that stopped or failed. */
  from?: ImportProgress;
  shouldStop?: () => boolean;
  onProgress?: (progress: ImportProgress) => void;
}): Promise<ImportRun> {
  let progress = options.from ?? EMPTY_IMPORT_PROGRESS;
  for (;;) {
    if (options.shouldStop?.()) return { outcome: 'stopped', progress };
    if (progress.pages >= MAX_IMPORT_PAGES) {
      return { outcome: 'failed', progress, error: new Error('The scan did not reach its end.') };
    }
    let page: ImportFromStorageResult;
    try {
      page = await options.step({ ...(progress.cursor ? { cursor: progress.cursor } : {}), limit: IMPORT_PAGE_SIZE });
    } catch (error) {
      return { outcome: 'failed', progress, error };
    }
    const next = addImportPage(progress, page);
    options.onProgress?.(next);
    if (!page.nextCursor) return { outcome: 'done', progress: next };
    if (page.nextCursor === progress.cursor) {
      return { outcome: 'failed', progress: next, error: new Error('The scan did not advance.') };
    }
    progress = next;
  }
}
