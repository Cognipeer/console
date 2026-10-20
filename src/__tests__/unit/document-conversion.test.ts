/**
 * What stands between a stored document and the converter library (`services/files/documentConversion`): a ZIP
 * container is measured before any reader opens it, and the PowerPoint reader's working file is taken care of. The
 * library is a stand-in here; the real one is exercised in document-conversion-real.test.ts.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ convert: vi.fn() }));

vi.mock('@cognipeer/to-markdown', () => ({ convertToMarkdown: hoisted.convert }));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import {
  convertDocumentToMarkdown,
  DocumentConversionRefused,
  removePowerPointWorkingFiles,
} from '@/lib/services/files/documentConversion';
import { buildZip, documentOf, filler, MIB } from '../helpers/zipFixtures';

const LIMITS = { maxUnpackedBytes: MIB, maxEntries: 5 };
const BOMB = documentOf(3 * MIB);

let directory: string;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.convert.mockReset();
  hoisted.convert.mockResolvedValue({ markdown: '# converted' });
  directory = mkdtempSync(path.join(tmpdir(), 'document-conversion-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const refusedWith = async (buffer: Buffer, fileName: string, limits = LIMITS) => {
  const error = await convertDocumentToMarkdown(buffer, fileName, { limits }).then(() => undefined, (failure: unknown) => failure);
  expect(error, `${fileName} should be refused`).toBeInstanceOf(DocumentConversionRefused);
  return (error as Error).message;
};

describe('a document that is not read as a container', () => {
  it.each(['notes.txt', 'report.pdf', 'data.json', 'page.html', 'sheet.csv', 'old.doc', 'mail.msg', 'weird.bin'])(
    'is handed to the converter as it is: %s',
    async (fileName) => {
      // Whatever the bytes are: the reader of this name does not open a container.
      const result = await convertDocumentToMarkdown(BOMB, fileName, { limits: LIMITS });

      expect(result).toEqual({ markdown: '# converted' });
      expect(hoisted.convert).toHaveBeenCalledTimes(1);
      expect(hoisted.convert).toHaveBeenCalledWith(BOMB, { fileName });
    },
  );
});

describe('a document that is read as a container', () => {
  it.each(['report.docx', 'slides.pptx', 'book.epub', 'sheet.xlsx', 'sheet.xls', 'bundle.zip', 'REPORT.DOCX', 'Mixed.PpTx'])(
    'is refused before the converter sees it when it unpacks to more than the limit: %s',
    async (fileName) => {
      const message = await refusedWith(BOMB, fileName);

      expect(message).toBe('The document unpacks to more than 1 MB, so it was not converted.');
      expect(hoisted.convert).not.toHaveBeenCalled();
    },
  );

  it('is refused when it has no extension but is a container: the converter would name the type from the content', async () => {
    expect(await refusedWith(BOMB, 'attachment')).toMatch(/unpacks to more than 1 MB/);
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it('is left to the converter when it has no extension and is not a container', async () => {
    await convertDocumentToMarkdown(Buffer.from('plain words'), 'README', { limits: LIMITS });

    expect(hoisted.convert).toHaveBeenCalledTimes(1);
  });

  it('is refused at the product limit: 101 MiB unpacked is more than 100 MB', async () => {
    const error = await convertDocumentToMarkdown(documentOf(101 * MIB), 'big.docx').then(() => undefined, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(DocumentConversionRefused);
    expect((error as Error).message).toBe('The document unpacks to more than 100 MB, so it was not converted.');
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it('is refused when it is made of too many parts', async () => {
    const parts = Array.from({ length: 6 }, (_, index) => ({ name: `p${index}.xml`, data: Buffer.from('x') }));

    expect(await refusedWith(buildZip(parts), 'many.docx')).toBe('The document is made of more than 5 parts, so it was not converted.');
  });

  it('is refused, with why, when it cannot be followed to the end', async () => {
    const message = await refusedWith(buildZip([{ name: 'a.xml', data: filler(10) }], { zip64EndRecord: true }), 'huge.pptx');

    expect(message).toBe('The document could not be checked before conversion (it is a ZIP64 container), so it was not converted.');
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it('is handed to the converter when it is within the limits, and the converter\'s answer is the answer', async () => {
    const small = documentOf(500);

    const result = await convertDocumentToMarkdown(small, 'small.docx', { limits: LIMITS });

    expect(result).toEqual({ markdown: '# converted' });
    expect(hoisted.convert).toHaveBeenCalledWith(small, { fileName: 'small.docx' });
  });

  it('is handed to the converter when it is no container at all: the reader turns it away cheaply', async () => {
    await convertDocumentToMarkdown(Buffer.from('not a zip, just text'), 'renamed.docx', { limits: LIMITS });

    expect(hoisted.convert).toHaveBeenCalledTimes(1);
  });

  it('is not measured when it is a legacy workbook: the spreadsheet reader takes it for what it is', async () => {
    // A compound file (the old .xls format) that happens to hold the bytes of an end record.
    const ole2 = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(200, 1),
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      Buffer.alloc(18, 2),
    ]);

    await convertDocumentToMarkdown(ole2, 'old.xls', { limits: LIMITS });
    await convertDocumentToMarkdown(ole2, 'old.xlsx', { limits: LIMITS });

    expect(hoisted.convert).toHaveBeenCalledTimes(2);
  });

  it('does not let the converter\'s own failure through as a refusal', async () => {
    hoisted.convert.mockRejectedValueOnce(new Error('Failed to convert DOCX: Corrupted zip'));

    const error = await convertDocumentToMarkdown(documentOf(10), 'broken.docx', { limits: LIMITS }).then(() => undefined, (failure: unknown) => failure);

    expect(error).not.toBeInstanceOf(DocumentConversionRefused);
    expect((error as Error).message).toBe('Failed to convert DOCX: Corrupted zip');
  });
});

describe('the PowerPoint reader\'s working file', () => {
  const workingFiles = () => readdirSync(directory).filter((name) => /^temp_pptx_\d+\.zip$/.test(name));

  /** What the library does: writes the document to a file named after the clock, in the working directory. */
  const libraryThatWritesItsWorkingFile = (outcome: 'fails' | 'succeeds') => async (document: Buffer) => {
    writeFileSync(path.join(directory, `temp_pptx_${Date.now()}.zip`), document);
    await new Promise((resolve) => setTimeout(resolve, 12));
    if (outcome === 'fails') throw new Error('Failed to convert PPTX: Unclosed root tag');
    return { markdown: '# slides' };
  };

  it('is removed again when the read fails', async () => {
    hoisted.convert.mockImplementation(libraryThatWritesItsWorkingFile('fails'));
    const document = documentOf(500);

    await expect(convertDocumentToMarkdown(document, 'bad.pptx', { workingDirectory: directory })).rejects.toThrow('Unclosed root tag');

    expect(workingFiles()).toEqual([]);
  });

  it('is removed when a read leaves one even though it succeeded', async () => {
    hoisted.convert.mockImplementation(libraryThatWritesItsWorkingFile('succeeds'));

    const result = await convertDocumentToMarkdown(documentOf(500), 'good.pptx', { workingDirectory: directory });

    expect(result).toEqual({ markdown: '# slides' });
    expect(workingFiles()).toEqual([]);
  });

  it('is looked after for a container without an extension too, which the converter may read as a presentation', async () => {
    hoisted.convert.mockImplementation(libraryThatWritesItsWorkingFile('fails'));

    await expect(convertDocumentToMarkdown(documentOf(500), 'attachment', { workingDirectory: directory })).rejects.toThrow();

    expect(workingFiles()).toEqual([]);
  });

  it('leaves another file alone: one with other bytes, or another name', async () => {
    const neighbour = 'a different document, being read by someone else';
    let other = '';
    // The other file is written from inside the read, one millisecond after the read's own file: a name inside the
    // window of the read (it lasts a dozen milliseconds), and never the one the read writes, whatever the clock does.
    hoisted.convert.mockImplementation(async (document: Buffer) => {
      const stamp = Date.now();
      writeFileSync(path.join(directory, `temp_pptx_${stamp}.zip`), document);
      other = path.join(directory, `temp_pptx_${stamp + 1}.zip`);
      writeFileSync(other, neighbour);
      await new Promise((resolve) => setTimeout(resolve, 12));
      throw new Error('Failed to convert PPTX: Unclosed root tag');
    });
    writeFileSync(path.join(directory, 'temp_pptx_notanumber.zip'), 'x');
    writeFileSync(path.join(directory, 'keep.zip'), 'x');
    mkdirSync(path.join(directory, `temp_pptx_${Date.now()}.zip.d`));

    await expect(convertDocumentToMarkdown(documentOf(500), 'bad.pptx', { workingDirectory: directory })).rejects.toThrow();

    expect(other).not.toBe('');
    expect(readFileSync(other, 'utf8')).toBe(neighbour);
    expect(readdirSync(directory)).toEqual(expect.arrayContaining(['keep.zip', 'temp_pptx_notanumber.zip', path.basename(other)]));
    // The read's own file is the one that went.
    expect(workingFiles()).toEqual([path.basename(other)]);
  });

  it('is not shared: two presentations are read one after the other', async () => {
    let inFlight = 0;
    let peak = 0;
    // Every read stays in the converter until the test lets it go, so how many are inside at once does not depend on timing.
    const gates: Array<() => void> = [];
    hoisted.convert.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight -= 1;
      return { markdown: '# slides' };
    });
    const document = documentOf(100);

    const reads = ['a.pptx', 'b.pptx', 'c.pptx', 'd.pptx'].map((name) => convertDocumentToMarkdown(document, name, { workingDirectory: directory }));

    for (let reached = 1; reached <= 4; reached += 1) {
      await vi.waitFor(() => expect(gates).toHaveLength(reached), { timeout: 5000 });
      // Room for a second read to get in, were it allowed to.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(hoisted.convert).toHaveBeenCalledTimes(reached);
      gates[reached - 1]();
    }
    await Promise.all(reads);

    expect(hoisted.convert).toHaveBeenCalledTimes(4);
    expect(peak).toBe(1);
  });

  it('does not hold up the other formats: a presentation being read does not make a Word file wait', async () => {
    // Every read stays in the converter until all three are inside it: a lane that made one wait for another would
    // never get there.
    let release!: () => void;
    const allInside = new Promise<void>((resolve) => { release = resolve; });
    let inside = 0;
    hoisted.convert.mockImplementation(async () => {
      inside += 1;
      if (inside === 3) release();
      await allInside;
      return { markdown: '# x' };
    });
    const document = documentOf(100);

    const reads = Promise.all([
      convertDocumentToMarkdown(document, 'slides.pptx', { workingDirectory: directory }),
      convertDocumentToMarkdown(document, 'letter.docx'),
      convertDocumentToMarkdown(document, 'notes.txt'),
    ]);

    await vi.waitFor(() => expect(inside).toBe(3), { timeout: 5000 });
    release();
    await reads;
  });

  it('goes on after a read that failed: the next one is not left waiting for it', async () => {
    let failFirst!: (error: Error) => void;
    hoisted.convert
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockResolvedValueOnce({ markdown: '# second' });
    const document = documentOf(100);

    const first = convertDocumentToMarkdown(document, 'one.pptx', { workingDirectory: directory });
    // The second is asked for while the first is under way, so it is the one that waits for it.
    await vi.waitFor(() => expect(hoisted.convert).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const second = convertDocumentToMarkdown(document, 'two.pptx', { workingDirectory: directory });
    const failure = expect(first).rejects.toThrow('first one fails');
    failFirst(new Error('first one fails'));

    await failure;
    await expect(second).resolves.toEqual({ markdown: '# second' });
    expect(hoisted.convert).toHaveBeenCalledTimes(2);
  });

  it('is never looked for when the document is refused', async () => {
    await expect(convertDocumentToMarkdown(BOMB, 'bomb.pptx', { limits: LIMITS, workingDirectory: path.join(directory, 'missing') })).rejects.toBeInstanceOf(DocumentConversionRefused);

    expect(hoisted.convert).not.toHaveBeenCalled();
  });
});

