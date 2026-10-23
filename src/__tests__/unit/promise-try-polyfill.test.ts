import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The production image runs Node 22, which has no `Promise.try`, so the
// polyfill in `src/server/polyfills.ts` is what unpdf's pdf.js actually calls.
// The dev/CI runtime may ship a native one, so each test removes it first and
// re-imports the module to exercise the polyfill itself.
type PromiseWithTry = {
  try?: (fn: (...args: never[]) => unknown, ...args: unknown[]) => Promise<unknown>;
};

const P = Promise as unknown as PromiseWithTry;

describe('Promise.try polyfill', () => {
  let native: PromiseWithTry['try'];

  beforeEach(async () => {
    native = P.try;
    delete P.try;
    vi.resetModules();
    await import('@/server/polyfills');
  });

  afterEach(() => {
    if (native) P.try = native;
    else delete P.try;
  });

  it('installs itself when the runtime has no Promise.try', () => {
    expect(typeof P.try).toBe('function');
  });

  it('forwards extra arguments to the callback (pdf.js calls Promise.try(handler, data))', async () => {
    const handler = vi.fn(({ docId }: { docId: string }) => `doc:${docId}`);
    await expect(P.try!(handler as (...args: unknown[]) => unknown, { docId: 'd1' }, 'second')).resolves.toBe('doc:d1');
    expect(handler).toHaveBeenCalledWith({ docId: 'd1' }, 'second');
  });

  it('turns a synchronous throw into a rejection', async () => {
    const boom = new Error('boom');
    await expect(P.try!(() => { throw boom; })).rejects.toBe(boom);
  });

  it('adopts a returned promise', async () => {
    await expect(P.try!(async (x: unknown) => x, 42)).resolves.toBe(42);
  });

  // The production symptom: with an argument-dropping polyfill every PDF
  // upload failed with "Cannot destructure property 'docId' of 'e'".
  it('lets @cognipeer/to-markdown convert a PDF under the polyfill', async () => {
    const { convertToMarkdown } = await import('@cognipeer/to-markdown');
    const result = await convertToMarkdown(minimalPdf('TC 10000000146'), { fileName: 'probe.pdf' });
    const markdown = typeof result === 'string' ? result : (result as { markdown?: string }).markdown;
    expect(markdown).toContain('TC 10000000146');
  }, 30_000);
});

/** A one-page PDF with a single line of Helvetica text. */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
