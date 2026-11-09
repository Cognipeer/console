/**
 * Pure parsing of a single OCR job input item, shared by the dashboard and
 * client OCR job routes. Accepts the explicit `source` shape and the
 * shorthand `{ url | data }`, `{ bucket }` and `{ document }` shapes.
 */
import type { OcrJobItemInput } from './types';

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Returns `null` when the entry does not describe a usable source. */
export function parseOcrJobItem(raw: unknown): OcrJobItemInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const fileName = str(obj.fileName);

  const src = obj.source as Record<string, unknown> | undefined;
  if (src && typeof src.kind === 'string') {
    if (src.kind === 'inline' && typeof src.data === 'string') {
      const f = str(src.fileName) ?? fileName;
      return { source: { kind: 'inline', data: src.data, fileName: f, contentType: str(src.contentType) }, fileName: f };
    }
    if (src.kind === 'url' && typeof src.url === 'string') {
      return { source: { kind: 'url', url: src.url, contentType: str(src.contentType) }, fileName };
    }
    if (src.kind === 'bucket' && typeof src.bucketKey === 'string' && typeof src.objectKey === 'string') {
      return { source: { kind: 'bucket', bucketKey: src.bucketKey, objectKey: src.objectKey }, fileName };
    }
  }

  const bucket = obj.bucket as Record<string, unknown> | undefined;
  if (bucket && typeof bucket.bucketKey === 'string' && typeof bucket.objectKey === 'string') {
    return { source: { kind: 'bucket', bucketKey: bucket.bucketKey, objectKey: bucket.objectKey }, fileName };
  }

  const document = (obj.document as Record<string, unknown> | undefined) ?? obj;
  if (typeof document.url === 'string') {
    return { source: { kind: 'url', url: document.url, contentType: str(document.contentType) }, fileName };
  }
  if (typeof document.data === 'string') {
    const f = str(document.fileName) ?? fileName;
    return { source: { kind: 'inline', data: document.data, fileName: f, contentType: str(document.contentType) }, fileName: f };
  }
  return null;
}

/** Parses a list of items, skipping entries that carry no usable source. */
export function parseOcrJobItems(raw: unknown): OcrJobItemInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseOcrJobItem).filter((v): v is OcrJobItemInput => v !== null);
}
