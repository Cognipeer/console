/**
 * PDF → PNG page rendering for VLM-based OCR.
 *
 * Uses `pdf-to-img` (pdfjs-dist + @napi-rs/canvas, prebuilt binaries, no
 * system deps). Loaded lazily so the dependency is only resolved when a PDF
 * is actually encountered. Runs in the Node/Fastify backend process.
 */

export interface RenderPdfOptions {
  /** Maximum pages to render; 0/undefined = unlimited (render all pages). */
  maxPages?: number;
  /** Render scale; higher = sharper but larger images (default 2). */
  scale?: number;
}

export interface RenderPdfResult {
  /** `data:image/png;base64,...` URLs, one per rendered page. */
  dataUrls: string[];
  /** Total pages in the document (before capping). */
  totalPages: number;
  /** True when the document had more pages than `maxPages`. */
  truncated: boolean;
}

/**
 * Render the pages of a PDF to PNG data URLs. Returns at most `maxPages`
 * pages; `truncated` indicates whether pages were dropped.
 */
export async function renderPdfToPngDataUrls(
  data: Buffer,
  options?: RenderPdfOptions,
): Promise<RenderPdfResult> {
  const maxPages = options?.maxPages && options.maxPages > 0 ? options.maxPages : Infinity;
  const scale = options?.scale ?? 2;

  const { pdf } = await import('pdf-to-img');
  const document = await pdf(data, { scale });
  const totalPages = document.length;

  const dataUrls: string[] = [];
  for await (const page of document) {
    dataUrls.push(`data:image/png;base64,${page.toString('base64')}`);
    if (dataUrls.length >= maxPages) break;
  }

  return {
    dataUrls,
    totalPages,
    truncated: totalPages > dataUrls.length,
  };
}

/** Detect whether an OCR document is a PDF, by content type, URL, or magic bytes. */
export function looksLikePdf(input: {
  contentType?: string;
  url?: string;
  bytes?: Buffer;
}): boolean {
  const ct = (input.contentType || '').toLowerCase();
  if (ct.includes('pdf')) return true;
  if (input.url) {
    const path = input.url.toLowerCase().split('?')[0];
    if (path.endsWith('.pdf')) return true;
  }
  if (input.bytes && input.bytes.length >= 5) {
    return input.bytes.subarray(0, 5).toString('latin1') === '%PDF-';
  }
  return false;
}
