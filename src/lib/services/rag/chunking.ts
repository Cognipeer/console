/**
 * Knowledge Engine chunking.
 *
 * Every strategy funnels through the same two-stage shape:
 *
 *   1. a splitter turns the source into ATOMS — indivisible spans that carry
 *      their offsets in the original text and are never allowed to be broken
 *      across a chunk boundary, and
 *   2. `packAtoms` greedily fills chunks up to `chunkSize` as measured by a
 *      SizeMeter (characters, or real tokens), carrying `chunkOverlap` worth of
 *      trailing atoms into the next chunk.
 *
 * Two invariants hold for every strategy, and both were previously violated:
 *
 *   - Concatenating the atoms reproduces the source exactly. Separators are
 *     emitted as their own atoms rather than being swallowed by `split`, which
 *     is what used to glue words together across a boundary.
 *   - `chunkSize` is a HARD cap. An atom larger than the cap is cut by the
 *     meter instead of being emitted whole, so text with no usable boundary
 *     (CJK without spaces, a base64 blob, a wide markdown table) can no longer
 *     produce a chunk that overflows the embedding model.
 */

import { createLogger } from '@/lib/core/logger';
import type { IRagChunkConfig, RagChunkStrategy } from '@/lib/database';

const logger = createLogger('rag-chunking');

/* ── Public shape ────────────────────────────────────────────────────── */

export interface ChunkResult {
  content: string;
  index: number;
  /** Offsets of `content` in the source text, before any contextual header. */
  charStart: number;
  charEnd: number;
  headingPath?: string[];
  tokenCount?: number;
  metadata: Record<string, unknown>;
}

/**
 * Model access the richer strategies need. Both are optional: a caller that
 * cannot embed or generate simply cannot use `semantic` / `contextualHeader`,
 * and gets a clear error rather than a silent downgrade.
 */
export interface ChunkContext {
  embed?: (texts: string[]) => Promise<number[][]>;
  describe?: (documentExcerpt: string, chunk: string) => Promise<string>;
}

export const DEFAULT_SEPARATORS = ['\n\n', '\n', '. ', ' '];
export const DEFAULT_SEMANTIC_THRESHOLD = 0.35;
export const DEFAULT_CONTEXTUAL_DOC_CHARS = 8_000;
const CONTEXTUAL_CONCURRENCY = 4;

/* ── Size meters ─────────────────────────────────────────────────────── */

interface SizeMeter {
  /** Size of `text` in this meter's unit. */
  size(text: string): number;
  /**
   * Largest character count of `text` that still measures at most `max`.
   * Always returns at least 1 for non-empty input so cutting cannot stall.
   */
  cut(text: string, max: number): number;
  unit: 'characters' | 'tokens';
}

const characterMeter: SizeMeter = {
  unit: 'characters',
  size: (text) => text.length,
  cut: (text, max) => Math.max(1, Math.min(text.length, max)),
};

type Tokenizer = { encode: (text: string) => number[]; decode: (tokens: number[]) => string };

const SUPPORTED_ENCODINGS = ['cl100k_base', 'p50k_base', 'o200k_base'] as const;
export type TokenEncoding = (typeof SUPPORTED_ENCODINGS)[number];

const tokenizerCache = new Map<string, Tokenizer>();

export function isSupportedEncoding(value: unknown): value is TokenEncoding {
  return typeof value === 'string' && (SUPPORTED_ENCODINGS as readonly string[]).includes(value);
}

/**
 * `gpt-tokenizer` ships one module per encoding and each is a few MB of merge
 * data, so they are required lazily and memoised for the process.
 */
function loadTokenizer(encoding: TokenEncoding): Tokenizer {
  const cached = tokenizerCache.get(encoding);
  if (cached) return cached;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(`gpt-tokenizer/encoding/${encoding}`) as Tokenizer;
  tokenizerCache.set(encoding, mod);
  return mod;
}

