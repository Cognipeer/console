/**
 * The local OCR engine's language data (`services/extraction/localOcr`) with the REAL `@tesseract.js-data/*` packages:
 * copied once into the data volume, replaceable with OCR_TESSDATA_DIR, unsupported languages dropped with a warning.
 * Also the node-wide limit on local OCR documents.
 */
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));

vi.mock('@/lib/core/config', () => ({ getConfig: () => hoisted.config }));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import {
  ensureLocalTessdata,
  getLocalOcrEngine,
  resetLocalTessdataForTests,
  withLocalOcrSlot,
} from '@/lib/services/extraction/localOcr';

const PACKAGES = path.join(process.cwd(), 'node_modules', '@tesseract.js-data');
const bundled = (lang: string) => path.join(PACKAGES, lang, '4.0.0_best_int', `${lang}.traineddata.gz`);

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'tessdata-test-'));
  hoisted.config = { storage: { dataDir }, ocr: {} };
  resetLocalTessdataForTests();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the bundled language data', () => {
  it('is installed with the application', () => {
    expect(statSync(bundled('tur')).size).toBeGreaterThan(1_000_000);
    expect(statSync(bundled('eng')).size).toBeGreaterThan(1_000_000);
  });

  it('is copied once into the data volume and read from there', async () => {
    const first = await ensureLocalTessdata(['tr', 'en']);

    const directory = path.join(dataDir, 'ocr', 'tessdata-v1');
    expect(first).toEqual({ directory, languages: ['tur', 'eng'], warnings: [] });
    expect(readdirSync(directory).sort()).toEqual(['eng.traineddata.gz', 'tur.traineddata.gz']);
    expect(statSync(path.join(directory, 'tur.traineddata.gz')).size).toBe(statSync(bundled('tur')).size);
    // A copy, not a link: the volume must not depend on node_modules staying put.
    expect(statSync(path.join(directory, 'tur.traineddata.gz')).ino).not.toBe(statSync(bundled('tur')).ino);

    const stamp = statSync(path.join(directory, 'tur.traineddata.gz')).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await ensureLocalTessdata(['tur']);
    expect(again.directory).toBe(directory);
    expect(statSync(path.join(directory, 'tur.traineddata.gz')).mtimeMs).toBe(stamp);

    // Even a process that forgot its copies finds the file in place and leaves it alone.
    resetLocalTessdataForTests();
    await ensureLocalTessdata(['tur']);
    expect(statSync(path.join(directory, 'tur.traineddata.gz')).mtimeMs).toBe(stamp);
  });

  it('is found from a working directory below the install, and reported missing outside of it', async () => {
    const root = process.cwd();
    const cwd = vi.spyOn(process, 'cwd');
    try {
      cwd.mockReturnValue(path.join(root, 'src', 'lib'));
      expect((await ensureLocalTessdata(['tr'])).languages).toEqual(['tur']);

      resetLocalTessdataForTests();
      cwd.mockReturnValue(dataDir);
      const outside = await ensureLocalTessdata(['tr']);
      expect(outside.languages).toEqual([]);
      expect(outside.warnings).toEqual(expect.arrayContaining(['ocr_language_unavailable: tr']));
    } finally {
      cwd.mockRestore();
    }
  });

  it('copies a file again when a clean-up removed it from the target directory', async () => {
    const first = await ensureLocalTessdata(['tr']);
    const file = path.join(first.directory!, 'tur.traineddata.gz');
    rmSync(file);

    const again = await ensureLocalTessdata(['tr']);

    expect(again.directory).toBe(first.directory);
    expect(statSync(file).size).toBe(statSync(bundled('tur')).size);
  });

  it('leaves no partial file behind and survives two requests at once', async () => {
    const [a, b] = await Promise.all([ensureLocalTessdata(['tr']), ensureLocalTessdata(['tr', 'en'])]);

    expect(a.languages).toEqual(['tur']);
    expect(b.languages).toEqual(['tur', 'eng']);
    expect(readdirSync(path.join(dataDir, 'ocr', 'tessdata-v1')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('falls back to the temp directory when the data volume cannot be written', async () => {
    const blocker = path.join(dataDir, 'not-a-directory');
    writeFileSync(blocker, 'x');
    hoisted.config = { storage: { dataDir: path.join(blocker, 'below') }, ocr: {} };

    const result = await ensureLocalTessdata(['en']);

    expect(result.directory).toBe(path.join(tmpdir(), 'cognipeer-tessdata-v1'));
    expect(result.languages).toEqual(['eng']);
  });

  it('works with a configuration that has no storage block', async () => {
    hoisted.config = {};
    const result = await ensureLocalTessdata(['en']);
    expect(result.directory).toBe(path.join(tmpdir(), 'cognipeer-tessdata-v1'));
  });
});

describe('OCR_TESSDATA_DIR', () => {
  it('replaces the bundled data: its files are used as they are, nothing is copied', async () => {
    const own = mkdtempSync(path.join(tmpdir(), 'own-tessdata-'));
    try {
      writeFileSync(path.join(own, 'tur.traineddata.gz'), 'not really data');
      writeFileSync(path.join(own, 'deu.traineddata.gz'), 'not really data');
      hoisted.config = { storage: { dataDir }, ocr: { tessdataDir: own } };

      const result = await ensureLocalTessdata(['tr', 'de', 'en']);

      expect(result).toEqual({ directory: own, languages: ['tur', 'deu'], warnings: ['ocr_language_unavailable: en'] });
      expect(readdirSync(own).sort()).toEqual(['deu.traineddata.gz', 'tur.traineddata.gz']);
      expect(readdirSync(dataDir)).toEqual([]);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('languages without data', () => {
  it('are dropped with a warning while the others are read', async () => {
    const result = await ensureLocalTessdata(['de', 'tr']);
    expect(result.languages).toEqual(['tur']);
    expect(result.warnings).toEqual(['ocr_language_unavailable: de']);
  });

  it('leave English when none of the asked languages can be read', async () => {
    const result = await ensureLocalTessdata(['de', 'fr']);
    expect(result.languages).toEqual(['eng']);
    expect(result.warnings).toEqual(['ocr_language_unavailable: de', 'ocr_language_unavailable: fr']);
  });

  it('are an error of the engine only when not even English exists', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'empty-tessdata-'));
    try {
      hoisted.config = { storage: { dataDir }, ocr: { tessdataDir: empty } };
      await expect(getLocalOcrEngine().prepare(['tr'])).rejects.toThrow(/no language data/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('do not let a name escape the package scope', async () => {
    const result = await ensureLocalTessdata(['../../etc/passwd']);
    expect(result.languages).toEqual(['eng']);
  });
});

describe('the Tesseract engine', () => {
  it('builds the offline converter options for the languages', async () => {
    const plan = await getLocalOcrEngine().prepare(['tr', 'en']);

    expect(getLocalOcrEngine().id).toBe('tesseract');
    expect(plan.options).toEqual({
      provider: 'tesseract',
      lang: 'tur+eng',
      tesseract: { langPath: path.join(dataDir, 'ocr', 'tessdata-v1'), offline: true },
    });
    expect(plan.languages).toEqual(['tr', 'en']);
    expect(plan.warnings).toEqual([]);
  });
});

describe('the limit on local OCR documents', () => {
  const gate = () => {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    return { open, release };
  };

  it('lets one document at a time through by default and then the next', async () => {
    const order: string[] = [];
    const first = gate();
    const a = withLocalOcrSlot(undefined, async () => {
      order.push('a start');
      await first.open;
      order.push('a end');
    });
    const b = withLocalOcrSlot(undefined, async () => {
      order.push('b start');
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['a start']);
    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a start', 'a end', 'b start']);
  });

  it('lets as many through as the configuration says', async () => {
    hoisted.config = { ocr: { localMaxDocs: 2 } };
    let running = 0;
    let peak = 0;
    const work = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
    };
    await Promise.all([1, 2, 3, 4].map(() => withLocalOcrSlot(undefined, work)));
    expect(peak).toBe(2);
  });

  it('frees the slot when the work fails', async () => {
    await expect(withLocalOcrSlot(undefined, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withLocalOcrSlot(undefined, async () => 'next')).resolves.toBe('next');
  });

  it('stops waiting for a slot when the caller aborts, and keeps the slot of the document that holds it', async () => {
    const holder = gate();
    const held = withLocalOcrSlot(undefined, () => holder.open);
    const controller = new AbortController();
    let ran = false;
    const waiting = withLocalOcrSlot(controller.signal, async () => { ran = true; });

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(ran).toBe(false);

    // The third document still has to wait for the holder.
    let third = false;
    const next = withLocalOcrSlot(undefined, async () => { third = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(third).toBe(false);
    holder.release();
    await Promise.all([held, next]);
    expect(third).toBe(true);
  });

  it('does not wait at all for a signal that has aborted already', async () => {
    const holder = gate();
    const held = withLocalOcrSlot(undefined, () => holder.open);
    const controller = new AbortController();
    controller.abort();
    await expect(withLocalOcrSlot(controller.signal, async () => 1)).rejects.toMatchObject({ name: 'AbortError' });
    holder.release();
    await held;
  });
});
