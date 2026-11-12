'use client';

/**
 * React Query hooks of the dataset import wizard (`/api/dataset-import`, and the PII category catalog it offers).
 *
 * The wizard reads the catalog of built-in PII categories; format detection and the URL fetch are reads the user
 * triggers (a debounced content change, a button), so they are mutations; the import itself is a mutation.
 * Importing creates an evaluation dataset: the screens that list datasets reread their list when they open.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api/client';
import type { DatasetImportFormat } from '@/components/datasetImport/importHelpers';
import { retryUnlessClientError } from './errors';
import { useResourceKey } from './projectScope';

/** Row shape of GET /api/pii/categories → categories[]. */
export interface PiiCategoryOption {
  id: string;
  label: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  defaultEnabled: boolean;
}

/** Pinned POST /api/dataset-import/detect response shape. */
export interface DetectPreviewItem {
  input: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  expected?: {
    reference?: string;
    toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
  };
}
export interface DetectResponse {
  format?: DatasetImportFormat;
  preview: {
    items: DetectPreviewItem[];
    counts: { parsed: number; skipped: Record<string, number> };
  };
}

/** Pinned POST /api/dataset-import response shape. */
export interface ImportResult {
  datasetId: string;
  created: number;
  skipped: Record<string, number>;
  piiFindings: number;
}


export interface DatasetImportRequest {
  content: string;
  format: DatasetImportFormat;
  name: string;
  sourceLabel?: string;
  anonymize: { categories: string[]; strategy: 'mask' | 'pseudonym'; salt?: string };
}

export const datasetImportKeys = {
  all: ['dataset-import'] as const,
  piiCategories: (project: string, locale: string) => ['dataset-import', project, 'pii-categories', locale] as const,
};

/** The built-in PII categories with labels in `locale`. */
export function useImportPiiCategories(locale: string) {
  const [, project] = useResourceKey('dataset-import');
  return useQuery({
    queryKey: datasetImportKeys.piiCategories(project, locale),
    queryFn: async ({ signal }) =>
      (
        await apiGet<{ categories?: PiiCategoryOption[] }>(`/api/pii/categories?locale=${encodeURIComponent(locale)}`, {
          signal,
        })
      ).categories ?? [],
    retry: retryUnlessClientError,
  });
}

export function useDetectImportFormat() {
  return useMutation({
    mutationFn: (content: string) => apiPost<DetectResponse>('/api/dataset-import/detect', { content }),
  });
}

export function useFetchImportUrl() {
  return useMutation({
    mutationFn: async (url: string) => (await apiPost<{ content?: unknown }>('/api/dataset-import/fetch', { url })).content,
  });
}

export function useCreateDatasetImport() {
  return useMutation({
    mutationFn: (request: DatasetImportRequest) => apiPost<ImportResult>('/api/dataset-import', request),
  });
}
