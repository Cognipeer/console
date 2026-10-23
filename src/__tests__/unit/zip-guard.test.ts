/**
 * What a ZIP container unpacks to (`services/files/zipGuard`): found by inflating the parts for real, never from the
 * sizes the headers claim, and with a ceiling that stops the work as soon as it is passed.
 */
import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { inspectZip, MAX_ARCHIVE_ENTRIES, MAX_UNPACKED_BYTES, startsLikeZip } from '@/lib/services/files/zipGuard';
import { buildZip, documentOf, filler, MIB, type FixturePart } from '../helpers/zipFixtures';

const SMALL = { maxUnpackedBytes: 1000 };

/** An end record that lists nothing: the 22 bytes a tool writes for an empty archive. */
function emptyEndRecord(): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  return record;
}

/** The pieces of a one-part container as `buildZip` writes it: the part, its directory and the end record. */
function piecesOf(part: FixturePart) {
  const zip = buildZip([part]);
  const end = zip.length - 22;
  const directoryOffset = zip.readUInt32LE(end + 16);
  return { local: zip.subarray(0, directoryOffset), directory: zip.subarray(directoryOffset, end), end: zip.subarray(end) };
}

/**
 * One file with two directories. The end record states where the first one is; the second sits right before the
 * record, where a reader that counts back from the record looks. Which of the two a reader follows depends on the
 * reader, so both have to be measured.
 */
function twoDirectories(stated: FixturePart, near: FixturePart): Buffer {
  const first = piecesOf(stated);
  const second = piecesOf(near);
  if (first.local.length < second.local.length) throw new Error('the part at the stated offset must not be the shorter one');
  // Counted back from the end record, the second directory's offsets start after the first directory and the second part.
  const directory = Buffer.from(second.directory);
  directory.writeUInt32LE(first.local.length - second.local.length, 42);
  const end = Buffer.from(first.end);
  end.writeUInt32LE(directory.length, 12);
  return Buffer.concat([first.local, first.directory, second.local, directory, end]);
}

describe('the product limits', () => {
  it('are 100 MiB unpacked and 5000 parts', () => {
    expect(MAX_UNPACKED_BYTES).toBe(100 * MIB);
    expect(MAX_ARCHIVE_ENTRIES).toBe(5000);
  });
});

describe('startsLikeZip', () => {
  it('knows a local header, an empty archive and a spanned one', () => {
    expect(startsLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]))).toBe(true);
    expect(startsLikeZip(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    expect(startsLikeZip(Buffer.from([0x50, 0x4b, 0x07, 0x08]))).toBe(true);
  });

  it('knows other files, and a buffer too short to say', () => {
    expect(startsLikeZip(Buffer.from('%PDF-1.7'))).toBe(false);
    expect(startsLikeZip(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).toBe(false);
    expect(startsLikeZip(Buffer.from('PK'))).toBe(false);
    expect(startsLikeZip(Buffer.alloc(0))).toBe(false);
  });
});

