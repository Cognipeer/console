/**
 * Several files of one bucket as a single ZIP download.
 *
 * The archive is streamed: the files are read from the storage provider one after the other, each only when the
 * ZIP writer gets to it, so the server never holds more than one file (plus the ZIP's own buffers) however many were
 * chosen. What can be refused is refused BEFORE the first byte is sent: the bucket and its provider must be usable,
 * and the files together must fit the size limit, none of them larger than the server reads at once (both checked
 * from the records, without reading a single object).
 * A file that fails to download once the stream has started ends the stream with an error, which the browser shows
 * as a failed download; the ZIP is then unfinished and cannot be opened.
 */

import path from 'node:path';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import type { FileProviderRuntime } from '@/lib/providers';
import type { IFileBucketRecord } from '@/lib/database';
import { withResilience } from '@/lib/core/resilience';
import { FileServiceError } from './errors';
import { assertWithinReadCeiling, composeProviderObjectKey, fileResilience, requireBucketContext } from './fileService';
import type { FileRecordView } from './types';

/** The most files one archive holds. */
export const ARCHIVE_MAX_FILES = 50;

/** The most the files of one archive add up to, in their original size. */
export const ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;

const MIB = 1024 * 1024;
const FALLBACK_ENTRY_NAME = 'file';
const MAX_ENTRY_NAME_LENGTH = 255;

const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.yaml', '.yml', '.log', '.sql', '.svg', '.ipynb',
]);

/** A file name that is safe as the one path segment of an entry: no folders, no way out of the archive. */
export function archiveEntryName(name: string): string {
  const cleaned = name
    .replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_ENTRY_NAME_LENGTH);
  // "." and ".." (and a name of dots only) mean a folder to an unzip tool.
  return cleaned === '' || /^\.+$/.test(cleaned) ? FALLBACK_ENTRY_NAME : cleaned;
}

/**
 * The entry names of an archive: each file's own name, made safe, and made unique where files of different folders
 * share one (`a.pdf`, `a (1).pdf`, ...). Names that differ only by case count as the same: unzip tools on the common
 * desktop systems cannot tell them apart.
 */
export function archiveEntryNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const clean = archiveEntryName(name);
    const extension = path.extname(clean);
    const stem = clean.slice(0, clean.length - extension.length);
    let candidate = clean;
    for (let copy = 1; taken.has(candidate.toLowerCase()); copy += 1) {
      candidate = `${stem} (${copy})${extension}`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

function isCompressible(record: Pick<FileRecordView, 'name' | 'contentType'>): boolean {
  const type = record.contentType?.toLowerCase() ?? '';
  if (type.startsWith('text/') || /json|xml|yaml|csv|javascript|svg/.test(type)) return true;
  return COMPRESSIBLE_EXTENSIONS.has(path.extname(record.name).toLowerCase());
}

/** A stream that reads the object when the ZIP writer first asks for its bytes, not before. */
function lazyObject(runtime: FileProviderRuntime, bucket: IFileBucketRecord, record: FileRecordView): Readable {
  return Readable.from(
    (async function* () {
      const result = await withResilience(
        () => runtime.downloadFile(composeProviderObjectKey(bucket, record.key)),
        fileResilience('download', bucket.tenantId, bucket.providerKey),
      );
      yield result.data;
    })(),
    { objectMode: false },
  );
}

export interface FilesArchive {
  /** `<bucketKey>-files.zip` */
  fileName: string;
  /** The ZIP, as it is written. */
  stream: Readable;
  /** The files in it. */
  count: number;
}

/**
 * Prepares the archive of these records (which the caller has already checked it may hand out). Throws
 * `archive_too_large` (413) when their original sizes add up to more than `ARCHIVE_MAX_BYTES`; nothing is read from
 * the provider by then.
 */
export async function createFilesArchive(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  bucketKey: string,
  records: readonly FileRecordView[],
): Promise<FilesArchive> {
  // A switched-off bucket still gives its files back.
  const { bucket, runtime } = await requireBucketContext(tenantDbName, tenantId, projectId, bucketKey, 'read');

  const totalBytes = records.reduce((sum, record) => sum + (record.size > 0 ? record.size : 0), 0);
  if (totalBytes > ARCHIVE_MAX_BYTES) {
    throw new FileServiceError(
      'archive_too_large',
      413,
      `The selected files add up to ${Math.ceil(totalBytes / MIB)} MB; an archive holds at most ${ARCHIVE_MAX_BYTES / MIB} MB.`,
      { details: { limitBytes: ARCHIVE_MAX_BYTES, totalBytes } },
    );
  }

  // A file the server could not hold in memory fails once the stream has started: refused here, before a byte is sent.
  for (const record of records) assertWithinReadCeiling(record.size);

  const names = archiveEntryNames(records.map((record) => record.name));
  const zip = new JSZip();
  records.forEach((record, index) => {
    const modified = record.updatedAt ? new Date(record.updatedAt) : undefined;
    zip.file(names[index]!, lazyObject(runtime, bucket, record), {
      binary: true,
      compression: isCompressible(record) ? 'DEFLATE' : 'STORE',
      // A time before 1980 cannot be written to a ZIP.
      ...(modified && modified.getFullYear() >= 1980 ? { date: modified } : {}),
    });
  });

  const writer = zip.generateNodeStream({ streamFiles: true, compression: 'STORE' });
  return { fileName: `${bucketKey}-files.zip`, stream: startOnFirstRead(writer), count: records.length };
}

/**
 * The ZIP writer's own stream does not run on Node's stream implementation and starts as soon as it is piped: the
 * response gets a Node stream that starts the writer when the first byte is asked for (nothing is read from the
 * provider for an archive that is never sent) and holds it back while the response cannot take more.
 */
function startOnFirstRead(writer: NodeJS.ReadableStream): Readable {
  let started = false;
  const stream = new Readable({
    read() {
      if (started) {
        writer.resume();
        return;
      }
      started = true;
      writer.on('data', (chunk: Buffer) => {
        if (!stream.push(chunk)) writer.pause();
      });
      writer.on('end', () => stream.push(null));
      writer.on('error', (error: Error) => stream.destroy(error));
    },
    destroy(error, callback) {
      writer.pause();
      callback(error);
    },
  });
  return stream;
}
