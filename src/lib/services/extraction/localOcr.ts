/**
 * The local OCR engine: Tesseract, run on the CPU by `@cognipeer/to-markdown`, with its language data taken from
 * the `@tesseract.js-data/*` packages that ship with Console. It never downloads anything.
 *
 * The engine is a small interface so another CPU engine can take its place later; only Tesseract exists today.
 */

import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { ocrDefaults, toIsoLanguage, toTesseractLanguage } from './settings';
import type { OcrOptions } from './toMarkdownApi';

const logger = createLogger('extraction:local-ocr');

/** What the engine hands to the converter for one document, and what it had to leave out. */
export interface LocalOcrPlan {
  /** Backend options merged into the converter's `ocr` option. */
  options: Pick<OcrOptions, 'provider' | 'lang' | 'tesseract'>;
  /** Languages that will be read (ISO 639-1). */
  languages: string[];
  warnings: string[];
}

export interface LocalOcrEngine {
  readonly id: 'tesseract';
  /** Prepares the language data for the wanted languages (ISO 639-1 or tesseract codes). */
  prepare(languages: string[]): Promise<LocalOcrPlan>;
}

const DATA_PACKAGE_VARIANT = '4.0.0_best_int';
const TESSDATA_SUBDIR = 'cognipeer-tessdata-v1';

/** Where the bundled language files are copied to: the data volume, or the temp dir when that is not writable. */
function tessdataTargets(): string[] {
  const targets: string[] = [];
  try {
    const dataDir = (getConfig() as unknown as { storage?: { dataDir?: string } } | undefined)?.storage?.dataDir;
    if (dataDir) targets.push(path.resolve(dataDir, 'ocr', 'tessdata-v1'));
  } catch {
    // A configuration without a storage block: the temp dir is the only target.
  }
  targets.push(path.join(os.tmpdir(), TESSDATA_SUBDIR));
  return targets;
}

async function fileSize(file: string): Promise<number | undefined> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

/** The `<lang>.traineddata.gz` the `@tesseract.js-data/<lang>` package ships, when it is installed. */
function bundledTrainedData(tesseractLang: string): string | undefined {
  if (!/^[a-z_]+$/.test(tesseractLang)) return undefined;
  try {
    // Resolved from the working directory: the bundler rewrites a plain `require.resolve`.
    const req = createRequire(path.join(process.cwd(), 'package.json'));
    const manifest = req.resolve(`@tesseract.js-data/${tesseractLang}/package.json`);
    return path.join(path.dirname(manifest), DATA_PACKAGE_VARIANT, `${tesseractLang}.traineddata.gz`);
  } catch {
    return undefined;
  }
}

/** Per process, per target directory and language: the copy that was made (or is being made). */
const copies = new Map<string, Promise<boolean>>();

async function copyOnce(source: string, directory: string, tesseractLang: string): Promise<boolean> {
  const key = `${directory}\u0000${tesseractLang}`;
  const known = copies.get(key);
  if (known) {
    // The target directory may be cleaned (a temp-directory sweep): a copy that is gone is made again.
    if (!(await known.catch(() => false))) return known;
    if ((await fileSize(path.join(directory, `${tesseractLang}.traineddata.gz`))) !== undefined) return known;
    if (copies.get(key) === known) copies.delete(key);
    return copyOnce(source, directory, tesseractLang);
  }
  const work = (async () => {
    const target = path.join(directory, `${tesseractLang}.traineddata.gz`);
    const wanted = await fileSize(source);
    if (wanted === undefined) return false;
    await mkdir(directory, { recursive: true });
    if ((await fileSize(target)) === wanted) return true;
    // Copy beside the target and move it in: a reader never sees half a file, and two processes may do this at once.
    const partial = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await copyFile(source, partial);
      await rename(partial, target);
    } catch (error) {
      await unlink(partial).catch(() => undefined);
      throw error;
    }
    return true;
  })();
  copies.set(key, work);
  try {
    return await work;
  } catch (error) {
    copies.delete(key);
    throw error;
  }
}