describe('a container within the limits', () => {
  it('is ok, with the parts counted and the bytes they really unpack to added up', async () => {
    const zip = new JSZip();
    const options = { createFolders: false };
    zip.file('[Content_Types].xml', '<Types/>', options);
    zip.file('word/document.xml', 'x'.repeat(5000), options);
    zip.file('word/media/image1.png', Buffer.from(Array.from({ length: 300 }, (_, index) => index % 251)), options);
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    expect(await inspectZip(buffer)).toEqual({ kind: 'ok', entries: 3, unpackedBytes: 8 + 5000 + 300 });
  });

  it('counts a part that is stored as its length, and a deflated part as what it inflates to', async () => {
    const buffer = buildZip([
      { name: 'stored.txt', data: Buffer.from('s'.repeat(300)), method: 0 },
      { name: 'deflated.txt', data: filler(700) },
    ]);

    expect(await inspectZip(buffer, SMALL)).toEqual({ kind: 'ok', entries: 2, unpackedBytes: 1000 });
  });

  it('takes a part that holds nothing, deflated or stored', async () => {
    const buffer = buildZip([
      { name: 'empty-deflated', data: Buffer.alloc(0), stream: Buffer.alloc(0) },
      { name: 'empty-stored', data: Buffer.alloc(0), method: 0 },
      { name: 'folder/', data: Buffer.alloc(0), method: 0 },
    ]);

    expect(await inspectZip(buffer)).toEqual({ kind: 'ok', entries: 3, unpackedBytes: 0 });
  });

  it('takes an archive with no parts at all', async () => {
    expect(await inspectZip(buildZip([]))).toEqual({ kind: 'ok', entries: 0, unpackedBytes: 0 });
  });

  it('takes exactly as many bytes as the limit allows, and not one more', async () => {
    expect(await inspectZip(documentOf(992), SMALL)).toMatchObject({ kind: 'ok', unpackedBytes: 1000 });
    expect(await inspectZip(documentOf(993), SMALL)).toEqual({ kind: 'too_large', limitBytes: 1000 });
  });
});

describe('a container that unpacks to more than the limit', () => {
  it('is too large, however small the file is', async () => {
    const buffer = documentOf(5 * MIB);

    expect(buffer.length).toBeLessThan(50_000);
    expect(await inspectZip(buffer, { maxUnpackedBytes: MIB })).toEqual({ kind: 'too_large', limitBytes: MIB });
  });

  it('is too large at the product limit: a file of a few kilobytes that unpacks to 101 MiB', async () => {
    const buffer = documentOf(101 * MIB);

    expect(buffer.length).toBeLessThan(500_000);
    expect(await inspectZip(buffer)).toEqual({ kind: 'too_large', limitBytes: 100 * MIB });
  });

  it('does not believe the sizes the headers claim: a part that says it holds 100 bytes is inflated', async () => {
    const buffer = documentOf(3 * MIB, { claimedSize: 100 });

    expect(await inspectZip(buffer, { maxUnpackedBytes: MIB })).toEqual({ kind: 'too_large', limitBytes: MIB });
  });

  it('does not believe a claimed compressed size that is shorter than the stream either', async () => {
    // The stream is cut short by the claim: it cannot be inflated to the end, whatever the claim says it holds.
    const buffer = documentOf(3 * MIB, { claimedSize: 100, claimedCompressedSize: 8 });

    const verdict = await inspectZip(buffer, { maxUnpackedBytes: MIB });

    expect(['too_large', 'unreadable']).toContain(verdict.kind);
  });

  it('adds the parts up: none is over the limit alone', async () => {
    const parts = Array.from({ length: 10 }, (_, index) => ({ name: `part-${index}.xml`, data: filler(200) }));

    expect(await inspectZip(buildZip(parts.slice(0, 5)), SMALL)).toMatchObject({ kind: 'ok', unpackedBytes: 1000 });
    expect(await inspectZip(buildZip(parts), SMALL)).toEqual({ kind: 'too_large', limitBytes: 1000 });
  });

  it('counts a stored part by its length', async () => {
    const buffer = buildZip([{ name: 'big.bin', data: Buffer.alloc(2000, 7), method: 0 }]);

    expect(await inspectZip(buffer, SMALL)).toEqual({ kind: 'too_large', limitBytes: 1000 });
  });

  it('stops as soon as the limit is passed: the rest of an enormous part is never produced', async () => {
    // 64 MiB of zeros deflates to a few kilobytes. The check counts what comes out of the inflater, so it can say how
    // much was produced before it gave up: about the limit, not the 64 MiB.
    const stream = zlib.deflateRawSync(Buffer.alloc(64 * MIB), { level: 1 });
    const buffer = buildZip([{ name: 'word/document.xml', data: Buffer.alloc(0), stream, claimedSize: 700 * MIB }]);
    let produced = 0;
    const create = zlib.createInflateRaw.bind(zlib);
    const spy = vi.spyOn(zlib, 'createInflateRaw').mockImplementation((...args: Parameters<typeof zlib.createInflateRaw>) => {
      const inflater = create(...args);
      inflater.on('data', (chunk: Buffer) => { produced += chunk.length; });
      return inflater;
    });

    try {
      expect(await inspectZip(buffer, { maxUnpackedBytes: MIB })).toEqual({ kind: 'too_large', limitBytes: MIB });
    } finally {
      spy.mockRestore();
    }

    expect(produced).toBeGreaterThan(MIB);
    expect(produced).toBeLessThan(4 * MIB);
  });
});