function tokenMeter(encoding: TokenEncoding): SizeMeter {
  const tk = loadTokenizer(encoding);
  return {
    unit: 'tokens',
    size: (text) => (text.length === 0 ? 0 : tk.encode(text).length),
    cut: (text, max) => {
      if (text.length === 0 || max <= 0) return Math.min(text.length, 1);
      const tokens = tk.encode(text);
      if (tokens.length <= max) return text.length;
      // Decoding the retained prefix gives the exact character boundary; a
      // partial multi-byte sequence decodes to the replacement char, so clamp
      // to at least one character to guarantee forward progress.
      return Math.max(1, tk.decode(tokens.slice(0, max)).length);
    },
  };
}

function meterFor(config: IRagChunkConfig): SizeMeter {
  if (config.strategy !== 'token') return characterMeter;
  const encoding = isSupportedEncoding(config.encoding) ? config.encoding : 'cl100k_base';
  return tokenMeter(encoding);
}

/* ── Atoms ───────────────────────────────────────────────────────────── */

interface Atom {
  text: string;
  start: number;
  headingPath?: string[];
  /** Semantic strategy only: force a chunk boundary before this atom. */
  breakBefore?: boolean;
}

/**
 * Recursively split on the first separator that occurs, re-emitting the
 * separator as its own atom so the atom stream concatenates back to the input.
 */
function splitBySeparators(text: string, separators: string[], offset: number): Atom[] {
  const sep = separators.find((s) => s.length > 0 && text.includes(s));
  if (!sep) return text.length > 0 ? [{ text, start: offset }] : [];

  const rest = separators.slice(separators.indexOf(sep) + 1);
  const out: Atom[] = [];
  let pos = offset;
  const segments = text.split(sep);

  segments.forEach((segment, i) => {
    if (segment.length > 0) {
      out.push(...splitBySeparators(segment, rest, pos));
      pos += segment.length;
    }
    if (i < segments.length - 1) {
      out.push({ text: sep, start: pos });
      pos += sep.length;
    }
  });

  return out;
}

/**
 * Sentence atoms. Breaks after terminal punctuation followed by whitespace, and
 * at blank lines, keeping the punctuation and the whitespace attached to the
 * sentence they end so offsets stay exact.
 */
