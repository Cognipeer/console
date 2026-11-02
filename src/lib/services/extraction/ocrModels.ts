/**
 * Which project models can read text out of a document: models of category `ocr` and vision LLMs (category `llm`
 * that take images). Used by every place that saves an OCR setting and by the engine when it runs one.
 */

import { getModelByKey } from '@/lib/services/models/modelService';
import { primaryReplicaModel } from '@/lib/services/models/replicaPool';
import type { IModel } from '@/lib/database';
import type { ExtractionScope } from './types';

export interface ResolvedOcrModel {
  model: IModel;
  kind: 'ocr' | 'vision-llm';
  driver: string;
  /** The driver reads a whole PDF and a page selection in one call (Mistral OCR, Azure Document Intelligence). */
  documentLevel: boolean;
  /** The driver is a vision model prompted to transcribe (so the Markdown prompt applies). */
  vlm: boolean;
  /** The model carries its own OCR prompt; the engine must not override it. */
  hasCustomPrompt: boolean;
}

/**
 * Drivers that take a whole PDF and a page list in one call. Google Document AI's per-page text is not usable and
 * Textract's synchronous API reads one page, so those (and every vision model) are read page by page as images.
 */
const DOCUMENT_LEVEL_DRIVERS: ReadonlySet<string> = new Set(['mistral-ocr', 'azure-document-intelligence']);

/** Drivers whose OCR is a transcription by a vision model. */
const VLM_DRIVERS: ReadonlySet<string> = new Set([
  'openai', 'openai-compatible', 'anthropic', 'bedrock', 'vertex', 'azure',
]);

function customPromptOf(model: IModel): boolean {
  const ocr = (model.settings as Record<string, unknown> | undefined)?.ocr;
  if (!ocr || typeof ocr !== 'object') return false;
  const prompt = (ocr as Record<string, unknown>).prompt;
  return typeof prompt === 'string' && prompt.trim().length > 0;
}

function classify(model: IModel): 'ocr' | 'vision-llm' | undefined {
  if (model.category === 'ocr') return 'ocr';
  if (model.category === 'llm' && model.isMultimodal === true) return 'vision-llm';
  return undefined;
}

/** The model for a key in the scope's project, with what the engine needs to know about its driver. */
export async function resolveOcrModel(
  scope: ExtractionScope,
  modelKey: string,
): Promise<ResolvedOcrModel | { error: string }> {
  if (!scope.projectId) return { error: 'An OCR model can only be used inside a project.' };
  let found: IModel | null;
  try {
    found = await getModelByKey(scope.tenantDbName, modelKey, scope.projectId);
  } catch (error) {
    return { error: `The OCR model "${modelKey}" could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!found) return { error: `The OCR model "${modelKey}" was not found in this project.` };
  const model = primaryReplicaModel(found);
  const kind = classify(model);
  if (!kind) {
    return { error: `The model "${modelKey}" cannot read documents: it must be an OCR model or a vision model.` };
  }
  const driver = model.providerDriver;
  const ocrMode = ((model.settings as Record<string, unknown> | undefined)?.ocr as Record<string, unknown> | undefined)?.mode;
  return {
    model,
    kind,
    driver,
    documentLevel: kind === 'ocr' && DOCUMENT_LEVEL_DRIVERS.has(driver),
    vlm: kind === 'vision-llm' || ocrMode === 'vlm' || (ocrMode !== 'native' && VLM_DRIVERS.has(driver)),
    hasCustomPrompt: customPromptOf(model),
  };
}

/**
 * Save-time check of an OCR model reference: `undefined` when the model exists in the project and can read
 * documents, otherwise a sentence for the person saving the setting.
 */
export async function validateOcrModelRef(scope: ExtractionScope, modelKey: string): Promise<string | undefined> {
  const resolved = await resolveOcrModel(scope, modelKey);
  return 'error' in resolved ? resolved.error : undefined;
}