describe('the parts of a container', () => {
  const parts = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `p${index}.xml`, data: Buffer.from('x') }));

  it('may be as many as the limit', async () => {
    expect(await inspectZip(buildZip(parts(5)), { maxEntries: 5 })).toMatchObject({ kind: 'ok', entries: 5 });
  });

  it('are too many one past it', async () => {
    expect(await inspectZip(buildZip(parts(6)), { maxEntries: 5 })).toEqual({ kind: 'too_many_entries', limit: 5 });
  });

  it('are counted in the directory itself, not as the end record claims', async () => {
    // The end record says one part; the directory lists six. A reader that follows the directory reads six.
    expect(await inspectZip(buildZip(parts(6), { claimedEntries: 1 }), { maxEntries: 5 })).toEqual({ kind: 'too_many_entries', limit: 5 });
    expect(await inspectZip(buildZip(parts(6), { claimedEntries: 1 }), { maxEntries: 50 })).toMatchObject({ kind: 'ok', entries: 6 });
  });

  it('are too many when the end record claims more than the limit, without walking the directory', async () => {
    expect(await inspectZip(buildZip(parts(2), { claimedEntries: 60_000 }), { maxEntries: 5000 })).toEqual({ kind: 'too_many_entries', limit: 5000 });
  });
});

describe('where the directory starts', () => {
  // Readers differ: one goes by the offset the end record states, another counts back from the record. A file that
  // has a directory in both places is measured by both.
  const stated = { name: 'a-part-at-the-stated-offset.xml', data: filler(600) };
  const near = { name: 'near.xml', data: filler(600) };

  it('adds up what the two places hold: neither is over the limit alone', async () => {
    expect(await inspectZip(buildZip([stated]), SMALL)).toMatchObject({ kind: 'ok', unpackedBytes: 600 });
    expect(await inspectZip(twoDirectories(stated, near), SMALL)).toEqual({ kind: 'too_large', limitBytes: 1000 });
  });

  it('follows the directory the end record states, even when another one sits before the record', async () => {
    const buffer = twoDirectories({ ...stated, data: filler(2000) }, { ...near, data: filler(10) });

    expect(await inspectZip(buffer, SMALL)).toEqual({ kind: 'too_large', limitBytes: 1000 });
  });

  it('follows the directory before the record, even when the stated offset leads to a small one', async () => {
    const buffer = twoDirectories({ ...stated, data: filler(10) }, { ...near, data: filler(2000) });

    expect(await inspectZip(buffer, SMALL)).toEqual({ kind: 'too_large', limitBytes: 1000 });
  });

  it('counts the parts of both places together', async () => {
    const buffer = twoDirectories({ ...stated, data: filler(10) }, { ...near, data: filler(10) });

    expect(await inspectZip(buffer)).toEqual({ kind: 'ok', entries: 2, unpackedBytes: 20 });
    expect(await inspectZip(buffer, { maxEntries: 2 })).toMatchObject({ kind: 'ok', entries: 2 });
    expect(await inspectZip(buffer, { maxEntries: 1 })).toEqual({ kind: 'too_many_entries', limit: 1 });
  });
});

