/**
 * Turns the bytes of a document into Markdown with the converter library, after the two things the library does not
 * do for the caller.
 *
 * 1. Container documents are measured first. A Word, PowerPoint, Excel or EPUB file is a ZIP container whose parts
 *    the readers inflate and parse in memory, and what a container unpacks to is not told by its size on disk. A
 *    document that unpacks to more than the ceiling (see `zipGuard`), or that cannot be followed to the end, is
 *    turned away with a sentence for people before any reader opens it. An out-of-memory stop of the process is not
 *    something the caller's `try/catch` could handle.
 * 2. The PowerPoint reader copies the document to a working file in the process's current directory and only removes
 *    it when the whole read went well. Reads of that kind take turns here, and whatever file the read left behind is
 *    removed again, so a failed read keeps no copy of the document on the server's disk and two reads never share a
 *    file name.
 *
 * The converter is also called directly by the crawler and by the knowledge-engine ingestion; this module guards the
 * Document Store's own conversions.
 */

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { convertToMarkdown } from '@cognipeer/to-markdown';
import { createLogger } from '@/lib/core/logger';
import { inspectZip, startsLikeZip, type ZipLimits, type ZipVerdict } from './zipGuard';

const logger = createLogger('files:conversion');

const MIB = 1024 * 1024;

export type ConvertedDocument = Awaited<ReturnType<typeof convertToMarkdown>>;

/** The document was not handed to a reader. The message is written for the person who uploaded it. */
export class DocumentConversionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentConversionRefused';
  }
}

export interface DocumentConversionOptions {
  /** The ceilings the container check applies. The defaults are the product's; a test narrows them. */
  limits?: ZipLimits;
  /** Where the PowerPoint reader keeps its working file: the process's current directory. A test points it elsewhere. */
  workingDirectory?: string;
}

/** The names whose reader opens the file as a ZIP container. */
const CONTAINER_EXTENSIONS: ReadonlySet<string> = new Set(['.docx', '.pptx', '.epub', '.xlsx', '.xls', '.zip']);

/** A legacy workbook is a compound file; the spreadsheet reader takes it for one whatever its name says. */
const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const POWERPOINT_WORKING_FILE = /^temp_pptx_(\d+)\.zip$/;

function readsAsContainer(extension: string, buffer: Buffer): boolean {
  // Without an extension the converter names the type from the content.
  if (extension === '') return startsLikeZip(buffer);
  if (!CONTAINER_EXTENSIONS.has(extension)) return false;
  if ((extension === '.xls' || extension === '.xlsx') && buffer.subarray(0, COMPOUND_FILE_SIGNATURE.length).equals(COMPOUND_FILE_SIGNATURE)) {
    return false;
  }
  return true;
}

function refusalOf(verdict: ZipVerdict): string | undefined {
  switch (verdict.kind) {
    case 'too_large':
      return `The document unpacks to more than ${Math.round(verdict.limitBytes / MIB)} MB, so it was not converted.`;
    case 'too_many_entries':
      return `The document is made of more than ${verdict.limit} parts, so it was not converted.`;
    case 'unreadable':
      return `The document could not be checked before conversion (${verdict.reason}), so it was not converted.`;
    default:
      return undefined;
  }
}

/** Reads of the PowerPoint reader take turns: they share a working directory and name their file by the clock. */
let powerPointTurn: Promise<unknown> = Promise.resolve();

function takeTurn<T>(work: () => Promise<T>): Promise<T> {
  const mine = powerPointTurn.then(work, work);
  powerPointTurn = mine.then(() => undefined, () => undefined);
  return mine;
}

/**
 * Removes the copy of `content` that a read begun in `[from, to]` left in `directory`. A file is only taken for the
 * read's own when its name carries a time inside that window and its bytes are the document's: another file that
 * looks alike is not touched. Never throws: there is nothing more to do when a file is already gone.
 */
export async function removePowerPointWorkingFiles(
  directory: string,
  window: { from: number; to: number },
  content: Buffer,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const match = POWERPOINT_WORKING_FILE.exec(name);
    if (!match) continue;
    const stamp = Number(match[1]);
    if (!(stamp >= window.from && stamp <= window.to)) continue;
    const file = path.join(directory, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size !== content.length) continue;
      if (!(await readFile(file)).equals(content)) continue;
      await unlink(file);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

async function convertWithWorkingFile(
  buffer: Buffer,
  fileName: string,
  workingDirectory: string | undefined,
): Promise<ConvertedDocument> {
  return takeTurn(async () => {
    const from = Date.now();
    try {
      return await convertToMarkdown(buffer, { fileName });
    } finally {
      await removePowerPointWorkingFiles(workingDirectory ?? process.cwd(), { from, to: Date.now() }, buffer);
    }
  });
}

/**
 * Converts one document. Throws `DocumentConversionRefused` for a container that is over the ceilings; any other
 * failure is the converter's own.
 */
export async function convertDocumentToMarkdown(
  buffer: Buffer,
  fileName: string,
  options: DocumentConversionOptions = {},
): Promise<ConvertedDocument> {
  const extension = path.extname(fileName).toLowerCase();

  if (readsAsContainer(extension, buffer)) {
    const verdict = await inspectZip(buffer, options.limits);
    const refusal = refusalOf(verdict);
    if (refusal) {
      logger.warn('A document was not converted because of what it unpacks to', { verdict: verdict.kind });
      throw new DocumentConversionRefused(refusal);
    }
  }

  // `.pptx` by name, or a ZIP container the converter will name from its content when the file has no extension.
  if (extension === '.pptx' || (extension === '' && startsLikeZip(buffer))) {
    return convertWithWorkingFile(buffer, fileName, options.workingDirectory);
  }
  return convertToMarkdown(buffer, { fileName });
}
