/**
 * ZIP containers written by hand for tests of what a container unpacks to (`services/files/zipGuard`).
 *
 * A library writes a container the way a library does; these fixtures are the other kind - sizes that lie, a
 * directory that counts fewer parts than it holds, bytes in front of the container, a feature the check does not
 * read. The checksums are left at 0: nothing that reads these fixtures looks at them.
 */

import zlib from 'node:zlib';

export const MIB = 1024 * 1024;

export interface FixturePart {
  name: string;
  /** What the part holds when it is read back. */
  data: Buffer;
  /** 8 (default) deflates the data, 0 stores it. Any other number is written into the headers as it is. */
  method?: number;
  /** The bytes written as the part's stream, instead of the data compressed by `method`. */
  stream?: Buffer;
  /** The uncompressed size the headers claim (default: the real one). Readers must not trust it. */
  claimedSize?: number;
  /** The compressed size the central directory claims (default: the real one). */
  claimedCompressedSize?: number;
}

export interface FixtureOptions {
  /** Bytes in front of the container (a self-extractor's stub, say). */
  prepend?: Buffer;
  /** The number of parts the end record claims (default: the real one). */
  claimedEntries?: number;
  /** Writes the ZIP64 marker into the end record. */
  zip64EndRecord?: boolean;
  /** Writes the ZIP64 marker into the first part's central header. */
  zip64Entry?: boolean;
  /** Bytes after the end record, as a comment (its length is written into the record). */
  comment?: Buffer;
  /** Extra bytes after the whole container, written as they are (past any comment). */
  trailer?: Buffer;
}

/** `length` bytes of one repeated byte: deflates a thousand to one and more. */
export function filler(length: number, byte = 0x61): Buffer {
  return Buffer.alloc(length, byte);
}

function streamOf(part: FixturePart): Buffer {
  if (part.stream) return part.stream;
  return (part.method ?? 8) === 8 ? zlib.deflateRawSync(part.data, { level: 1 }) : part.data;
}

export function buildZip(parts: readonly FixturePart[], options: FixtureOptions = {}): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [index, part] of parts.entries()) {
    const name = Buffer.from(part.name, 'utf8');
    const stream = streamOf(part);
    const method = part.method ?? 8;
    const size = part.claimedSize ?? part.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10); // time and date
    local.writeUInt32LE(0, 14); // crc
    local.writeUInt32LE(stream.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, stream);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(0, 16);
    entry.writeUInt32LE(options.zip64Entry && index === 0 ? 0xffffffff : (part.claimedCompressedSize ?? stream.length), 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + stream.length;
  }

  const directory = Buffer.concat(central);
  const comment = options.comment ?? Buffer.alloc(0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  const declared = options.zip64EndRecord ? 0xffff : (options.claimedEntries ?? parts.length);
  end.writeUInt16LE(declared, 8);
  end.writeUInt16LE(declared, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);

  return Buffer.concat([options.prepend ?? Buffer.alloc(0), ...chunks, directory, end, comment, options.trailer ?? Buffer.alloc(0)]);
}

/** The container of a document: small parts, and one part (`word/document.xml`) that unpacks to `unpackedBytes`. */
export function documentOf(unpackedBytes: number, extra: Partial<FixturePart> = {}): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'word/document.xml', data: filler(unpackedBytes), ...extra },
  ]);
}