export interface TessdataResult {
  /** Directory the converter reads `<lang>.traineddata.gz` from. */
  directory?: string;
  /** Tesseract codes that can be read. */
  languages: string[];
  warnings: string[];
}

/**
 * Makes the language data for `languages` (ISO 639-1 or tesseract codes) readable from one directory.
 * `OCR_TESSDATA_DIR` wins when set: its files are used as they are. Otherwise the data of the bundled packages is
 * copied (once per process) into the data volume. A language without data is dropped with a warning; when none is
 * left, English is read.
 */
export async function ensureLocalTessdata(languages: string[]): Promise<TessdataResult> {
  const warnings: string[] = [];
  const wanted = [...new Set(languages.map(toTesseractLanguage).filter(Boolean))];
  const override = ocrDefaults().tessdataDir.trim();
  const available: string[] = [];
  let directory: string | undefined;

  if (override) {
    directory = path.resolve(override);
    for (const lang of wanted) {
      if (await fileSize(path.join(directory, `${lang}.traineddata.gz`)) !== undefined) available.push(lang);
      else warnings.push(`ocr_language_unavailable: ${toIsoLanguage(lang)}`);
    }
  } else {
    const targets = tessdataTargets();
    for (const lang of wanted) {
      const source = bundledTrainedData(lang);
      if (!source || (await fileSize(source)) === undefined) {
        warnings.push(`ocr_language_unavailable: ${toIsoLanguage(lang)}`);
        continue;
      }
      let copied = false;
      for (const candidate of directory ? [directory] : targets) {
        try {
          copied = await copyOnce(source, candidate, lang);
          if (copied) {
            directory = candidate;
            break;
          }
        } catch (error) {
          logger.warn('The OCR language data could not be copied', {
            directory: candidate,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (copied) available.push(lang);
      else warnings.push(`ocr_language_unavailable: ${toIsoLanguage(lang)}`);
    }
  }

  if (available.length === 0) {
    // Nothing asked for can be read: English, when it can.
    if (!wanted.includes('eng')) {
      const fallback = await ensureLocalTessdata(['eng']);
      return { directory: fallback.directory, languages: fallback.languages, warnings: [...warnings, ...fallback.warnings] };
    }
    return { directory, languages: [], warnings };
  }
  return { directory, languages: available, warnings };
}

/** For tests: forget the copies this process has made. */
export function resetLocalTessdataForTests(): void {
  copies.clear();
}

export const tesseractEngine: LocalOcrEngine = {
  id: 'tesseract',
  async prepare(languages) {
    const data = await ensureLocalTessdata(languages);
    if (!data.directory || data.languages.length === 0) {
      throw new Error('The local OCR engine has no language data to read with.');
    }
    return {
      options: {
        provider: 'tesseract',
        lang: data.languages.join('+'),
        tesseract: { langPath: data.directory, offline: true },
      },
      languages: data.languages.map(toIsoLanguage),
      warnings: data.warnings,
    };
  },
};

/** The CPU engine used when an OCR setting names no model. */
export function getLocalOcrEngine(): LocalOcrEngine {
  return tesseractEngine;
}

/* ── Documents at once ────────────────────────────────────────────────────── */

let running = 0;
const waiting: Array<() => void> = [];

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('The OCR wait was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Runs `work` while holding one of the node's `OCR_LOCAL_MAX_DOCS` slots for local OCR documents. Waiting for a
 * slot ends when `signal` aborts.
 */
export async function withLocalOcrSlot<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  const limit = ocrDefaults().localMaxDocs;
  if (running >= limit) {
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        reject(abortReason(signal!));
      };
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.push(grant);
    });
  } else {
    running += 1;
  }
  // `running` was already counted for a waiter that is granted: the slot is handed over, not released and retaken.
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
}
