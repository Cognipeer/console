/**
 * Types and display helpers of the OCR Jobs dashboard (v2 container model). The requests are the hooks in
 * `src/lib/api/queries/ocrJobs.ts`.
 */

export type OcrJobStatus = 'active' | 'paused' | 'archived';
export type OcrItemStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type OcrOutputKind = 'full_text' | 'summary' | 'structured';

export interface OcrJobView {
  id: string;
  name?: string;
  status: OcrJobStatus;
  bucketKey: string;
  ocrModelKey: string;
  llmModelKey?: string;
  outputs: OcrOutputKind[];
  summaryPrompt?: string;
  structuredSchema?: Record<string, unknown>;
  language?: string;
  pdfMaxPages?: number | null;
  callbackUrl?: string;
  callbackEvents?: string[];
  itemsTotal: number;
  itemsProcessed: number;
  itemsFailed: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; pages: number; ocrTokens?: number; llmTokens?: number };
  costTotal: number;
  costOcr?: number;
  costLlm?: number;
  costCurrency?: string;
  lastItemAt?: string;
  createdAt?: string;
}

export interface OcrJobItemView {
  id: string;
  index: number;
  fileName?: string;
  status: OcrItemStatus;
  result?: { fullText?: string; summary?: string; structured?: Record<string, unknown>; pages?: number };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; pages?: number };
  costTotal?: number;
  costCurrency?: string;
  callbackStatus?: string;
  errorMessage?: string;
}

export interface CreateOcrJobBody {
  name?: string;
  bucketKey: string;
  ocrModelKey: string;
  llmModelKey?: string;
  outputs: OcrOutputKind[];
  summaryPrompt?: string;
  structuredSchema?: Record<string, unknown>;
  language?: string;
  pdfMaxPages?: number;
  callbackUrl?: string;
  callbackSecret?: string;
  callbackEvents?: string[];
}

export interface ItemSourceDraft {
  source:
    | { kind: 'inline'; data: string; fileName?: string; contentType?: string }
    | { kind: 'url'; url: string; contentType?: string }
    | { kind: 'bucket'; bucketKey: string; objectKey: string };
  fileName?: string;
}

export interface ModelOption { value: string; label: string }
export interface BucketOption { value: string; label: string }

/** The address that downloads a job's results (opened in a new tab, so it is a link and not a request). */
export const ocrJobExportUrl = (id: string, format: 'json' | 'jsonl' | 'csv') =>
  `/api/ocr-jobs/${id}/export?format=${format}`;

/** Read a File into base64 (no data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export const STATUS_BADGE: Record<string, string> = {
  active: 'success',
  paused: 'paused',
  archived: 'paused',
  pending: 'paused',
  running: 'warn',
  succeeded: 'success',
  failed: 'error',
};

export function formatCost(value?: number, currency?: string): string {
  if (!value) return '—';
  const cur = currency || 'USD';
  return `${cur} ${value.toFixed(4)}`;
}
