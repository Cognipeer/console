/**
 * OCR through a project model, as the two handlers `@cognipeer/to-markdown` calls: one for a page or an image, one
 * (for drivers that read a whole PDF) for a list of pages. Every call goes through `handleOcrRequest`, so the
 * model's provider, credentials, resilience, usage log and cost accounting are the ones every other OCR call has.
 */

import { createLogger } from '@/lib/core/logger';
import { handleOcrRequest } from '@/lib/services/models/inferenceService';
import { calculateCost } from '@/lib/services/models/usageLogger';
import { checkBudget, settleUsageBudget, type QuotaContext } from '@/lib/quota/quotaGuard';
import type { UsageAttribution } from '@/lib/services/usage/usageEvents';
import type { OcrDocumentHandler, OcrHandler } from './toMarkdownApi';
import type { ResolvedOcrModel } from './ocrModels';
import { ocrDefaults } from './settings';
import type { ExtractionScope } from './types';

const logger = createLogger('extraction:model-ocr');

/**
 * Asked of vision models that have no OCR prompt of their own. It keeps the strict JSON envelope the vision OCR
 * runtime parses (`{ "text": ... }`) and asks for Markdown inside `text`.
 */
export const MARKDOWN_OCR_PROMPT = `You are an OCR engine. Transcribe all the text of the provided page image and return it as STRICT JSON matching this type:

type OcrJson = {
  text: string;      // the page as Markdown
  language?: string; // ISO 639-1 if detectable
};

Rules:
- Put the whole page in "text" as Markdown, in natural reading order: headings as "#" headings, lists as lists, tables as GitHub-flavoured Markdown tables.
- Transcribe exactly what is printed. Do not translate, summarize, correct or explain.
- Do not add commentary, and do not describe pictures.
- If the page has no text, return {"text": ""}.

Respond with JSON only.`;

export interface ModelOcrContext {
  scope: ExtractionScope;
  modelKey: string;
  resolved: ResolvedOcrModel;
  /** ISO 639-1 languages; the first one is sent as the language hint. */
  languages: string[];
  fileName?: string;
  /** Milliseconds a whole-document call may take (the document budget that is left). */
  documentBudgetMs?: number;
  signal?: AbortSignal;
  quota?: QuotaContext;
  attribution?: Partial<UsageAttribution>;
  /** Filled in as calls complete. */
  stats?: { calls: number };
}

export interface ModelOcrHandlers {
  handler: OcrHandler;
  /** Only for drivers that read a whole PDF. */
  documentHandler?: OcrDocumentHandler;
}

/** The quota context an OCR model's calls are metered under (domain `ocr`, resource = the model). */
export function ocrQuotaContext(scope: ExtractionScope, modelKey: string): QuotaContext | undefined {
  if (!scope.projectId) return undefined;
  return {
    tenantDbName: scope.tenantDbName,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    userId: scope.userId,
    domain: 'ocr',
    resourceKey: modelKey,
  };
}

/** Pre-flight budget check, once per document. `undefined` = allowed; otherwise the reason it was refused. */
export async function checkOcrBudget(quota: QuotaContext | undefined): Promise<string | undefined> {
  if (!quota) return undefined;
  try {
    const verdict = await checkBudget(quota);
    return verdict.allowed ? undefined : verdict.reason || 'budget exceeded';
  } catch (error) {
    // A budget that cannot be read must not stop a document from being read.
    logger.warn('The OCR budget could not be checked', { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function settle(ctx: ModelOcrContext, model: ResolvedOcrModel['model'], usage: Parameters<typeof calculateCost>[1]): void {
  if (!ctx.quota) return;
  try {
    void settleUsageBudget(ctx.quota, calculateCost(model.pricing, usage));
  } catch (error) {
    logger.warn('The OCR spend could not be settled', { error: error instanceof Error ? error.message : String(error) });
  }
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('The OCR call was aborted');
  error.name = 'AbortError';
  return error;
}

function textOf(response: { text?: string } & { markdown?: unknown }): string {
  return typeof response.markdown === 'string' && response.markdown.length > 0 ? response.markdown : (response.text ?? '');
}

export function createModelOcrHandlers(ctx: ModelOcrContext): ModelOcrHandlers {
  const defaults = ocrDefaults();
  const { resolved } = ctx;
  const projectId = ctx.scope.projectId as string;
  const language = ctx.languages[0];
  const prompt = resolved.vlm && !resolved.hasCustomPrompt ? MARKDOWN_OCR_PROMPT : undefined;

  const handler: OcrHandler = async (buffer, context) => {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    const result = await handleOcrRequest({
      tenantDbName: ctx.scope.tenantDbName,
      modelKey: ctx.modelKey,
      projectId,
      input: {
        document: {
          kind: 'bytes',
          data: buffer,
          contentType: context.mimeType ?? 'image/png',
          fileName: context.fileName ?? ctx.fileName,
        },
        ...(language ? { language } : {}),
        ...(prompt ? { prompt } : {}),
      },
      allowVisionLlm: true,
      ...(ctx.attribution ? { attribution: ctx.attribution } : {}),
      resilience: { timeoutMs: defaults.callTimeoutMs, retry: { maxAttempts: 2 } },
      logErrors: true,
    });
    if (ctx.stats) ctx.stats.calls += 1;
    settle(ctx, result.model, result.usage);
    return { text: textOf(result.response as { text?: string; markdown?: unknown }) };
  };

  if (!resolved.documentLevel) return { handler };

  const documentHandler: OcrDocumentHandler = async (pdf, context) => {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    const timeoutMs = Math.max(
      1_000,
      Math.min(defaults.documentTimeoutMs, ctx.documentBudgetMs ?? defaults.documentTimeoutMs),
    );
    const result = await handleOcrRequest({
      tenantDbName: ctx.scope.tenantDbName,
      modelKey: ctx.modelKey,
      projectId,
      input: {
        document: { kind: 'bytes', data: pdf, contentType: 'application/pdf', fileName: context.fileName ?? ctx.fileName },
        pages: context.pages,
        ...(language ? { language } : {}),
      },
      allowVisionLlm: true,
      ...(ctx.attribution ? { attribution: ctx.attribution } : {}),
      // One long call: a retry would pay for the whole document twice.
      resilience: { timeoutMs, retry: { enabled: false } },
      logErrors: true,
    });
    if (ctx.stats) ctx.stats.calls += 1;
    settle(ctx, result.model, result.usage);

    const pages = result.response.pages ?? [];
    const requested = context.pages;
    const mapped = pages.map((page, index) => ({
      // Pages come back with their own number; when they do not, they are in the order that was asked for.
      page: typeof page.pageNumber === 'number' ? page.pageNumber : (requested[index] ?? index + 1),
      text: page.text ?? '',
    }));
    if (mapped.length > 0) return mapped;
    // A driver that answered with the document's text only: it is the text of the single page asked for.
    if (requested.length === 1 && result.response.text) return [{ page: requested[0], text: result.response.text }];
    return [];
  };

  return { handler, documentHandler };
}