describe('an end record that claims less than the directory holds', () => {
  it('is not believed when it claims no parts: the directory after it is followed', async () => {
    const buffer = buildZip([{ name: 'word/document.xml', data: filler(3 * MIB) }], { claimedEntries: 0 });

    expect(await inspectZip(buffer, { maxUnpackedBytes: MIB })).toEqual({ kind: 'too_large', limitBytes: MIB });
  });

  it('is not believed when it states a directory of no size: the directory at the stated offset is followed', async () => {
    const buffer = documentOf(3 * MIB);
    buffer.writeUInt32LE(0, buffer.length - 22 + 12);

    expect(await inspectZip(buffer, { maxUnpackedBytes: MIB })).toEqual({ kind: 'too_large', limitBytes: MIB });
  });

  it('is an empty archive only when it claims no parts and no directory', async () => {
    const empty = buildZip([]);

    expect(empty.readUInt16LE(empty.length - 22 + 10)).toBe(0);
    expect(empty.readUInt32LE(empty.length - 22 + 12)).toBe(0);
    expect(await inspectZip(empty)).toEqual({ kind: 'ok', entries: 0, unpackedBytes: 0 });
  });
});

describe('a file that is not a container', () => {
  it('is not a zip when it has no end record: text, a short buffer, nothing', async () => {
    expect(await inspectZip(Buffer.from('just some text, nothing to unpack'.repeat(10)))).toEqual({ kind: 'not_zip' });
    expect(await inspectZip(Buffer.from('PK\u0003\u0004 and not more'))).toEqual({ kind: 'not_zip' });
    expect(await inspectZip(Buffer.alloc(10))).toEqual({ kind: 'not_zip' });
    expect(await inspectZip(Buffer.alloc(0))).toEqual({ kind: 'not_zip' });
  });

  it('is not a zip when the file stops before the end record', async () => {
    const whole = documentOf(1000);

    expect(await inspectZip(whole.subarray(0, whole.length - 30))).toEqual({ kind: 'not_zip' });
  });
});

