/**
 * Form vocabulary shared by the Create and Edit Knowledge Engine module
 * screens, and by the per-document chunking override on the detail page.
 *
 * The two screens used to disagree about almost everything they had in common —
 * which strategies existed, whether the token encoding was ever sent, whether an
 * emptied optional field cleared server-side. Every one of those decisions lives
 * here now, so the screens can only drift apart by editing this file.
 */

import type { IRagChunkConfig, RagChunkStrategy } from '@/lib/database';

/* ── Chunk strategies ────────────────────────────────────────────────── */

/**
 * Mirrors SUPPORTED_CHUNK_STRATEGIES in src/lib/services/rag/chunking.ts, which
 * a client component cannot import: it pulls in winston through the logger and,
 * through a computed require, every tokenizer merge table. The RagChunkStrategy
 * union is the compile-time link instead — a strategy added there fails this
 * record until the form describes it too.
 */
export const CHUNK_STRATEGIES: Record<
  RagChunkStrategy,
  { label: string; description: string }
> = {
  recursive_character: {
    label: 'Recursive character',
    description: 'Split on separators, largest first, falling back to a hard cut.',
  },
  token: {
    label: 'Token',
    description: 'The same boundaries, but sized in real tokens of an encoding.',
  },
  markdown: {
    label: 'Markdown',
    description: 'Never cross a heading; each chunk carries its heading path.',
  },
  sentence: {
    label: 'Sentence',
    description: 'Never cut mid-sentence.',
  },
  semantic: {
    label: 'Semantic',
    description: 'Cut where the topic shifts, measured by embedding distance.',
  },
};

export const CHUNK_STRATEGY_ORDER: RagChunkStrategy[] = [
  'recursive_character',
  'token',
  'markdown',
  'sentence',
  'semantic',
];

/** Mirrors SUPPORTED_TOKEN_ENCODINGS; see the note on CHUNK_STRATEGIES. */
export const TOKEN_ENCODINGS: Array<{ value: string; label: string }> = [
  { value: 'cl100k_base', label: 'cl100k_base (GPT-4, GPT-3.5)' },
  { value: 'p50k_base', label: 'p50k_base (Codex, text-davinci)' },
  { value: 'o200k_base', label: 'o200k_base (GPT-4o)' },
];

// `sentence` splits on punctuation and never reads config.separators, so
// offering the field there would be a control that does nothing.
const SEPARATOR_STRATEGIES: RagChunkStrategy[] = ['recursive_character', 'markdown'];

export function usesSeparators(strategy: RagChunkStrategy): boolean {
  return SEPARATOR_STRATEGIES.includes(strategy);
}

/** `chunkSize` and `chunkOverlap` count characters everywhere except `token`. */
export function chunkSizeUnit(strategy: RagChunkStrategy): 'characters' | 'tokens' {
  return strategy === 'token' ? 'tokens' : 'characters';
}

/** Defaults from chunking.ts, repeated here for the same import reason. */
const DEFAULT_SEMANTIC_THRESHOLD = 0.35;
const DEFAULT_CONTEXTUAL_DOC_CHARS = 8_000;

/**
 * Separators are edited as escape sequences, otherwise a newline separator is an
 * invisible tag the user cannot tell from a space.
 */
