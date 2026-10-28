/**
 * Shared vocabulary of the document extraction engine (`services/extraction`): what a consumer asks for and what it
 * gets back. Everything optional here is optional on purpose: a request without `ocr` is converted exactly as it was
 * before the engine existed.
 */

import type { convertToMarkdown } from '@cognipeer/to-markdown';
import type { ZipLimits } from '@/lib/services/files/zipGuard';
import type { LicenseType } from '@/lib/license/license-manager';

export type { ZipLimits };

/** What the converter library returns for one document (the Markdown itself, or an object that carries it). */
export type ConvertedDocument = Awaited<ReturnType<typeof convertToMarkdown>>;

export type OcrMode = 'off' | 'auto' | 'always';

/** Stored OCR settings (KE module, agent attachments, file uploads, crawler). */
export interface OcrSettings {
  mode: OcrMode;
  /** Project model: category 'ocr', or a vision LLM (category 'llm' + isMultimodal). Absent = local CPU engine. */
  modelKey?: string;
  /** ISO 639-1 hints ('tr','en'); tesseract codes ('tur','eng') are accepted and normalized. */
  languages?: string[];
  /** OCR at most this many pages per document (default env, hard cap). */
  maxPages?: number;
  /** Also read text in images: images embedded in DOCX/PPTX, and image files where the consumer otherwise skips them (agent attachments). */
  images?: boolean;
}

/** What becomes of pictures inside DOCX / HTML / PPTX: kept as data URIs, replaced by a short name, or dropped. */
export type ImagePolicy = 'inline' | 'placeholder' | 'omit';

export interface ExtractionScope {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  userId?: string;
  /** The API token the work is done for, when there is one: token-scoped quota policies apply to the OCR spend. */
  tokenId?: string;
  licenseType?: LicenseType;
}

export type ExtractionSource =
  | 'knowledge-engine'
  | 'files'
  | 'agent-attachment'
  | 'crawler'
  | 'connector'
  | 'evaluation';

export interface ExtractionRequest {
  scope: ExtractionScope;
  source: ExtractionSource;
  fileName: string;
  data: Buffer;
  contentType?: string;
  ocr?: OcrSettings | null;
  images?: ImagePolicy;
  signal?: AbortSignal;
  onProgress?: (p: { completed: number; total: number }) => void;
  /** 'background' (job) or 'inline' (request is waiting) — picks the document deadline. Default 'inline'. */
  budget?: 'background' | 'inline';
  /** Test seams (from documentConversion). */
  limits?: ZipLimits;
  workingDirectory?: string;
}

export interface ExtractionReport {
  /** 'ocr' = all text came from OCR (image file / fully scanned). */
  sourceType: 'converted' | 'ocr' | 'mixed';
  engine?: 'model' | 'local';
  modelKey?: string;
  pageCount?: number;
  ocrPages?: number[];
  ocrImages?: number;
  ocrCalls?: number;
  ocrMs?: number;
  warnings: string[];
}

export interface ExtractionResult {
  raw: ConvertedDocument;
  text: string;
  report: ExtractionReport;
}
