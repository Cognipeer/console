/**
 * L3 — local ONNX NER pass.
 *
 * Runs a token-classification model (`@huggingface/transformers`, the
 * onnxruntime-node backend) against text and produces `person`/
 * `organization`/`location` candidates. See
 * `internal-notes/pii-v2-nlp-ve-asset-registry-plani.md` §1 "L3 - NER
 * modelleri" for the design.
 *
 * NO WORKER POOL (product decision, 2026-09-09): inference runs in-process
 * on the app's own event loop, gated by a small in-process concurrency
 * limiter (`acquireSlot` below) rather than `worker_threads`. Isolation from
 * the request-handling process is deferred to a later integration with the
 * existing sandbox executor. Two consequences worth stating plainly:
 *
 *   1. CPU cost lands on the same process serving HTTP traffic. Under load
 *      this competes with everything else Node is doing — the load-test
 *      report quantifies exactly how much.
 *   2. `timeoutMs` below is a SOFT, JS-level timeout: `Promise.race`-ing a
 *      pipeline call stops the caller from waiting on it, but the
 *      onnxruntime-node native call underneath keeps running to completion
 *      (there is no cooperative cancellation point inside one inference
 *      call). A timeout therefore bounds latency for the caller, NOT the
 *      CPU actually spent — a genuine cap on wasted work needs either a
 *      worker thread that can be killed or chunking small enough that no
 *      single inference call is worth cancelling. This implementation takes
 *      the second route (windowing below), which is why timeouts are
 *      expected to fire rarely rather than being the primary defense.
 *
 * WHY OFFSETS ARE RECOMPUTED, NOT TRUSTED FROM THE PIPELINE: verified
 * empirically before writing this (see the plan's "tuzaklar" list) —
 * `@huggingface/transformers`'s BERT tokenizer does not support
 * `return_offsets_mapping` (confirmed against v3.8.1), and the pipeline's
 * per-token `word` field is the raw WordPiece surface form ("##gn" for a
 * mid-word continuation), not aligned to the source string. `decodeEntities`
 * below reconstructs character offsets by walking the token surfaces against
 * the original text directly, which is exact for this cased tokenizer
 * (no accent-stripping, no lowercasing) — see the same spike output for the
 * empty-catch fallback this guards against.
 */

// Loaded lazily, on the first NER call. The detector module (and through it
// the usage-log PII scrubber) is imported on every server boot, and a static
// import would pull transformers + onnxruntime-node native binaries into
// memory even when no NER model is configured — the default.
type Transformers = typeof import('@huggingface/transformers');
let transformers: Promise<Transformers> | null = null;
function loadTransformers(): Promise<Transformers> {
  transformers ??= import('@huggingface/transformers');
  return transformers;
}
import type { Candidate } from './confidence';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('pii-ner');

export type NerCategory = 'person' | 'organization' | 'location';

interface NerModelSpec {
  /** Directory name under `nerModelPath` — also the id policies reference in `detection.ner.models`. */
  id: string;
  languages: string[];
  /** Model's raw BIO type (PER/ORG/LOC) → PII category. */
  labelMap: Record<string, NerCategory>;
}

/**
 * The one model wired up for this local test: `akdeniz27/bert-base-turkish-cased-ner`
 * (dbmdz/bert-base-turkish-cased fine-tune, MIT-derived base, PER/ORG/LOC).
 * Downloaded directly from Hugging Face into `nerModelPath` for this
 * experiment — NOT via the (not-yet-built) signed asset registry.
 */
export const NER_MODELS: Record<string, NerModelSpec> = {
  'tr-ner': {
    id: 'tr-ner',
    languages: ['tr'],
    labelMap: { PER: 'person', ORG: 'organization', LOC: 'location' },
  },
};

const SEVERITY_BY_CATEGORY: Record<NerCategory, 'low' | 'medium' | 'high'> = {
  person: 'high',
  organization: 'medium',
  location: 'low',
};

// ── Environment + lazy pipeline loading ────────────────────────────────────

