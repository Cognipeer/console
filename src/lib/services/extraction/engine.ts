/**
 * The one place that turns the bytes of a document into Markdown for every consumer (Knowledge Engine, Files, agent
 * attachments, crawler, connectors, evaluations).
 *
 * Two things the converter library does not do for its caller happen first, for every conversion:
 *
 * 1. Container documents are measured. A Word, PowerPoint, Excel or EPUB file is a ZIP container whose parts the
 *    readers inflate and parse in memory, and what a container unpacks to is not told by its size on disk. A
 *    document that unpacks to more than the ceiling (see `files/zipGuard`), or that cannot be followed to the end,
 *    is turned away with a sentence for people before any reader opens it. An out-of-memory stop of the process is
 *    not something the caller's `try/catch` could handle.
 * 2. The PowerPoint reader of older library versions copies the document to a working file in the process's current
 *    directory and only removes it when the whole read went well. Reads of that kind take turns here, and whatever
 *    file the read left behind is removed again, so a failed read keeps no copy of the document on the server's disk
 *    and two reads never share a file name.
 *
 * Then, with OCR switched off (the default) the conversion is exactly the library's plain call. With OCR on, the
 * library reads the text layer of every PDF page and sends the pages (or images) that have none to the project's OCR
 * model or to the local Tesseract engine; whatever goes wrong with OCR leaves the native text as the answer.
 */

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@/lib/core/logger';
import { getRequestContext, runWithRequestContext } from '@/lib/core/requestContext';
import { inspectZip, startsLikeZip, type ZipVerdict } from '@/lib/services/files/zipGuard';
import { extractMarkdownContent } from './content';
import { linkSignals } from './signals';
import {
  isImageFile,
  isOcrCandidate,
  ocrDefaults,
  ocrLanguages,
} from './settings';
import {
  convertPlain,
  getConvertToMarkdownDetailed,
  type DetailedConversion,
  type DetailedConversionOptions,
  type OcrOptions,
} from './toMarkdownApi';
import type {
  ConvertedDocument,
  ExtractionReport,
  ExtractionRequest,
  ExtractionResult,
  ExtractionScope,
  OcrSettings,
  ZipLimits,
} from './types';

const logger = createLogger('extraction');

const MIB = 1024 * 1024;

/** The document was not handed to a reader. The message is written for the person who uploaded it. */
export class DocumentConversionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentConversionRefused';
  }
}

export interface DocumentConversionOptions {
  /** The ceilings the container check applies. The defaults are the product's; a test narrows them. */
  limits?: ZipLimits;
  /** Where the PowerPoint reader keeps its working file: the process's current directory. A test points it elsewhere. */
  workingDirectory?: string;
}

/** The names whose reader opens the file as a ZIP container. */
const CONTAINER_EXTENSIONS: ReadonlySet<string> = new Set(['.docx', '.pptx', '.epub', '.xlsx', '.xls', '.zip']);

/** A legacy workbook is a compound file; the spreadsheet reader takes it for one whatever its name says. */
const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const POWERPOINT_WORKING_FILE = /^temp_pptx_(\d+)\.zip$/;

function readsAsContainer(extension: string, buffer: Buffer): boolean {
  // Without an extension the converter names the type from the content.
  if (extension === '') return startsLikeZip(buffer);
  if (!CONTAINER_EXTENSIONS.has(extension)) return false;
  if ((extension === '.xls' || extension === '.xlsx') && buffer.subarray(0, COMPOUND_FILE_SIGNATURE.length).equals(COMPOUND_FILE_SIGNATURE)) {
    return false;
  }
  return true;
}

function refusalOf(verdict: ZipVerdict): string | undefined {
  switch (verdict.kind) {
    case 'too_large':
      return `The document unpacks to more than ${Math.round(verdict.limitBytes / MIB)} MB, so it was not converted.`;
    case 'too_many_entries':
      return `The document is made of more than ${verdict.limit} parts, so it was not converted.`;
    case 'unreadable':
      return `The document could not be checked before conversion (${verdict.reason}), so it was not converted.`;
    default:
      return undefined;
  }
}

