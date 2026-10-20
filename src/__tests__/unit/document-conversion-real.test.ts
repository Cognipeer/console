/**
 * The Document Store's conversion with the REAL converter library (`@cognipeer/to-markdown`): what a document that
 * unpacks to far more than its size is turned into, and what the PowerPoint reader leaves on the disk.
 *
 * The library writes a presentation to a file in the process's working directory while it reads it. These tests run in
 * the real working directory on purpose: that is where a file left behind would be found. Only a file that holds one of
 * the documents made here counts as left behind by these tests: another process working in the same directory has
 * working files of its own there.
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertDocumentToMarkdown, DocumentConversionRefused } from '@/lib/services/files/documentConversion';
import { documentOf, filler, MIB } from '../helpers/zipFixtures';

const WORKING_FILE = /^temp_pptx_\d+\.zip$/;
const OPTIONS = { createFolders: false };
const markdownOf = (result: unknown): string => (typeof result === 'string' ? result : String((result as { markdown?: string }).markdown ?? ''));

/** Every document these tests have made: the working file of a read of one of them holds exactly its bytes. */
const made: Buffer[] = [];
const track = (document: Buffer): Buffer => {
  made.push(document);
  return document;
};

async function wordDocument(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', OPTIONS);
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', OPTIONS);
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`, OPTIONS);
  return track(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

async function presentation(slideXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>', OPTIONS);
  zip.file('ppt/slides/slide1.xml', slideXml, OPTIONS);
  return track(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

const goodSlides = (text: string) => presentation(`<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><a:t>${text}</a:t></p:sld>`);
const brokenSlides = () => presentation('<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><a:t>never closed');

const workingFiles = () => new Set(readdirSync(process.cwd()).filter((name) => WORKING_FILE.test(name)));

let before: Set<string>;

beforeEach(() => {
  before = workingFiles();
});

/** The working files that appeared since the test began and hold a document made here. */
function leftBehind(): string[] {
  return [...workingFiles()].filter((name) => {
    if (before.has(name)) return false;
    try {
      const bytes = readFileSync(path.join(process.cwd(), name));
      return made.some((document) => document.equals(bytes));
    } catch {
      return false; // taken away by whoever owns it, in the meantime
    }
  });
}

afterEach(() => {
  // A file a regression would leave must not stay in the repository's working tree.
  for (const name of leftBehind()) rmSync(path.join(process.cwd(), name), { force: true });
});

describe('a document the converter can read', () => {
  it('is converted: a Word file', async () => {
    const result = await convertDocumentToMarkdown(await wordDocument('Quarterly figures'), 'report.docx');

    expect(markdownOf(result)).toContain('Quarterly figures');
  });

  it('is converted: a presentation, and nothing stays in the working directory', async () => {
    const result = await convertDocumentToMarkdown(await goodSlides('Roadmap for next year'), 'deck.pptx');

    expect(markdownOf(result)).toContain('Roadmap for next year');
    expect(leftBehind()).toEqual([]);
  });

  it('is converted together with others: presentations read at the same moment never share a working file', async () => {
    const decks = await Promise.all(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((word) => goodSlides(`slide about ${word}`)));

    const results = await Promise.all(decks.map((deck, index) => convertDocumentToMarkdown(deck, `deck-${index}.pptx`)));

    results.forEach((result, index) => {
      expect(markdownOf(result)).toContain(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'][index]);
    });
    expect(leftBehind()).toEqual([]);
  });
});

describe('a presentation the converter cannot read', () => {
  it('fails with the converter\'s own message and leaves no copy of the document on the disk', async () => {
    const error = await convertDocumentToMarkdown(await brokenSlides(), 'broken.pptx').then(() => undefined, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DocumentConversionRefused);
    expect((error as Error).message).toMatch(/Failed to convert PPTX/);
    expect(leftBehind()).toEqual([]);
  });

  it('leaves nothing behind however often it is tried, together or one after the other', async () => {
    const broken = await brokenSlides();

    await Promise.all(Array.from({ length: 4 }, (_, index) => convertDocumentToMarkdown(broken, `broken-${index}.pptx`).catch(() => undefined)));
    await convertDocumentToMarkdown(broken, 'again.pptx').catch(() => undefined);

    expect(leftBehind()).toEqual([]);
  });

  it('does not take down the presentations read after it', async () => {
    await convertDocumentToMarkdown(await brokenSlides(), 'broken.pptx').catch(() => undefined);

    const result = await convertDocumentToMarkdown(await goodSlides('still works'), 'fine.pptx');

    expect(markdownOf(result)).toContain('still works');
  });
});

describe('a document that unpacks to far more than its size', () => {
  it.each(['bomb.docx', 'bomb.epub', 'bomb.pptx', 'bomb.xlsx'])(
    'is turned away before any reader opens it: %s (a few hundred kilobytes that unpack to 101 MiB)',
    async (fileName) => {
      const bomb = track(documentOf(101 * MIB));
      expect(bomb.length).toBeLessThan(1_000_000);

      const error = await convertDocumentToMarkdown(bomb, fileName).then(() => undefined, (failure: unknown) => failure);

      expect(error).toBeInstanceOf(DocumentConversionRefused);
      expect((error as Error).message).toBe('The document unpacks to more than 100 MB, so it was not converted.');
      expect(leftBehind()).toEqual([]);
    },
  );

  it('is turned away although its headers claim it is tiny', async () => {
    const lying = track(documentOf(101 * MIB, { claimedSize: 100 }));

    await expect(convertDocumentToMarkdown(lying, 'lying.docx')).rejects.toBeInstanceOf(DocumentConversionRefused);
  });

  it('is turned away when it is made of thousands of parts', async () => {
    const zip = new JSZip();
    for (let index = 0; index < 5001; index += 1) zip.file(`parts/p${index}.xml`, 'x', OPTIONS);
    const many = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });

    const error = await convertDocumentToMarkdown(many, 'many.docx').then(() => undefined, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(DocumentConversionRefused);
    expect((error as Error).message).toBe('The document is made of more than 5000 parts, so it was not converted.');
  });

  it('is not mistaken for one: a Word file that is mostly pictures is converted', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>', OPTIONS);
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', OPTIONS);
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>with pictures</w:t></w:r></w:p></w:body></w:document>', OPTIONS);
    zip.file('word/media/photo.jpg', Buffer.from(filler(8 * MIB, 0x41)), { ...OPTIONS, compression: 'STORE' });
    const document = await zip.generateAsync({ type: 'nodebuffer' });

    const result = await convertDocumentToMarkdown(document, 'with-pictures.docx');

    expect(markdownOf(result)).toContain('with pictures');
  });
});