let configuredPath: string | null = null;
function ensureEnv(env: Transformers['env'], nerModelPath: string): void {
  if (configuredPath === nerModelPath) return;
  env.allowRemoteModels = false; // never phone home to huggingface.co at runtime
  env.allowLocalModels = true;
  env.localModelPath = nerModelPath;
  env.useFSCache = false;
  configuredPath = nerModelPath;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pipeline = any;
const pipelineCache = new Map<string, Promise<Pipeline>>();

function getPipeline(modelId: string, nerModelPath: string): Promise<Pipeline> {
  const cacheKey = `${nerModelPath}::${modelId}`;
  let loading = pipelineCache.get(cacheKey);
  if (!loading) {
    const t0 = Date.now();
    loading = loadTransformers()
      .then(({ pipeline, env }) => {
        ensureEnv(env, nerModelPath);
        return pipeline('token-classification', modelId, { dtype: 'fp32' });
      })
      .then((pl) => {
        logger.info('PII NER model loaded', { modelId, ms: Date.now() - t0 });
        return pl;
      })
      .catch((error) => {
        pipelineCache.delete(cacheKey); // don't cache a permanent failure — allow retry
        logger.warn('PII NER model load failed', { modelId, error });
        throw error;
      });
    pipelineCache.set(cacheKey, loading);
  }
  return loading;
}

/** True once a model's pipeline is loaded (or loading) — lets a caller report "cold" vs "warm" without forcing a load. */
export function isModelWarm(modelId: string, nerModelPath: string): boolean {
  return pipelineCache.has(`${nerModelPath}::${modelId}`);
}

// ── In-process concurrency gate (explicitly NOT a worker pool) ─────────────

let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(maxConcurrent: number): Promise<() => void> {
  if (inFlight >= maxConcurrent) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inFlight += 1;
  return () => {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  };
}

// ── Windowing ───────────────────────────────────────────────────────────

interface Window {
  text: string;
  offset: number;
}

/**
 * Split into windows no theoretically ever hits the model's 512-token limit
 * (Turkish subwording averages under 1 token/char, so 1500 chars is a wide
 * safety margin) while keeping each inference call short. NO OVERLAP: an
 * entity that straddles a window boundary is missed rather than
 * double-counted — a known, documented limitation (see the report), not
 * silently "handled".
 */
function splitIntoWindows(text: string, maxChars: number): Window[] {
  if (text.length <= maxChars) return [{ text, offset: 0 }];
  const windows: Window[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(' ', end);
      if (lastSpace > start + maxChars * 0.5) end = lastSpace;
    }
    windows.push({ text: text.slice(start, end), offset: start });
    start = end;
  }
  return windows;
}

// ── Offset reconstruction + BIO decode ─────────────────────────────────────

interface RawToken {
  index: number;
  label: string;
  score: number;
  start: number;
  end: number;
}

function reconstructOffsets(windowText: string, tokens: Pipeline[]): RawToken[] {
  let cursor = 0;
  const out: RawToken[] = [];
  for (const t of tokens) {
    const raw = String(t.word ?? '');
    const isContinuation = raw.startsWith('##');
    const surface = isContinuation ? raw.slice(2) : raw;
    if (surface.length === 0) continue;

    let start: number;
    if (isContinuation) {
      // WordPiece continuations glue directly onto the previous piece — no
      // gap, no search, just check the expected slice.
      start = windowText.slice(cursor, cursor + surface.length) === surface ? cursor : -1;
    } else {
      start = windowText.indexOf(surface, cursor);
    }
    if (start === -1) {
      // Rare (UNK token, or a normalization edge case). Skip this token's
      // offset contribution rather than guess wrong — a dropped token means,
      // at worst, one entity's span is a little short.
      continue;
    }
    const end = start + surface.length;
    cursor = end;
    out.push({ index: Number(t.index), label: String(t.entity ?? 'O'), score: Number(t.score ?? 0), start, end });
  }
  return out;
}

/**
 * Merge tokens into entity spans. Deliberately merges on (same stripped
 * type + contiguous token index) rather than strict B-/I- transitions: this
 * checkpoint repeats the `B-` prefix across WordPiece continuations of a
 * single entity instead of switching to `I-` (verified empirically — see
 * the module header spike), so a strict BIO decoder would split
 * "Co|##gn|##ipe|##er" into four one-token organizations instead of one.
 */