function splitIntoSentences(text: string, offset = 0): Atom[] {
  const out: Atom[] = [];
  const boundary = /([.!?…]["'”’)\]]*\s+|\n{2,})/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const piece = text.slice(last, end);
    if (piece.length > 0) out.push({ text: piece, start: offset + last });
    last = end;
  }
  if (last < text.length) out.push({ text: text.slice(last), start: offset + last });
  return out;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

interface MarkdownSection {
  text: string;
  start: number;
  headingPath: string[];
}

/**
 * Split markdown into heading-delimited sections, tracking the heading
 * breadcrumb. Fenced code blocks are skipped so a `# comment` inside a shell
 * snippet cannot open a phantom section.
 */
function splitByHeadings(text: string): MarkdownSection[] {
  const lines = text.split('\n');
  const sections: MarkdownSection[] = [];
  const path: Array<{ level: number; title: string }> = [];

  let buffer: string[] = [];
  let bufferStart = 0;
  let pos = 0;
  let inFence = false;

  const flush = (headingPath: string[]) => {
    const body = buffer.join('\n');
    if (body.trim().length > 0) sections.push({ text: body, start: bufferStart, headingPath });
    buffer = [];
  };

  for (const line of lines) {
    const lineLength = line.length + 1; // the '\n' split consumed
    if (FENCE_RE.test(line)) inFence = !inFence;

    const heading = inFence ? null : HEADING_RE.exec(line);
    if (heading) {
      flush(path.map((p) => p.title));
      const level = heading[1].length;
      while (path.length > 0 && path[path.length - 1].level >= level) path.pop();
      path.push({ level, title: heading[2].trim() });
      bufferStart = pos;
      buffer.push(line);
    } else {
      if (buffer.length === 0) bufferStart = pos;
      buffer.push(line);
    }
    pos += lineLength;
  }
  flush(path.map((p) => p.title));

  return sections;
}

/* ── Packing ─────────────────────────────────────────────────────────── */

/** Split an over-long atom into meter-sized pieces, preserving offsets. */
function cutAtom(atom: Atom, meter: SizeMeter, max: number): Atom[] {
  if (meter.size(atom.text) <= max) return [atom];

  const pieces: Atom[] = [];
  let rest = atom.text;
  let start = atom.start;
  while (rest.length > 0) {
    const take = meter.cut(rest, max);
    pieces.push({ text: rest.slice(0, take), start, headingPath: atom.headingPath });
    start += take;
    rest = rest.slice(take);
  }
  return pieces;
}

/**
 * Emit a chunk from the accumulated atoms, trimming surrounding whitespace and
 * narrowing the recorded offsets by exactly what the trim removed.
 */
function emit(atoms: Atom[], index: number, meter: SizeMeter): ChunkResult | null {
  if (atoms.length === 0) return null;
  const raw = atoms.map((a) => a.text).join('');
  const leading = raw.length - raw.trimStart().length;
  const content = raw.trim();
  if (content.length === 0) return null;

  const charStart = atoms[0].start + leading;
  const headingPath = atoms.find((a) => a.headingPath && a.headingPath.length > 0)?.headingPath;
  const tokenCount = meter.unit === 'tokens' ? meter.size(content) : undefined;

  return {
    content,
    index,
    charStart,
    charEnd: charStart + content.length,
    headingPath,
    tokenCount,
    metadata: {
      chunkIndex: index,
      // Historic key: the chunk's actual character length, not the configured
      // chunkSize. Vector metadata on every existing index uses this name.
      chunkSize: content.length,
      ...(headingPath && headingPath.length > 0 ? { headingPath } : {}),
      ...(tokenCount !== undefined ? { tokenCount } : {}),
    },
  };
}

function packAtoms(
  atoms: Atom[],
  meter: SizeMeter,
  chunkSize: number,
  chunkOverlap: number,
  startIndex = 0,
): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  let current: Atom[] = [];
  let currentSize = 0;
  let index = startIndex;

  const flush = () => {
    const chunk = emit(current, index, meter);
    if (chunk) {
      chunks.push(chunk);
      index += 1;
    }
    return chunk !== null;
  };

  /** Trailing atoms worth at most `chunkOverlap`, so overlap never cuts a word. */
  const overlapTail = (): Atom[] => {
    // Asserted positive rather than testing for `<= 0`: every comparison
    // against a missing chunkOverlap is false, so the old guard let the tail
    // loop run with no budget and carried the ENTIRE previous chunk forward,
    // each chunk accumulating all of its predecessors. chunkText normalises the
    // config, and this keeps the invariant true wherever the packer is called.
    if (!(chunkOverlap > 0)) return [];
    const tail: Atom[] = [];
    let size = 0;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const atomSize = meter.size(current[i].text);
      if (size + atomSize > chunkOverlap) break;
      tail.unshift(current[i]);
      size += atomSize;
    }
    return tail;
  };

  for (const atom of atoms) {
    for (const piece of cutAtom(atom, meter, chunkSize)) {
      const pieceSize = meter.size(piece.text);
      const forcedBreak = piece.breakBefore && current.length > 0;

      if (forcedBreak || (currentSize + pieceSize > chunkSize && current.length > 0)) {
        flush();
        current = forcedBreak ? [] : overlapTail();
        currentSize = current.reduce((sum, a) => sum + meter.size(a.text), 0);
      }

      current.push(piece);
      currentSize += pieceSize;
    }
  }
  flush();

  return chunks;
}

/* ── Strategies ──────────────────────────────────────────────────────── */

