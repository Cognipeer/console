/**
 * How much a ZIP container unpacks to, found out before a document reader is let near it.
 *
 * Word, PowerPoint, Excel and EPUB files are ZIP containers, and the converter's readers inflate and parse their
 * parts in memory. The size of the file on disk says little about that: deflate shrinks repetitive data by a
 * thousand to one, and the sizes a ZIP declares for its parts are only claims. So this reads the container's own
 * directory, inflates every part for real - counting the bytes and throwing them away, never holding more than a
 * chunk - and stops the moment the total passes the limit. The sizes the headers declare are never trusted.
 *
 * It finds the directory the way the readers do (the last end-of-directory record that fits in the file) and, where
 * the readers differ on where the directory starts, looks at both places. A file the readers would open as a
 * container is a file that is checked; a file with no such record is not a container and is left to the converter,
 * which turns it away cheaply.
 */

import zlib from 'node:zlib';

const MIB = 1024 * 1024;

/** The most a container may unpack to, all its parts together. */
export const MAX_UNPACKED_BYTES = 100 * MIB;

/** The most parts a container may hold. A real document holds a few dozen. */
export const MAX_ARCHIVE_ENTRIES = 5000;

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_LENGTH = 22;
const CENTRAL_HEADER_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const ZIP64_16 = 0xffff;
const ZIP64_32 = 0xffffffff;

export interface ZipLimits {
  maxUnpackedBytes?: number;
  maxEntries?: number;
}

export type ZipVerdict =
  /** No end-of-directory record: not a container, nothing here to unpack. */
  | { kind: 'not_zip' }
  | { kind: 'ok'; entries: number; unpackedBytes: number }
  | { kind: 'too_large'; limitBytes: number }
  | { kind: 'too_many_entries'; limit: number }
  /** The container could not be followed to the end (damaged, or a feature this check does not read). */
  | { kind: 'unreadable'; reason: string };

interface CentralEntry {
  method: number;
  compressedSize: number;
  localOffset: number;
}

type Walk =
  | { kind: 'entries'; entries: CentralEntry[] }
  | { kind: 'too_many' }
  | { kind: 'damaged' }
  | { kind: 'zip64' };

/** Whether a buffer starts like a ZIP container (a local file header, an empty archive or a spanned one). */
export function startsLikeZip(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const signature = buffer.readUInt32LE(0);
  return signature === LOCAL_SIGNATURE || signature === 0x06054b50 || signature === 0x08074b50;
}

/**
 * Counts the bytes a deflate stream inflates to, up to `budget`. `'over'` as soon as it passes it. Nothing is kept:
 * the output is counted and dropped, so memory stays flat however large the stream would have been.
 */
function inflatedLength(compressed: Buffer, budget: number): Promise<number | 'over' | 'broken'> {
  return new Promise((resolve) => {
    const inflater = zlib.createInflateRaw();
    let total = 0;
    let settled = false;
    const settle = (value: number | 'over' | 'broken') => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    inflater.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > budget) {
        settle('over');
        inflater.destroy();
      }
    });
    inflater.on('end', () => settle(total));
    inflater.on('error', () => settle('broken'));
    inflater.end(compressed);
  });
}

/** Reads the directory entries that follow one another from `start`, as many as `limit` allows. */
function walkDirectory(buffer: Buffer, start: number, limit: number): Walk {
  const entries: CentralEntry[] = [];
  let position = start;
  while (position + 4 <= buffer.length && buffer.readUInt32LE(position) === CENTRAL_SIGNATURE) {
    if (position + CENTRAL_HEADER_LENGTH > buffer.length) return { kind: 'damaged' };
    if (entries.length >= limit) return { kind: 'too_many' };
    const compressedSize = buffer.readUInt32LE(position + 20);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    if (compressedSize === ZIP64_32 || localOffset === ZIP64_32) return { kind: 'zip64' };
    entries.push({ method: buffer.readUInt16LE(position + 10), compressedSize, localOffset });
    position += CENTRAL_HEADER_LENGTH + nameLength + extraLength + commentLength;
  }
  return { kind: 'entries', entries };
}