function decodeEntities(windowText: string, windowOffset: number, tokens: RawToken[], labelMap: Record<string, NerCategory>): Candidate[] {
  const spans: Candidate[] = [];
  let buffer: RawToken[] = [];
  let bufferType: NerCategory | null = null;

  const flush = (): void => {
    if (buffer.length === 0 || !bufferType) return;
    const start = buffer[0].start + windowOffset;
    const end = buffer[buffer.length - 1].end + windowOffset;
    const meanScore = buffer.reduce((sum, t) => sum + t.score, 0) / buffer.length;
    spans.push({
      category: bufferType,
      start,
      end,
      value: windowText.slice(buffer[0].start, buffer[buffer.length - 1].end),
      baseScore: meanScore,
      detector: 'ner',
      severity: SEVERITY_BY_CATEGORY[bufferType],
      label: bufferType,
      evidence: [`ner:${bufferType} score=${meanScore.toFixed(2)}`],
    });
  };

  let prevIndex: number | null = null;
  for (const t of tokens) {
    const rawType = t.label === 'O' ? null : t.label.split('-')[1] ?? null;
    const mapped = rawType ? (labelMap[rawType] ?? null) : null;
    const contiguous = prevIndex !== null && t.index === prevIndex + 1;
    if (mapped && bufferType === mapped && contiguous) {
      buffer.push(t);
    } else {
      flush();
      buffer = mapped ? [t] : [];
      bufferType = mapped;
    }
    prevIndex = t.index;
  }
  flush();
  return spans;
}

// ── Public entry point ──────────────────────────────────────────────────

export interface NerRunOptions {
  nerModelPath: string;
  models?: string[];
  maxChars?: number;
  timeoutMs?: number;
  maxConcurrent?: number;
  failMode?: 'open' | 'closed';
}

export interface NerDegradedNote {
  modelId: string;
  windowOffset: number;
  reason: string;
}

export interface NerRunResult {
  candidates: Candidate[];
  degraded: NerDegradedNote[];
  /** True if every requested model was actually available under `nerModelPath`. */
  modelsAvailable: boolean;
}

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_WINDOW_CHARS = 1500;
const DEFAULT_TIMEOUT_MS = 1500;

async function runOneWindow(
  pl: Pipeline,
  win: Window,
  labelMap: Record<string, NerCategory>,
  timeoutMs: number,
): Promise<{ candidates: Candidate[]; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([pl(win.text, { ignore_labels: [] }), timeout]);
    if (result === 'timeout') return { candidates: [], timedOut: true };
    const tokens = reconstructOffsets(win.text, result as Pipeline[]);
    return { candidates: decodeEntities(win.text, win.offset, tokens, labelMap), timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function runNer(text: string, opts: NerRunOptions): Promise<NerRunResult> {
  const candidates: Candidate[] = [];
  const degraded: NerDegradedNote[] = [];
  if (!text || !opts.nerModelPath) {
    return { candidates, degraded, modelsAvailable: false };
  }

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxConcurrent = opts.maxConcurrent ?? 2;
  const clipped = text.length > maxChars ? text.slice(0, maxChars) : text;
  if (text.length > maxChars) {
    degraded.push({ modelId: 'all', windowOffset: maxChars, reason: `input clipped to the ${maxChars}-char NER scan limit` });
  }

  const modelIds = opts.models && opts.models.length > 0 ? opts.models : Object.keys(NER_MODELS);
  let anyModelAvailable = false;

  for (const modelId of modelIds) {
    const spec = NER_MODELS[modelId];
    if (!spec) {
      degraded.push({ modelId, windowOffset: 0, reason: `unknown NER model id "${modelId}"` });
      continue;
    }
    let pl: Pipeline;
    try {
      pl = await getPipeline(spec.id, opts.nerModelPath);
      anyModelAvailable = true;
    } catch (error) {
      degraded.push({ modelId, windowOffset: 0, reason: `model failed to load: ${error instanceof Error ? error.message : String(error)}` });
      if (opts.failMode === 'closed') throw error;
      continue;
    }

    const windows = splitIntoWindows(clipped, DEFAULT_WINDOW_CHARS);
    for (const win of windows) {
      const release = await acquireSlot(maxConcurrent);
      try {
        const { candidates: winCandidates, timedOut } = await runOneWindow(pl, win, spec.labelMap, timeoutMs);
        if (timedOut) {
          degraded.push({ modelId, windowOffset: win.offset, reason: `window did not finish within the ${timeoutMs}ms soft timeout` });
          if (opts.failMode === 'closed') throw new Error(`NER model "${modelId}" timed out on window at offset ${win.offset}`);
          continue;
        }
        candidates.push(...winCandidates);
      } finally {
        release();
      }
    }
  }

  return { candidates, degraded, modelsAvailable: anyModelAvailable };
}
