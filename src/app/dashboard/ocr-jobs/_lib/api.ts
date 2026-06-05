/**
 * Dashboard API client for OCR Jobs (v2 container model).
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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    cache: 'no-store',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export const ocrJobsApi = {
  list: () => req<{ jobs: OcrJobView[] }>('/api/ocr-jobs').then((r) => r.jobs ?? []),
  get: (id: string) => req<{ job: OcrJobView }>(`/api/ocr-jobs/${id}`).then((r) => r.job),
  create: (body: CreateOcrJobBody) =>
    req<{ job: OcrJobView }>('/api/ocr-jobs', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.job),
  update: (id: string, patch: Partial<CreateOcrJobBody> & { status?: OcrJobStatus }) =>
    req<{ job: OcrJobView }>(`/api/ocr-jobs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.job),
  remove: (id: string) => req<{ ok: boolean }>(`/api/ocr-jobs/${id}`, { method: 'DELETE' }),
  sendFiles: (id: string, items: ItemSourceDraft[], mode: 'sync' | 'async' = 'async') =>
    req<{ items: OcrJobItemView[] }>(`/api/ocr-jobs/${id}/files`, {
      method: 'POST',
      body: JSON.stringify({ items, mode }),
    }).then((r) => r.items ?? []),
  pause: (id: string) => req<{ job: OcrJobView }>(`/api/ocr-jobs/${id}/pause`, { method: 'POST' }).then((r) => r.job),
  resume: (id: string) => req<{ job: OcrJobView }>(`/api/ocr-jobs/${id}/resume`, { method: 'POST' }).then((r) => r.job),
  items: (id: string) => req<{ items: OcrJobItemView[] }>(`/api/ocr-jobs/${id}/items`).then((r) => r.items ?? []),
  exportUrl: (id: string, format: 'json' | 'jsonl' | 'csv') => `/api/ocr-jobs/${id}/export?format=${format}`,
};

export async function loadModelOptions(category: 'ocr' | 'llm'): Promise<ModelOption[]> {
  const res = await fetch(`/api/models?category=${category}`, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = (await res.json()) as { models?: Array<{ key: string; name: string }> };
  return (data.models ?? []).map((m) => ({ value: m.key, label: m.name }));
}

export async function loadBuckets(): Promise<BucketOption[]> {
  const res = await fetch('/api/files/buckets', { cache: 'no-store' });
  if (!res.ok) return [];
  const data = (await res.json()) as { buckets?: Array<{ key: string; name: string }> };
  return (data.buckets ?? []).map((b) => ({ value: b.key, label: b.name }));
}

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