/** Reads of the PowerPoint reader take turns: they share a working directory and name their file by the clock. */
let powerPointTurn: Promise<unknown> = Promise.resolve();

function takeTurn<T>(work: () => Promise<T>): Promise<T> {
  const mine = powerPointTurn.then(work, work);
  powerPointTurn = mine.then(() => undefined, () => undefined);
  return mine;
}

/**
 * Removes the copy of `content` that a read begun in `[from, to]` left in `directory`. A file is only taken for the
 * read's own when its name carries a time inside that window and its bytes are the document's: another file that
 * looks alike is not touched. Never throws: there is nothing more to do when a file is already gone.
 */
export async function removePowerPointWorkingFiles(
  directory: string,
  window: { from: number; to: number },
  content: Buffer,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const match = POWERPOINT_WORKING_FILE.exec(name);
    if (!match) continue;
    const stamp = Number(match[1]);
    if (!(stamp >= window.from && stamp <= window.to)) continue;
    const file = path.join(directory, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size !== content.length) continue;
      if (!(await readFile(file)).equals(content)) continue;
      await unlink(file);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/**
 * Runs `convert` for one document behind the container check, and (for a PowerPoint file, unless `ownTurn` is
 * false) inside the PowerPoint working-file turn. Throws `DocumentConversionRefused` for a container that is over
 * the ceilings; any other failure is `convert`'s own.
 */
export async function runGuardedConversion<T>(
  buffer: Buffer,
  fileName: string,
  options: DocumentConversionOptions,
  convert: () => Promise<T>,
  behaviour: { powerPointTurn?: boolean } = {},
): Promise<T> {
  const extension = path.extname(fileName).toLowerCase();

  if (readsAsContainer(extension, buffer)) {
    const verdict = await inspectZip(buffer, options.limits);
    const refusal = refusalOf(verdict);
    if (refusal) {
      logger.warn('A document was not converted because of what it unpacks to', { verdict: verdict.kind });
      throw new DocumentConversionRefused(refusal);
    }
  }

  // `.pptx` by name, or a ZIP container the converter will name from its content when the file has no extension.
  if (behaviour.powerPointTurn !== false && (extension === '.pptx' || (extension === '' && startsLikeZip(buffer)))) {
    return takeTurn(async () => {
      const from = Date.now();
      try {
        return await convert();
      } finally {
        await removePowerPointWorkingFiles(options.workingDirectory ?? process.cwd(), { from, to: Date.now() }, buffer);
      }
    });
  }
  return convert();
}

/**
 * Converts one document with the plain call of the converter, behind the guards. This is what the Document Store's
 * `convertDocumentToMarkdown` is.
 */
export function convertGuarded(
  buffer: Buffer,
  fileName: string,
  options: DocumentConversionOptions = {},
): Promise<ConvertedDocument> {
  return runGuardedConversion(buffer, fileName, options, () => convertPlain(buffer, { fileName }));
}

/* ── OCR ─────────────────────────────────────────────────────────────────── */

function isAbortError(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
}

function callerAbort(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('The extraction was aborted');
  error.name = 'AbortError';
  return error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Binds the tenant database and (when the call has no request around it) the attribution for the work of a job. */
async function inTenantScope<T>(scope: ExtractionScope, work: () => Promise<T>): Promise<T> {
  const { runWithTenantScope } = await import('@/lib/database');
  return runWithTenantScope(scope.tenantDbName, () => {
    if (getRequestContext()) return work();
    return runWithRequestContext(
      {
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        userId: scope.userId,
        actorType: scope.userId ? 'user' : 'system',
        source: 'system',
      },
      work,
    );
  });
}

async function plainResult(
  req: ExtractionRequest,
  warnings: string[],
  guard: DocumentConversionOptions,
): Promise<ExtractionResult> {
  const options = {
    fileName: req.fileName,
    ...(req.images && req.images !== 'inline' ? { images: req.images } : {}),
  };
  const raw = await runGuardedConversion(req.data, req.fileName, guard, () => convertPlain(req.data, options));
  return { raw, text: extractMarkdownContent(raw) ?? '', report: { sourceType: 'converted', warnings } };
}

interface Backend {
  engine: 'model' | 'local';
  modelKey?: string;
  options: OcrOptions;
  warnings: string[];
  /** Calls made to the OCR model so far (filled in while the document is read). */
  stats?: { calls: number; budgetDenied?: string };
}

function reportOf(
  detailed: DetailedConversion,
  req: ExtractionRequest,
  backend: Backend,
  extraWarnings: string[],
): ExtractionReport {
  const pageReports = detailed.pages ?? [];
  const ocrPages = pageReports.filter((page) => page.source === 'ocr').map((page) => page.page);
  const ocrImages = detailed.stats?.ocrImages ?? 0;
  const ocrCalls = detailed.stats?.ocrCalls ?? 0;
  const pageCount = detailed.stats?.pageCount ?? (pageReports.length > 0 ? pageReports.length : undefined);

  let sourceType: ExtractionReport['sourceType'];
  if (isImageFile(req.fileName, req.contentType)) {
    sourceType = ocrCalls > 0 || ocrImages > 0 || ocrPages.length > 0 ? 'ocr' : 'converted';
  } else if (ocrPages.length === 0 && ocrImages === 0) {
    sourceType = 'converted';
  } else if (ocrImages === 0 && pageCount !== undefined && pageCount > 0 && ocrPages.length >= pageCount) {
    sourceType = 'ocr';
  } else {
    sourceType = 'mixed';
  }

  return {
    sourceType,
    ...(sourceType !== 'converted' ? { engine: backend.engine } : {}),
    ...(sourceType !== 'converted' && backend.modelKey ? { modelKey: backend.modelKey } : {}),
    ...(pageCount !== undefined ? { pageCount } : {}),
    ...(ocrPages.length > 0 ? { ocrPages } : {}),
    ...(ocrImages > 0 ? { ocrImages } : {}),
    ...(ocrCalls > 0 ? { ocrCalls } : {}),
    ...(detailed.stats?.ocrMs ? { ocrMs: detailed.stats.ocrMs } : {}),
    warnings: [...extraWarnings, ...(detailed.warnings ?? [])],
  };
}

/** The OCR options common to both backends. */
function commonOcrOptions(
  req: ExtractionRequest,
  ocr: OcrSettings,
  engine: 'model' | 'local',
  signal: AbortSignal,
): OcrOptions {
  const defaults = ocrDefaults();
  const requested = ocr.maxPages ?? defaults.maxPages;
  return {
    pdfMode: ocr.mode === 'auto' ? 'auto-page' : 'always',
    maxPages: Math.min(requested, defaults.maxPagesLimit),
    concurrency: engine === 'model' ? defaults.modelConcurrency : defaults.localConcurrency,
    timeoutMs: defaults.callTimeoutMs,
    signal,
    ...(req.onProgress
      ? { onProgress: (event) => req.onProgress?.({ completed: event.completed, total: event.total }) }
      : {}),
    // A page or image that cannot be read is a warning of the report, never text inside the document.
    onError: 'skip',
    ...(ocr.images ? { embeddedImages: { minWidth: 64, minHeight: 64, maxImages: 30 } } : {}),
  };
}

/** Resolves who reads the document: the project's OCR model, or the local engine. */
async function chooseBackend(
  req: ExtractionRequest,
  ocr: OcrSettings,
  signal: AbortSignal,
  remainingMs: () => number,
): Promise<Backend | { fallback: string }> {
  const languages = ocrLanguages(ocr);

  if (ocr.modelKey) {
    const { resolveOcrModel } = await import('./ocrModels');
    const { checkOcrBudget, createModelOcrHandlers, ocrQuotaContext } = await import('./modelOcr');
    const resolved = await resolveOcrModel(req.scope, ocr.modelKey);
    if ('error' in resolved) return { fallback: `ocr_model_unavailable: ${resolved.error}` };

    const quota = ocrQuotaContext(req.scope, ocr.modelKey);
    const denied = await checkOcrBudget(quota);
    if (denied) return { fallback: `ocr_budget_exceeded: ${denied}` };

    const current = getRequestContext();
    const stats: { calls: number; budgetDenied?: string } = { calls: 0 };
    const handlers = createModelOcrHandlers({
      scope: req.scope,
      modelKey: ocr.modelKey,
      resolved,
      languages,
      fileName: req.fileName,
      remainingMs,
      signal,
      quota,
      stats,
      attribution: {
        ...(req.scope.userId ? { userId: req.scope.userId } : {}),
        ...(req.scope.projectId ? { projectId: req.scope.projectId } : {}),
        ...(current?.actorType ? {} : { actorType: req.scope.userId ? 'user' : 'system' }),
      },
    });
    return {
      engine: 'model',
      modelKey: ocr.modelKey,
      options: {
        ...commonOcrOptions(req, ocr, 'model', signal),
        provider: 'handler',
        handler: handlers.handler,
        ...(handlers.documentHandler ? { documentHandler: handlers.documentHandler } : {}),
      },
      warnings: [],
      stats,
    };
  }

  const { getLocalOcrEngine } = await import('./localOcr');
  try {
    const plan = await getLocalOcrEngine().prepare(languages);
    return {
      engine: 'local',
      options: { ...commonOcrOptions(req, ocr, 'local', signal), ...plan.options },
      warnings: plan.warnings,
    };
  } catch (error) {
    return { fallback: `ocr_unavailable: ${messageOf(error)}` };
  }
}

async function ocrResult(
  req: ExtractionRequest,
  ocr: OcrSettings,
  guard: DocumentConversionOptions,
): Promise<ExtractionResult> {
  const detailedConvert = getConvertToMarkdownDetailed();
  if (!detailedConvert) {
    return plainResult(req, ['ocr_unavailable: the installed converter does not support OCR'], guard);
  }

  const defaults = ocrDefaults();
  const budgetMs = req.budget === 'background' ? defaults.documentTimeoutMs : defaults.inlineTimeoutMs;
  const abortAfter = (controller: AbortController, message: string) =>
    setTimeout(() => {
      const error = new Error(message);
      error.name = 'AbortError';
      controller.abort(error);
    }, budgetMs);

  // The document's clock starts when its reading starts, not while it waits for the node's local OCR slot.
  const deadline = new AbortController();
  let deadlineAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startDeadline = () => {
    if (deadlineAt !== undefined) return;
    deadlineAt = Date.now() + budgetMs;
    timer = abortAfter(deadline, `The document was not read within ${Math.round(budgetMs / 1000)} s`);
  };
  const remainingMs = () => (deadlineAt === undefined ? budgetMs : Math.max(0, deadlineAt - Date.now()));
  // Waiting for the slot has a limit of its own, of the same size.
  const slotWait = new AbortController();
  let slotTimer: ReturnType<typeof setTimeout> | undefined;
  let slotTimedOut = false;

  const linked = linkSignals(req.signal, deadline.signal);
  const warnings: string[] = [];
  // Set when the native text is to be returned instead; the plain conversion then runs once, after the OCR work is over.
  let nativeWith: string[] | undefined;

  try {
    const backend = await chooseBackend(req, ocr, linked.signal, remainingMs);
    if ('fallback' in backend) {
      nativeWith = [backend.fallback];
    } else {
      warnings.push(...backend.warnings);

      const options: DetailedConversionOptions = {
        fileName: req.fileName,
        ...(req.images && req.images !== 'inline' ? { images: req.images } : {}),
        ocr: backend.options,
      };
      // A library that has `convertToMarkdownDetailed` reads a presentation from memory: no working file to take turns for.
      const run = () => {
        startDeadline();
        return runGuardedConversion(req.data, req.fileName, guard, () => detailedConvert(req.data, options), { powerPointTurn: false });
      };

      let detailed: DetailedConversion;
      if (backend.engine === 'local') {
        const { withLocalOcrSlot } = await import('./localOcr');
        slotTimer = setTimeout(() => {
          slotTimedOut = true;
          const error = new Error(`No OCR slot became free within ${Math.round(budgetMs / 1000)} s`);
          error.name = 'AbortError';
          slotWait.abort(error);
        }, budgetMs);
        const waiting = linkSignals(req.signal, slotWait.signal);
        try {
          detailed = await withLocalOcrSlot(waiting.signal, () => {
            clearTimeout(slotTimer);
            return run();
          });
        } finally {
          waiting.dispose();
        }
      } else {
        detailed = await run();
      }
      if (backend.stats?.budgetDenied) warnings.push(`ocr_budget_exceeded: ${backend.stats.budgetDenied}`);
      const raw: ConvertedDocument = detailed.markdown;
      return { raw, text: extractMarkdownContent(raw) ?? '', report: reportOf(detailed, req, backend, warnings) };
    }
  } catch (error) {
    // The caller gave up: that is the caller's answer, not a reason to read the document again.
    if (req.signal?.aborted) throw isAbortError(error) ? error : callerAbort(req.signal);
    if (error instanceof DocumentConversionRefused) throw error;

    const timedOut = deadline.signal.aborted || isAbortError(error);
    logger.warn(
      slotTimedOut
        ? 'Document OCR found no free slot; keeping the native text'
        : timedOut
          ? 'Document OCR ran out of time; keeping the native text'
          : 'Document OCR failed; keeping the native text',
      {
        source: req.source,
        extension: path.extname(req.fileName).toLowerCase(),
        error: messageOf(error),
      },
    );
    // `report.warnings` carries the provider's own wording: a consumer that stores or shows it goes through the
    // consumers' `recordedWarnings`, which keeps the stable code only.
    nativeWith = [
      ...warnings,
      slotTimedOut ? 'ocr_busy' : timedOut ? `ocr_timeout: ${messageOf(error)}` : `ocr_failed: ${messageOf(error)}`,
    ];
  } finally {
    clearTimeout(timer);
    clearTimeout(slotTimer);
    linked.dispose();
  }
  return plainResult(req, nativeWith ?? [], guard);
}

/**
 * Turns one document into Markdown. With no OCR setting (or a file OCR does not apply to) the result is the
 * converter's plain answer, byte for byte what it was before OCR existed. With OCR on, pages and images without a
 * text layer are read by the project's OCR model or by the local engine; if OCR cannot finish in time or fails, the
 * native text is returned with a warning in the report. A caller's abort throws an `AbortError`.
 */
export async function extractDocument(req: ExtractionRequest): Promise<ExtractionResult> {
  if (req.signal?.aborted) throw callerAbort(req.signal);
  const started = Date.now();
  const guard: DocumentConversionOptions = { limits: req.limits, workingDirectory: req.workingDirectory };
  const ocr = isOcrCandidate(req.fileName, req.contentType, req.ocr) ? (req.ocr as OcrSettings) : undefined;

  let result: ExtractionResult;
  if (!ocr) {
    result = await plainResult(req, [], guard);
  } else if (ocr.modelKey) {
    result = await inTenantScope(req.scope, () => ocrResult(req, ocr, guard));
  } else {
    result = await ocrResult(req, ocr, guard);
  }

  logger.info('Document extracted', {
    source: req.source,
    extension: path.extname(req.fileName).toLowerCase(),
    bytes: req.data.length,
    pages: result.report.pageCount,
    ocrPages: result.report.ocrPages?.length ?? 0,
    ocrImages: result.report.ocrImages ?? 0,
    engine: result.report.engine,
    sourceType: result.report.sourceType,
    warnings: result.report.warnings.length,
    ms: Date.now() - started,
  });
  return result;
}