export function escapeSeparator(value: string): string {
  return value.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

export function unescapeSeparator(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

const DEFAULT_SEPARATOR_INPUT = ['\\n\\n', '\\n', '. ', ' '];

/* ── Chunk form values ───────────────────────────────────────────────── */

export interface ChunkFormValues {
  strategy: RagChunkStrategy;
  chunkSize: number | '';
  chunkOverlap: number | '';
  /** Escaped for display — run through unescapeSeparator before sending. */
  separators: string[];
  encoding: string;
  semanticThreshold: number;
  parentWindowSize: number | '';
  contextualHeaderEnabled: boolean;
  contextualHeaderModelKey: string;
  contextualHeaderMaxChars: number | '';
}

export const DEFAULT_CHUNK_FORM_VALUES: ChunkFormValues = {
  strategy: 'recursive_character',
  chunkSize: 1000,
  chunkOverlap: 200,
  separators: DEFAULT_SEPARATOR_INPUT,
  encoding: 'cl100k_base',
  semanticThreshold: DEFAULT_SEMANTIC_THRESHOLD,
  parentWindowSize: '',
  contextualHeaderEnabled: false,
  contextualHeaderModelKey: '',
  contextualHeaderMaxChars: '',
};

export function chunkFormValues(config?: Partial<IRagChunkConfig> | null): ChunkFormValues {
  if (!config) return { ...DEFAULT_CHUNK_FORM_VALUES };
  return {
    strategy: config.strategy ?? DEFAULT_CHUNK_FORM_VALUES.strategy,
    chunkSize: config.chunkSize ?? DEFAULT_CHUNK_FORM_VALUES.chunkSize,
    chunkOverlap: config.chunkOverlap ?? DEFAULT_CHUNK_FORM_VALUES.chunkOverlap,
    separators: config.separators?.length
      ? config.separators.map(escapeSeparator)
      : DEFAULT_SEPARATOR_INPUT,
    encoding: config.encoding ?? DEFAULT_CHUNK_FORM_VALUES.encoding,
    semanticThreshold: config.semanticThreshold ?? DEFAULT_SEMANTIC_THRESHOLD,
    parentWindowSize: config.parentWindowSize ?? '',
    contextualHeaderEnabled: config.contextualHeader?.enabled ?? false,
    contextualHeaderModelKey: config.contextualHeader?.modelKey ?? '',
    contextualHeaderMaxChars: config.contextualHeader?.maxDocumentChars ?? '',
  };
}

/** Only the keys the chosen strategy actually reads are sent. */
export function buildChunkConfig(values: ChunkFormValues): IRagChunkConfig {
  const config: IRagChunkConfig = {
    strategy: values.strategy,
    chunkSize: Number(values.chunkSize),
    chunkOverlap: Number(values.chunkOverlap),
  };

  if (usesSeparators(values.strategy)) {
    config.separators = values.separators.map(unescapeSeparator);
  }
  if (values.strategy === 'token') {
    config.encoding = values.encoding;
  }
  if (values.strategy === 'semantic') {
    config.semanticThreshold = values.semanticThreshold;
  }
  if (values.parentWindowSize !== '' && Number(values.parentWindowSize) > 0) {
    config.parentWindowSize = Number(values.parentWindowSize);
  }
  if (values.contextualHeaderEnabled) {
    config.contextualHeader = {
      enabled: true,
      ...(values.contextualHeaderModelKey ? { modelKey: values.contextualHeaderModelKey } : {}),
      ...(values.contextualHeaderMaxChars !== ''
        ? { maxDocumentChars: Number(values.contextualHeaderMaxChars) }
        : {}),
    };
  }

  return config;
}

export interface ChunkFieldErrors {
  chunkSize?: string;
  chunkOverlap?: string;
  parentWindowSize?: string;
  semanticThreshold?: string;
}

/**
 * The same rules validateChunkConfig enforces, applied before the request goes
 * out. `chunkOverlap >= chunkSize` used to be accepted here and hang the
 * splitter, so it is a form error rather than a server round-trip.
 */
export function chunkFieldErrors(values: ChunkFormValues): ChunkFieldErrors {
  const errors: ChunkFieldErrors = {};
  const size = Number(values.chunkSize);
  const overlap = Number(values.chunkOverlap);

  if (values.chunkSize === '' || !Number.isFinite(size) || size < 1) {
    errors.chunkSize = 'Chunk size must be a positive number';
  }
  if (values.chunkOverlap === '' || !Number.isFinite(overlap) || overlap < 0) {
    errors.chunkOverlap = 'Overlap must be zero or more';
  } else if (!errors.chunkSize && overlap >= size) {
    errors.chunkOverlap = `Overlap must be smaller than the chunk size (${size}) — at or above it the splitter never moves forward`;
  }

  if (values.parentWindowSize !== '') {
    const parent = Number(values.parentWindowSize);
    if (!Number.isFinite(parent) || parent < 0) {
      errors.parentWindowSize = 'Parent window must be zero or more';
    } else if (parent > 0 && !errors.chunkSize && parent < size) {
      errors.parentWindowSize = `A parent window below the chunk size (${size}) returns less context, not more`;
    }
  }

  if (values.strategy === 'semantic'
    && (values.semanticThreshold <= 0 || values.semanticThreshold >= 1)) {
    errors.semanticThreshold = 'Threshold must be between 0 and 1';
  }

  return errors;
}

export function hasChunkFieldErrors(errors: ChunkFieldErrors): boolean {
  return Object.values(errors).some(Boolean);
}

/**
 * Mirrors chunkConfigRequiresReindex in chunking.ts: true when the two configs
 * would produce different chunks, so the module's documents have to be rebuilt.
 * parentWindowSize is resolved at query time and deliberately excluded.
 */
export function chunkConfigRequiresReindex(a: IRagChunkConfig, b: IRagChunkConfig): boolean {
  const shape = (c: IRagChunkConfig) => JSON.stringify({
    strategy: c.strategy,
    chunkSize: c.chunkSize,
    chunkOverlap: c.chunkOverlap,
    separators: c.separators ?? null,
    encoding: c.encoding ?? null,
    semanticThreshold: c.semanticThreshold ?? null,
    contextualHeader: c.contextualHeader?.enabled
      ? {
        modelKey: c.contextualHeader.modelKey ?? null,
        maxDocumentChars: c.contextualHeader.maxDocumentChars ?? null,
      }
      : null,
  });
  return shape(a) !== shape(b);
}

export const CONTEXTUAL_HEADER_DEFAULT_CHARS = DEFAULT_CONTEXTUAL_DOC_CHARS;

/* ── Retrieval ───────────────────────────────────────────────────────── */

export type HybridMode = 'rrf' | 'weighted';

export interface RetrievalFormValues {
  hybridEnabled: boolean;
  hybridMode: HybridMode;
  hybridAlpha: number;
  hybridK: number | '';
  /**
   * `null` is a third state — "no explicit setting on this module" — and not a
   * false. The service reads an unset flag as "decide per query by checking
   * whether the index is shared", which is the only safe answer for an index an
   * outside pipeline filled: isolating one of those returns nothing at all.
   * Writing a boolean over it destroys that, so the edit screen keeps it.
   */
  isolateByModule: boolean | null;
}

export interface RetrievalSource {
  hybrid?: { enabled: boolean; mode?: HybridMode; alpha?: number; k?: number } | null;
  isolateByModule?: boolean | null;
}

export const DEFAULT_RETRIEVAL_FORM_VALUES: RetrievalFormValues = {
  hybridEnabled: false,
  hybridMode: 'rrf',
  hybridAlpha: 0.5,
  hybridK: 60,
  // On for anything we ingest into ourselves, which is every module created here.
  isolateByModule: true,
};

export function retrievalFormValues(source?: RetrievalSource | null): RetrievalFormValues {
  if (!source) return { ...DEFAULT_RETRIEVAL_FORM_VALUES };
  return {
    hybridEnabled: source.hybrid?.enabled ?? false,
    hybridMode: source.hybrid?.mode ?? 'rrf',
    hybridAlpha: source.hybrid?.alpha ?? DEFAULT_RETRIEVAL_FORM_VALUES.hybridAlpha,
    hybridK: source.hybrid?.k ?? DEFAULT_RETRIEVAL_FORM_VALUES.hybridK,
    // Not DEFAULT_RETRIEVAL_FORM_VALUES.isolateByModule: an existing module
    // without the flag has not opted into isolation, it predates it.
    isolateByModule: source.isolateByModule ?? null,
  };
}

/** Always an object: `{ enabled: false }` turns hybrid off without clearing the tuning. */
export function buildHybrid(values: RetrievalFormValues): {
  enabled: boolean;
  mode?: HybridMode;
  alpha?: number;
  k?: number;
} {
  if (!values.hybridEnabled) return { enabled: false };
  return {
    enabled: true,
    mode: values.hybridMode,
    ...(values.hybridMode === 'weighted' ? { alpha: values.hybridAlpha } : {}),
    ...(values.hybridMode === 'rrf' && values.hybridK !== '' ? { k: Number(values.hybridK) } : {}),
  };
}

export const HYBRID_CAPABILITY_KEY = 'vector.supportsHybrid';

export function providerSupportsHybrid(capabilities?: Record<string, unknown> | null): boolean {
  return Boolean(capabilities?.[HYBRID_CAPABILITY_KEY]);
}

/** The retrieval half of a module update. Absent means "leave this alone". */
export interface RetrievalUpdate {
  hybrid?: { enabled: boolean; mode?: HybridMode; alpha?: number; k?: number };
  isolateByModule?: boolean;
}

/**
 * What an edit is allowed to say about retrieval.
 *
 * Both fields are omitted rather than defaulted, because `undefined` is the only
 * value updateRagModule reads as "leave this alone":
 *
 *  - `hybrid` waits until the provider's capabilities are known. The provider
 *    list is fetched asynchronously and every provider looks hybrid-incapable
 *    until it resolves, so a save that beat the fetch used to overwrite a stored
 *    hybrid configuration with `{ enabled: false }`.
 *  - `isolateByModule` stays out while it is unset, so a rename cannot flip a
 *    legacy module onto isolation — which would empty every query against an
 *    index an outside pipeline populated.
 */
export function buildRetrievalUpdate(
  values: RetrievalFormValues,
  capabilities: { known: boolean; hybridSupported: boolean },
): RetrievalUpdate {
  const update: RetrievalUpdate = {};

  if (capabilities.known) {
    // A provider that is known not to support hybrid is shown to the user as
    // "unavailable for this module", so persisting off matches the screen.
    update.hybrid = capabilities.hybridSupported ? buildHybrid(values) : { enabled: false };
  }
  if (values.isolateByModule !== null) {
    update.isolateByModule = values.isolateByModule;
  }

  return update;
}

export type RagReindexReason = 'chunk-config' | 'embedding-model';

/**
 * Why a saved edit has to rebuild the module's vectors, or null when it doesn't.
 * Chunking wins when both changed — the run re-embeds every chunk either way,
 * and the chunk boundaries are the more surprising of the two to have moved.
 */
export function reindexReasonFor(
  chunkingChanged: boolean,
  embeddingChanged: boolean,
): RagReindexReason | null {
  if (chunkingChanged) return 'chunk-config';
  if (embeddingChanged) return 'embedding-model';
  return null;
}

/* ── Clearing optional fields ────────────────────────────────────────── */

export type RagModuleFormMode = 'create' | 'update';

/**
 * What an emptied optional field must send. updateRagModule reads `undefined` as
 * "leave this alone", so only an explicit `null` clears a value; create has
 * nothing to clear and a literal null there would be written straight into a
 * field the type says is absent.
 */
export function clearedValue(mode: RagModuleFormMode): null | undefined {
  return mode === 'create' ? undefined : null;
}
