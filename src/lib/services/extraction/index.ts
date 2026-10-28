/**
 * Document extraction: Markdown out of the bytes of a document, with optional OCR. See `engine.ts`.
 *
 * The barrel stays light on purpose: the model and database code the OCR path needs is loaded when it is used.
 */

export { extractDocument, convertGuarded, DocumentConversionRefused, removePowerPointWorkingFiles } from './engine';
export type { DocumentConversionOptions } from './engine';
export { extractMarkdownContent } from './content';
export {
  effectiveOcr,
  isImageFile,
  isOcrActive,
  isOcrCandidate,
  normalizeOcrSettings,
  ocrDefaults,
  ocrLanguages,
} from './settings';
export type {
  ConvertedDocument,
  ExtractionReport,
  ExtractionRequest,
  ExtractionResult,
  ExtractionScope,
  ExtractionSource,
  ImagePolicy,
  OcrMode,
  OcrSettings,
} from './types';

import type { ExtractionScope } from './types';

/** Save-time check of an OCR model reference: `undefined` when usable, otherwise a sentence for the person saving. */
export async function validateOcrModelRef(scope: ExtractionScope, modelKey: string): Promise<string | undefined> {
  const { validateOcrModelRef: validate } = await import('./ocrModels');
  return validate(scope, modelKey);
}