describe('where the end record is', () => {
  it('is the last one that fits in the file: a stray signature at the very end hides nothing', async () => {
    // A reader that looks for the end record from the back, starting where one could fit, reads the real one.
    const buffer = Buffer.concat([documentOf(3 * MIB), Buffer.from([0x50, 0x4b, 0x05, 0x06, 1, 2, 3])]);

    expect(await inspectZip(buffer, { maxUnpackedBytes: MIB })).toEqual({ kind: 'too_large', limitBytes: MIB });
  });

  it('is the last one, not the first: bytes inside a part that look like an empty end record hide nothing', async () => {
    const buffer = buildZip([
      { name: 'note.bin', data: emptyEndRecord(), method: 0 },
      { name: 'word/document.xml', data: filler(2000) },
    ]);

    expect(buffer.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBeLessThan(buffer.length - 22);
    expect(await inspectZip(buffer, SMALL)).toEqual({ kind: 'too_large', limitBytes: 1000 });
  });

  it('may be followed by a comment', async () => {
    const withComment = buildZip(
      [{ name: 'word/document.xml', data: filler(3 * MIB) }],
      { comment: Buffer.from('written by a tool that leaves a note') },
    );

    expect(await inspectZip(withComment, { maxUnpackedBytes: MIB })).toEqual({ kind: 'too_large', limitBytes: MIB });
  });

  it('may have bytes in front of the container: the parts are found from the directory all the same', async () => {
    const buffer = buildZip([{ name: 'word/document.xml', data: filler(3 * MIB) }], { prepend: Buffer.alloc(137, 0x41) });

    expect(startsLikeZip(buffer)).toBe(false);
    expect(await inspectZip(buffer, { maxUnpackedBytes: MIB })).toEqual({ kind: 'too_large', limitBytes: MIB });
    // And a small one is measured, not refused for having a stub.
    expect(await inspectZip(buildZip([{ name: 'a.xml', data: filler(10) }], { prepend: Buffer.alloc(300, 0x41) }))).toEqual({
      kind: 'ok', entries: 1, unpackedBytes: 10,
    });
  });
});

describe('a container that cannot be followed to the end', () => {
  it('is unreadable when it is ZIP64: the sizes are not in the places this reads', async () => {
    expect(await inspectZip(documentOf(100))).toMatchObject({ kind: 'ok' });
    expect(await inspectZip(buildZip([{ name: 'a.xml', data: filler(10) }], { zip64EndRecord: true }))).toEqual({
      kind: 'unreadable', reason: 'it is a ZIP64 container',
    });
    expect(await inspectZip(buildZip([{ name: 'a.xml', data: filler(10) }], { zip64Entry: true }))).toEqual({
      kind: 'unreadable', reason: 'it is a ZIP64 container',
    });
  });

  it.each([
    { what: 'the number of parts', at: 10, width: 2, value: 0xffff },
    { what: 'the size of the directory', at: 12, width: 4, value: 0xffffffff },
    { what: 'where the directory starts', at: 16, width: 4, value: 0xffffffff },
  ])('is unreadable when the end record carries the ZIP64 marker for $what', async ({ at, width, value }) => {
    const buffer = documentOf(100);
    const field = buffer.length - 22 + at;
    if (width === 2) buffer.writeUInt16LE(value, field);
    else buffer.writeUInt32LE(value, field);

    expect(await inspectZip(buffer)).toEqual({ kind: 'unreadable', reason: 'it is a ZIP64 container' });
  });

  it.each([
    { what: 'the size of a part', at: 20 },
    { what: 'where a part starts', at: 42 },
  ])('is unreadable when a directory entry carries the ZIP64 marker for $what', async ({ at }) => {
    const buffer = documentOf(100);
    const directoryOffset = buffer.readUInt32LE(buffer.length - 22 + 16);
    buffer.writeUInt32LE(0xffffffff, directoryOffset + at);

    expect(await inspectZip(buffer)).toEqual({ kind: 'unreadable', reason: 'it is a ZIP64 container' });
  });

  it('is unreadable when a part uses a compression the converter cannot read', async () => {
    const buffer = buildZip([{ name: 'a.xml', data: Buffer.from('x'), method: 12, stream: Buffer.from('BZh9...') }]);

    expect(await inspectZip(buffer)).toEqual({ kind: 'unreadable', reason: 'it uses a compression method the converter cannot read' });
  });

  it('is unreadable when a part cannot be inflated', async () => {
    const buffer = buildZip([{ name: 'a.xml', data: Buffer.from('x'), stream: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]) }]);

    expect(await inspectZip(buffer)).toEqual({ kind: 'unreadable', reason: 'a part of it is damaged' });
  });

  it('is unreadable when a part says it is longer than the file', async () => {
    const buffer = buildZip([{ name: 'a.xml', data: filler(100), claimedCompressedSize: 5_000_000 }]);

    expect(await inspectZip(buffer)).toEqual({ kind: 'unreadable', reason: 'a part of it is cut short' });
  });

  it('is unreadable when the directory points at something that is not a part', async () => {
    const whole = buildZip([{ name: 'a.xml', data: filler(100) }]);
    // Break the local header signature of the first part.
    whole.writeUInt32LE(0xdeadbeef, 0);

    expect(await inspectZip(whole)).toEqual({ kind: 'unreadable', reason: 'a part of it is damaged' });
  });

  it('is unreadable when there is an end record but no directory where it says', async () => {
    const whole = buildZip([{ name: 'a.xml', data: filler(100) }]);
    // Point the end record somewhere that holds no directory.
    whole.writeUInt32LE(7, whole.length - 22 + 16);
    whole.writeUInt32LE(3, whole.length - 22 + 12);

    expect(await inspectZip(whole)).toEqual({ kind: 'unreadable', reason: 'its directory is damaged' });
  });
});