function chunkRecursive(text: string, config: IRagChunkConfig, meter: SizeMeter): ChunkResult[] {
  const separators = config.separators && config.separators.length > 0
    ? config.separators
    : DEFAULT_SEPARATORS;
  return packAtoms(splitBySeparators(text, separators, 0), meter, config.chunkSize, config.chunkOverlap);
}

function chunkSentence(text: string, config: IRagChunkConfig, meter: SizeMeter): ChunkResult[] {
  return packAtoms(splitIntoSentences(text), meter, config.chunkSize, config.chunkOverlap);
}

function chunkMarkdown(text: string, config: IRagChunkConfig, meter: SizeMeter): ChunkResult[] {
  const separators = config.separators && config.separators.length > 0
    ? config.separators
    : DEFAULT_SEPARATORS;

  const chunks: ChunkResult[] = [];
  for (const section of splitByHeadings(text)) {
    const atoms = splitBySeparators(section.text, separators, section.start)
      .map((a) => ({ ...a, headingPath: section.headingPath }));
    // Packing per section is what keeps a chunk from spanning two headings.
    chunks.push(...packAtoms(atoms, meter, config.chunkSize, config.chunkOverlap, chunks.length));
  }
  return chunks;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function chunkSemantic(
  text: string,
  config: IRagChunkConfig,
  meter: SizeMeter,
  ctx: ChunkContext,
): Promise<ChunkResult[]> {
  if (!ctx.embed) {
    throw new Error('The "semantic" chunk strategy needs an embedding model; none was available.');
  }

  const sentences = splitIntoSentences(text);
  // A whitespace-only atom carries no signal to embed, but it must stay in the
  // stream: `emit` derives charEnd from the atoms it was handed as a contiguous
  // slice of the source, so dropping one makes every chunk after it quote fewer
  // characters than its recorded span, and a parent window resolved from those
  // offsets cuts off the chunk that matched. So the blanks are skipped for the
  // embedding pass only, and the break decision is written back in place.
  const embeddable = sentences
    .map((atom, index) => ({ atom, index }))
    .filter(({ atom }) => atom.text.trim().length > 0);

  if (embeddable.length <= 1) {
    return packAtoms(sentences, meter, config.chunkSize, config.chunkOverlap);
  }

  const threshold = typeof config.semanticThreshold === 'number'
    ? config.semanticThreshold
    : DEFAULT_SEMANTIC_THRESHOLD;

  const vectors = await ctx.embed(embeddable.map(({ atom }) => atom.text.trim()));
  const atoms: Atom[] = [...sentences];
  for (let i = 1; i < embeddable.length; i += 1) {
    if (!vectors[i] || !vectors[i - 1]) continue;
    const distance = 1 - cosine(vectors[i - 1], vectors[i]);
    if (distance > threshold) {
      const { atom, index } = embeddable[i];
      atoms[index] = { ...atom, breakBefore: true };
    }
  }

  // chunkSize still applies: a long stretch with no topic shift is packed
  // normally rather than becoming one enormous chunk.
  return packAtoms(atoms, meter, config.chunkSize, config.chunkOverlap);
}

/* ── Contextual headers ──────────────────────────────────────────────── */

async function applyContextualHeaders(
  chunks: ChunkResult[],
  text: string,
  config: IRagChunkConfig,
  ctx: ChunkContext,
): Promise<ChunkResult[]> {
  const settings = config.contextualHeader;
  if (!settings?.enabled) return chunks;
  if (!ctx.describe) {
    throw new Error('Contextual headers need a chat model; none was available.');
  }

  const excerpt = text.slice(0, settings.maxDocumentChars ?? DEFAULT_CONTEXTUAL_DOC_CHARS);
  const out = [...chunks];

  for (let i = 0; i < out.length; i += CONTEXTUAL_CONCURRENCY) {
    const window = out.slice(i, i + CONTEXTUAL_CONCURRENCY);
    await Promise.all(window.map(async (chunk, offset) => {
      try {
        const header = (await ctx.describe!(excerpt, chunk.content)).trim();
        if (!header) return;
        const position = i + offset;
        // Offsets keep pointing at the ORIGINAL span: the header is generated
        // text that exists nowhere in the source, so a parent window resolved
        // from charStart/charEnd must not include it.
        out[position] = {
          ...chunk,
          content: `${header}\n\n${chunk.content}`,
          metadata: { ...chunk.metadata, contextualHeader: header },
        };
      } catch (error) {
        // A missing header costs retrieval quality; a failed ingest costs the
        // whole document. Degrade.
        logger.warn('Contextual header generation failed for a chunk', {
          chunkIndex: chunk.index,
          error: error instanceof Error ? error.message : error,
        });
      }
    }));
  }

  return out;
}

/* ── Validation ──────────────────────────────────────────────────────── */

const STRATEGIES: RagChunkStrategy[] = [
  'recursive_character', 'token', 'markdown', 'sentence', 'semantic',
];

export const SUPPORTED_CHUNK_STRATEGIES: readonly RagChunkStrategy[] = STRATEGIES;
export const SUPPORTED_TOKEN_ENCODINGS: readonly TokenEncoding[] = SUPPORTED_ENCODINGS;

/**
 * Reject a chunk config the pipeline cannot honour. Called by both HTTP
 * surfaces — until now nothing validated chunkConfig at all, and
 * `chunkOverlap >= chunkSize` used to spin the token splitter forever.
 */
export function validateChunkConfig(config: unknown, label = 'chunkConfig'): IRagChunkConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${label} must be an object`);
  }
  const c = config as Record<string, unknown>;

  if (!STRATEGIES.includes(c.strategy as RagChunkStrategy)) {
    throw new Error(`${label}.strategy must be one of: ${STRATEGIES.join(', ')}`);
  }
  const chunkSize = Number(c.chunkSize);
  const chunkOverlap = Number(c.chunkOverlap ?? 0);
  if (!Number.isFinite(chunkSize) || chunkSize < 1) {
    throw new Error(`${label}.chunkSize must be a positive number`);
  }
  if (!Number.isFinite(chunkOverlap) || chunkOverlap < 0) {
    throw new Error(`${label}.chunkOverlap must be zero or a positive number`);
  }
  if (chunkOverlap >= chunkSize) {
    throw new Error(
      `${label}.chunkOverlap (${chunkOverlap}) must be smaller than chunkSize (${chunkSize}) — `
      + 'an overlap at or above the chunk size makes no forward progress.',
    );
  }
  if (c.encoding !== undefined && !isSupportedEncoding(c.encoding)) {
    throw new Error(`${label}.encoding must be one of: ${SUPPORTED_ENCODINGS.join(', ')}`);
  }
  if (c.separators !== undefined
    && (!Array.isArray(c.separators) || c.separators.some((s) => typeof s !== 'string'))) {
    throw new Error(`${label}.separators must be an array of strings`);
  }
  if (c.semanticThreshold !== undefined) {
    const t = Number(c.semanticThreshold);
    if (!Number.isFinite(t) || t <= 0 || t >= 1) {
      throw new Error(`${label}.semanticThreshold must be between 0 and 1`);
    }
  }
  if (c.parentWindowSize !== undefined) {
    const p = Number(c.parentWindowSize);
    if (!Number.isFinite(p) || p < 0) {
      throw new Error(`${label}.parentWindowSize must be zero or a positive number`);
    }
    if (p > 0 && p < chunkSize) {
      throw new Error(
        `${label}.parentWindowSize (${p}) must be at least chunkSize (${chunkSize}) — `
        + 'a parent window smaller than its child returns less context, not more.',
      );
    }
  }
  return config as IRagChunkConfig;
}

/**
 * True when the two configs would produce different chunks, i.e. the module's
 * documents have to be re-indexed for the change to take effect.
 */
export function chunkConfigRequiresReindex(a: IRagChunkConfig | undefined, b: IRagChunkConfig | undefined): boolean {
  if (!a || !b) return Boolean(a) !== Boolean(b);
  const shape = (c: IRagChunkConfig) => JSON.stringify({
    strategy: c.strategy,
    chunkSize: c.chunkSize,
    chunkOverlap: c.chunkOverlap,
    separators: c.separators ?? null,
    encoding: c.encoding ?? null,
    semanticThreshold: c.semanticThreshold ?? null,
    contextualHeader: c.contextualHeader?.enabled
      ? { modelKey: c.contextualHeader.modelKey ?? null, maxDocumentChars: c.contextualHeader.maxDocumentChars ?? null }
      : null,
    // parentWindowSize is resolved at QUERY time from the stored source, so
    // changing it does not invalidate a single stored chunk or vector.
  });
  return shape(a) !== shape(b);
}

/* ── Entry point ─────────────────────────────────────────────────────── */

export async function chunkText(
  text: string,
  config: IRagChunkConfig,
  ctx: ChunkContext = {},
): Promise<ChunkResult[]> {
  if (text.trim().length === 0) return [];

  // Defensive, and the single place a stored config is made usable.
  //
  // Two shapes reach here that validateChunkConfig would have rejected: an
  // overlap at or above the chunk size (modules created before validation
  // existed), and no overlap at all (legacy records, or any API caller that
  // omits the field). The second is the dangerous one — `undefined` loses every
  // numeric comparison, so neither the clamp below nor the packer's overlap
  // budget fires and each chunk carries all of its predecessors — so it is
  // normalised to the same default validation applies, zero.
  const requested = Number.isFinite(config.chunkOverlap) ? config.chunkOverlap : 0;
  const chunkOverlap = requested >= config.chunkSize
    ? Math.max(0, Math.floor(config.chunkSize / 10))
    : requested;

  const safe: IRagChunkConfig = chunkOverlap === config.chunkOverlap
    ? config
    : { ...config, chunkOverlap };
  if (safe !== config) {
    logger.warn('chunkOverlap was unusable; normalised for this run', {
      strategy: config.strategy,
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      normalisedTo: chunkOverlap,
    });
  }

  const meter = meterFor(safe);

  let chunks: ChunkResult[];
  switch (safe.strategy) {
    case 'markdown':
      chunks = chunkMarkdown(text, safe, meter);
      break;
    case 'sentence':
      chunks = chunkSentence(text, safe, meter);
      break;
    case 'semantic':
      chunks = await chunkSemantic(text, safe, meter, ctx);
      break;
    case 'token':
    case 'recursive_character':
    default:
      chunks = chunkRecursive(text, safe, meter);
      break;
  }

  return applyContextualHeaders(chunks, text, safe, ctx);
}

/**
 * Resolve the parent window for a chunk: the configured number of characters
 * centred on the chunk's own span, snapped outward to whitespace so the window
 * does not start or end mid-word. Returns undefined when small-to-big is off or
 * the source is unavailable.
 */
export function resolveParentWindow(
  source: string | undefined,
  chunk: { charStart?: number; charEnd?: number },
  parentWindowSize: number | undefined,
): string | undefined {
  if (!source || !parentWindowSize || parentWindowSize <= 0) return undefined;
  if (typeof chunk.charStart !== 'number' || typeof chunk.charEnd !== 'number') return undefined;

  const span = chunk.charEnd - chunk.charStart;
  if (span >= parentWindowSize) return undefined;

  const pad = Math.floor((parentWindowSize - span) / 2);
  let start = Math.max(0, chunk.charStart - pad);
  let end = Math.min(source.length, chunk.charEnd + pad);

  while (start > 0 && !/\s/.test(source[start - 1])) start -= 1;
  while (end < source.length && !/\s/.test(source[end])) end += 1;

  const window = source.slice(start, end).trim();
  return window.length > 0 ? window : undefined;
}