describe('removePowerPointWorkingFiles', () => {
  const content = Buffer.from('the document');
  const names = () => readdirSync(directory).sort();

  it('removes the file whose name carries a time inside the window and whose bytes are the document\'s', async () => {
    writeFileSync(path.join(directory, 'temp_pptx_1500.zip'), content);

    await removePowerPointWorkingFiles(directory, { from: 1000, to: 2000 }, content);

    expect(names()).toEqual([]);
  });

  it('takes the ends of the window as inside', async () => {
    writeFileSync(path.join(directory, 'temp_pptx_1000.zip'), content);
    writeFileSync(path.join(directory, 'temp_pptx_2000.zip'), content);

    await removePowerPointWorkingFiles(directory, { from: 1000, to: 2000 }, content);

    expect(names()).toEqual([]);
  });

  it('leaves a file from another time, however alike', async () => {
    writeFileSync(path.join(directory, 'temp_pptx_999.zip'), content);
    writeFileSync(path.join(directory, 'temp_pptx_2001.zip'), content);

    await removePowerPointWorkingFiles(directory, { from: 1000, to: 2000 }, content);

    expect(names()).toEqual(['temp_pptx_2001.zip', 'temp_pptx_999.zip']);
  });

  it('leaves a file with other bytes, of the same size or not', async () => {
    writeFileSync(path.join(directory, 'temp_pptx_1100.zip'), 'the documenT');
    writeFileSync(path.join(directory, 'temp_pptx_1200.zip'), 'shorter');

    await removePowerPointWorkingFiles(directory, { from: 1000, to: 2000 }, content);

    expect(names()).toEqual(['temp_pptx_1100.zip', 'temp_pptx_1200.zip']);
  });

  it('leaves files and folders that are named differently', async () => {
    writeFileSync(path.join(directory, 'temp_pptx_1500.zip.bak'), content);
    writeFileSync(path.join(directory, 'temp_docx_1500.zip'), content);
    writeFileSync(path.join(directory, 'my_temp_pptx_1500.zip'), content);
    mkdirSync(path.join(directory, 'temp_pptx_1600.zip'));

    await removePowerPointWorkingFiles(directory, { from: 1000, to: 2000 }, content);

    expect(names()).toEqual(['my_temp_pptx_1500.zip', 'temp_docx_1500.zip', 'temp_pptx_1500.zip.bak', 'temp_pptx_1600.zip']);
  });

  it('does not fail when the directory is not there', async () => {
    await expect(removePowerPointWorkingFiles(path.join(directory, 'missing'), { from: 0, to: 10 }, content)).resolves.toBeUndefined();
  });
});
