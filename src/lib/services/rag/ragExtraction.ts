/**
 * What a Knowledge Engine document remembers about how its text was extracted (`IRagDocumentExtraction`), and the
 * context a caller gives the file-to-text conversion.
 *
 * Kept apart from `ragService` so the conversion rules read in one place. Nothing here touches a database.
 */

import { createHash } from 'node:crypto';
import type { IRagDocumentExtraction, IRagModule } from '@/lib/database';
import { recordedWarnings } from '@/lib/services/files/markdownExtraction';
import { RagOcrIncompleteError } from './errors';
import type {
  ExtractionReport,
  ExtractionScope,
  ExtractionSource,
  OcrSettings,
} from '@/lib/services/extraction';

/** What `convertFileToText` may be told beyond the file: who asks, and which OCR setting applies. */
export interface ConvertFileContext {
  /** The tenant / project the conversion runs for. Without it no OCR runs (nothing to bill or scope it to). */
  scope?: ExtractionScope;
  /** The module the file is for, when the caller has it: its `extraction.ocr` applies unless `ocr` is given. */
  ragModule?: IRagModule;
  /** The module's key, when the caller has only that: it is looked up in the scope's project. */
  ragModuleKey?: string;
  /** The OCR setting. `null` switches OCR off for this call; absent means the module's setting. */
  ocr?: OcrSettings | null;
  /** Who is converting (logs and the report). Default 'knowledge-engine'. */
  source?: ExtractionSource;
  signal?: AbortSignal;
  onProgress?: (progress: { completed: number; total: number }) => void;
  /** 'background' (a job) or 'inline' (a request is waiting; the default). */
  budget?: 'background' | 'inline';
  /** Epoch ms: the caller's own deadline (a connector's sync segment). OCR stops by then. */
  deadline?: number;
}

export interface ConvertFileResult {
  text: string;
  report: ExtractionReport;
}

export function fileHashOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The record a document keeps of one extraction run. `stage` and `progress` are never part of it: a finished (or
 * failed) run leaves neither behind.
 */
export function documentExtractionOf(
  report: ExtractionReport,
  extras: { fileHash?: string; requested?: OcrSettings | null } = {},
): IRagDocumentExtraction {
  const warnings = recordedWarnings(report.warnings);
  return {
    sourceType: report.sourceType,
    ...(report.engine ? { engine: report.engine } : {}),
    ...(report.modelKey ? { modelKey: report.modelKey } : {}),
    ...(report.pageCount !== undefined ? { pageCount: report.pageCount } : {}),
    ...(report.ocrPages && report.ocrPages.length > 0 ? { ocrPages: report.ocrPages.length } : {}),
    ...(report.ocrImages ? { ocrImages: report.ocrImages } : {}),
    ...(extras.fileHash ? { fileHash: extras.fileHash } : {}),
    ...(extras.requested !== undefined ? { requested: extras.requested } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** An extraction record without the markers of a run in flight. */
export function settledExtraction(
  extraction: IRagDocumentExtraction | undefined,
): IRagDocumentExtraction | undefined {
  if (!extraction) return undefined;
  const { stage: _stage, progress: _progress, ...rest } = extraction;
  void _stage;
  void _progress;
  return rest;
}

/** The message of a document whose original was not kept (no bucket, or the upload failed). */
export const ORIGINAL_MISSING_MESSAGE = 'The original file is no longer stored; upload it again.';

/** The report warnings that mean OCR was asked for and did not run to the end, and what to tell people. */
const OCR_FALLBACK_REASONS: Readonly<Record<string, string>> = {
  ocr_timeout: 'it ran out of time',
  ocr_busy: 'no OCR capacity became free in time',
  ocr_budget_exceeded: 'the OCR budget is used up',
  ocr_model_unavailable: 'the OCR model is not available',
  ocr_unavailable: 'OCR is not available on this server',
  ocr_failed: 'OCR failed',
};

/** The first warning of a report that says OCR fell back to the native text, as a sentence fragment. */
export function ocrFallbackReason(warnings: readonly string[]): string | undefined {
  for (const warning of warnings) {
    const code = warning.split(':', 1)[0].trim();
    const reason = OCR_FALLBACK_REASONS[code];
    if (reason) return reason;
  }
  return undefined;
}

/** The extraction record of a document whose run failed: no run markers, and the reason when OCR could not finish. */
export function failedExtraction(
  extraction: IRagDocumentExtraction | undefined,
  error: unknown,
): IRagDocumentExtraction | undefined {
  const settled = settledExtraction(extraction);
  if (!settled || !(error instanceof RagOcrIncompleteError)) return settled;
  const warnings = recordedWarnings(error.warnings);
  return warnings.length > 0 ? { ...settled, warnings } : settled;
}

/**
 * How often a running extraction touches its document even when no page finished, so that the boot sweep of another
 * node can tell a live run from an abandoned one (`resumePendingRagIngests`).
 */
export const EXTRACTION_HEARTBEAT_MS = 30_000;
