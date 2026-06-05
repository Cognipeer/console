/**
 * OCR Job service – shared types.
 *
 * An OCR Job is a persistent container (rules + storage + callback). Files are
 * sent to it over time; each file becomes an item processed via queue fan-out.
 */

import type {
  IOcrJob,
  IOcrJobItem,
  OcrJobItemSource,
  OcrJobMode,
  OcrJobStatus,
  OcrJobWebhookEvent,
  OcrOutputKind,
} from '@/lib/database';

/** Tenant/project execution context threaded through the service + queue. */
export interface OcrJobContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  userId: string;
}

/** A single input file, with an optional display name. */
export interface OcrJobItemInput {
  source: OcrJobItemSource;
  fileName?: string;
}

/** Rules used to create / update an OCR Job container. */
export interface CreateOcrJobInput {
  name?: string;
  /** Required: file bucket where uploaded documents are stored. */
  bucketKey: string;
  ocrModelKey: string;
  llmModelKey?: string;
  outputs: OcrOutputKind[];
  summaryPrompt?: string;
  structuredSchema?: Record<string, unknown>;
  language?: string;
  features?: string[];
  /** Max PDF pages to rasterize for VLM OCR; 0/undefined = unlimited. */
  pdfMaxPages?: number;
  callbackUrl?: string;
  callbackSecret?: string;
  callbackEvents?: OcrJobWebhookEvent[];
  metadata?: Record<string, unknown>;
}

export type UpdateOcrJobInput = Partial<
  Omit<CreateOcrJobInput, 'bucketKey'>
> & { status?: OcrJobStatus };

/** Result of sending files to a job. */
export interface AddFilesResult {
  items: IOcrJobItem[];
  /** Present for sync single-file sends — the fully processed item. */
  sync?: boolean;
}

export type { IOcrJob, IOcrJobItem, OcrJobMode };