/**
 * Inflates every part of the container with a hard ceiling on the total. See the module comment: the limits are
 * what the parts really unpack to, not what the headers say.
 */
export async function inspectZip(buffer: Buffer, limits: ZipLimits = {}): Promise<ZipVerdict> {
  const maxUnpackedBytes = limits.maxUnpackedBytes ?? MAX_UNPACKED_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_ARCHIVE_ENTRIES;

  if (buffer.length < EOCD_LENGTH) return { kind: 'not_zip' };
  const end = buffer.lastIndexOf(EOCD_SIGNATURE, buffer.length - EOCD_LENGTH);
  if (end === -1) return { kind: 'not_zip' };

  const declaredEntries = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (declaredEntries === ZIP64_16 || directorySize === ZIP64_32 || directoryOffset === ZIP64_32) {
    return { kind: 'unreadable', reason: 'it is a ZIP64 container' };
  }
  if (declaredEntries > maxEntries) return { kind: 'too_many_entries', limit: maxEntries };
  if (declaredEntries === 0 && directorySize === 0) return { kind: 'ok', entries: 0, unpackedBytes: 0 };

  // Where the directory starts. One reader takes the offset the record states; another takes the place just before
  // the record, which differs when bytes were put in front of the container. Both places are looked at.
  const places = new Map<number, number>();
  const beforeRecord = end - directorySize;
  if (beforeRecord >= directoryOffset) places.set(beforeRecord, beforeRecord - directoryOffset);
  if (!places.has(directoryOffset)) places.set(directoryOffset, 0);

  let total = 0;
  let entryCount = 0;
  let found = false;
  for (const [start, shift] of places) {
    if (start < 0 || start + 4 > buffer.length || buffer.readUInt32LE(start) !== CENTRAL_SIGNATURE) continue;
    found = true;

    const walked = walkDirectory(buffer, start, maxEntries);
    if (walked.kind === 'too_many') return { kind: 'too_many_entries', limit: maxEntries };
    if (walked.kind === 'zip64') return { kind: 'unreadable', reason: 'it is a ZIP64 container' };
    if (walked.kind === 'damaged') return { kind: 'unreadable', reason: 'its directory is damaged' };
    entryCount += walked.entries.length;
    if (entryCount > maxEntries) return { kind: 'too_many_entries', limit: maxEntries };

    for (const entry of walked.entries) {
      const local = shift + entry.localOffset;
      if (local + LOCAL_HEADER_LENGTH > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
        return { kind: 'unreadable', reason: 'a part of it is damaged' };
      }
      const dataStart = local + LOCAL_HEADER_LENGTH + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const dataEnd = dataStart + entry.compressedSize;
      if (dataEnd > buffer.length) return { kind: 'unreadable', reason: 'a part of it is cut short' };

      if (entry.method === METHOD_STORED) {
        total += entry.compressedSize;
      } else if (entry.method === METHOD_DEFLATED) {
        if (entry.compressedSize > 0) {
          const counted = await inflatedLength(buffer.subarray(dataStart, dataEnd), maxUnpackedBytes - total);
          if (counted === 'over') return { kind: 'too_large', limitBytes: maxUnpackedBytes };
          if (counted === 'broken') return { kind: 'unreadable', reason: 'a part of it is damaged' };
          total += counted;
        }
      } else {
        return { kind: 'unreadable', reason: 'it uses a compression method the converter cannot read' };
      }
      if (total > maxUnpackedBytes) return { kind: 'too_large', limitBytes: maxUnpackedBytes };
    }
  }

  if (!found) return { kind: 'unreadable', reason: 'its directory is damaged' };
  return { kind: 'ok', entries: entryCount, unpackedBytes: total };
}
