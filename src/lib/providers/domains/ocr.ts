import type { ModelRuntimeConfig } from './model';

export type OcrDocumentSource =
  | { kind: 'bytes'; data: Buffer; contentType?: string; fileName?: string }
  | { kind: 'url'; url: string; contentType?: string };

export type OcrFeature =
  | 'text'
  | 'tables'
  | 'kv_pairs'
  | 'layout'
  | 'reading_order'
  | 'handwriting';

export interface OcrExtractInput {
  document: OcrDocumentSource;
  /** Restrict extraction to these 1-based page numbers (when supported). */
  pages?: number[];
  /** ISO language hint (e.g. "tr", "en"). */
  language?: string;
  /** Requested feature set. Providers may ignore unsupported features. */
  features?: OcrFeature[];
  /** Free-text instruction to a VLM mode (ignored by native OCR providers). */
  prompt?: string;
  /** Max PDF pages to rasterize for VLM OCR; 0/undefined = unlimited. */
  pdfMaxPages?: number;
  extra?: Record<string, unknown>;
}

export interface OcrBoundingBox {
  /** Normalized to [0,1] when source dimensions are known; else absolute pixel coords. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrBlock {
  type: 'paragraph' | 'line' | 'word' | 'table' | 'figure' | 'kv' | 'other';
  text: string;
  bbox?: OcrBoundingBox;
  confidence?: number;
}

export interface OcrPageResult {
  pageNumber: number;
  text: string;
  blocks?: OcrBlock[];
  language?: string;
  width?: number;
  height?: number;
}

export interface OcrTableCell {
  rowIndex: number;
  colIndex: number;
  rowSpan?: number;
  colSpan?: number;
  text: string;
}

export interface OcrTable {
  pageNumber?: number;
  rows: number;
  cols: number;
  cells: OcrTableCell[];
}

export interface OcrKeyValuePair {
  key: string;
  value: string;
  pageNumber?: number;
  confidence?: number;
}

export interface OcrUsage {
  pages?: number;
  inputBytes?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface OcrResult {
  text: string;
  pages?: OcrPageResult[];
  tables?: OcrTable[];
  keyValuePairs?: OcrKeyValuePair[];
  language?: string;
  usage?: OcrUsage;
  /** Set when extracted via VLM rather than a native OCR provider. */
  invokedVia?: 'native' | 'vlm';
  raw?: unknown;
}

export interface OcrRuntime {
  extract(input: OcrExtractInput): Promise<OcrResult>;
}

export type { ModelRuntimeConfig };
