/**
 * Request-body readers for the OCR settings of the Knowledge Engine routes, shared by the dashboard and the client
 * API (kept out of the plugin files so a test that replaces one plugin does not take these with it).
 */

import { normalizeOcrSettings, validateOcrModelRef, type OcrSettings } from '@/lib/services/extraction';

/**
 * OCR for one upload: `{ ocr: {...} }` replaces the module's setting for this file, `{ ocr: null }` switches it off,
 * absent leaves the module's setting in force. Throws a sentence for a 400.
 */
export function readDocumentExtraction(
  body: Record<string, unknown>,
): { ocr?: OcrSettings | null } | undefined {
  const raw = body.extraction;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('extraction must be an object');
  const extraction = raw as Record<string, unknown>;
  for (const key of Object.keys(extraction)) {
    if (key !== 'ocr') throw new Error(`extraction.${key} is not a known setting`);
  }
  if (extraction.ocr === undefined) return {};
  const { value, error } = normalizeOcrSettings(extraction.ocr);
  if (error) throw new Error(`extraction.${error}`);
  return { ocr: value ?? null };
}

/**
 * The reason an OCR setting names an unusable model (not in the project, or one that cannot read documents), as a
 * sentence for a 400; `undefined` when there is nothing to object to.
 */
export async function ocrModelProblem(
  scope: { tenantDbName: string; tenantId: string; projectId?: string },
  ocr: OcrSettings | null | undefined,
): Promise<string | undefined> {
  if (!ocr || ocr.mode === 'off' || !ocr.modelKey) return undefined;
  return validateOcrModelRef(scope, ocr.modelKey);
}
