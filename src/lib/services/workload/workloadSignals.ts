/**
 * Workload signals — deterministic, dependency-free measurements of what a
 * traced workload actually DEMANDS of a model.
 *
 * The cost engine's job is to answer "could a cheaper model do this work?".
 * Price and context window are the easy half; the half that decides whether a
 * small model actually survives is the SHAPE of the work:
 *
 *   - how complex the tool schemas are (a 3-field flat tool is nothing like
 *     a nested oneOf with arrays of objects — schema complexity, not tool
 *     COUNT, is what small models fail at),
 *   - what language the traffic is in (most small open-weight models are
 *     documented on English benchmarks and degrade sharply elsewhere).
 *
 * Both are computed here as pure functions over data the tracer already
 * records, so the same numbers can be shown in the observability UI and used
 * as hard gates by the recommendation engine. No model calls, no heuristics
 * that need tuning per tenant.
 */

// ── Tool schema complexity ─────────────────────────────────────────────────

export type ToolComplexityBand = 'simple' | 'moderate' | 'complex';

export interface ToolSchemaComplexity {
  /** Tool definitions whose parameter schema could be read. */
  toolsAnalyzed: number;
  /** Mean / max top-level parameter count across analysed tools. */
  avgParams: number;
  maxParams: number;
  /** Deepest nesting level found in any analysed schema (1 = flat object). */
  maxDepth: number;
  /** Tools using oneOf/anyOf/allOf, arrays of objects, or long enums. */
  advancedSchemaTools: number;
  /** Mean count of REQUIRED parameters — every one is a chance to omit. */
  avgRequiredParams: number;
  /** Deterministic composite in [0,1]. */
  score: number;
  band: ToolComplexityBand;
}

export const EMPTY_TOOL_COMPLEXITY: ToolSchemaComplexity = {
  toolsAnalyzed: 0,
  avgParams: 0,
  maxParams: 0,
  maxDepth: 0,
  advancedSchemaTools: 0,
  avgRequiredParams: 0,
  score: 0,
  band: 'simple',
};

/** An enum longer than this is a memorization burden, not a hint. */
const LONG_ENUM_VALUES = 8;
/** Schema recursion guard — deep-enough measurement, bounded work. */
const MAX_SCHEMA_DEPTH = 12;
/** Band cut-offs on the composite score. */
const COMPLEX_BAND_SCORE = 0.6;
const MODERATE_BAND_SCORE = 0.3;
/** Normalizers for the composite — the value at which a component saturates. */
const PARAMS_SATURATION = 12;
const DEPTH_SATURATION = 4;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The JSON-Schema object describing a tool's arguments, across the shapes the
 * tracer sees: OpenAI (`function.parameters`), Anthropic (`input_schema`),
 * and the flattened form the agent SDK records (`parameters`).
 */
function toolParameterSchema(tool: unknown): Record<string, unknown> | undefined {
  const record = asRecord(tool);
  if (!record) return undefined;
  const fn = asRecord(record.function);
  return (
    asRecord(fn?.parameters)
    ?? asRecord(record.parameters)
    ?? asRecord(record.input_schema)
    ?? asRecord(record.inputSchema)
  );
}

interface SchemaWalkResult {
  depth: number;
  advanced: boolean;
}

/** A subschema that contains further structure, not just a scalar type. */
function isStructured(node: unknown): boolean {
  const schema = asRecord(node);
  if (!schema) return false;
  return Boolean(
    asRecord(schema.properties)
    || asRecord(schema.items)
    || Array.isArray(schema.oneOf)
    || Array.isArray(schema.anyOf)
    || Array.isArray(schema.allOf),
  );
}

/** Depth + "advanced construct present" for one schema subtree. */
function walkSchema(node: unknown, depth: number): SchemaWalkResult {
  const schema = asRecord(node);
  if (!schema || depth > MAX_SCHEMA_DEPTH) return { depth, advanced: false };

  let advanced =
    Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf);
  if (Array.isArray(schema.enum) && schema.enum.length > LONG_ENUM_VALUES) advanced = true;

  let maxDepth = depth;

  const properties = asRecord(schema.properties);
  if (properties) {
    for (const child of Object.values(properties)) {
      // A scalar leaf does not deepen the schema — only a child that is
      // itself structured does. Otherwise every flat object would measure 2.
      const result = walkSchema(child, isStructured(child) ? depth + 1 : depth);
      maxDepth = Math.max(maxDepth, result.depth);
      advanced = advanced || result.advanced;
    }
  }

  const items = asRecord(schema.items);
  if (items) {
    // An array of OBJECTS is the shape small models most reliably mangle.
    if (items.type === 'object' || asRecord(items.properties)) advanced = true;
    const result = walkSchema(items, depth + 1);
    maxDepth = Math.max(maxDepth, result.depth);
    advanced = advanced || result.advanced;
  }

  for (const branch of ['oneOf', 'anyOf', 'allOf'] as const) {
    const variants = schema[branch];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      const result = walkSchema(variant, depth + 1);
      maxDepth = Math.max(maxDepth, result.depth);
      advanced = advanced || result.advanced;
    }
  }

  return { depth: maxDepth, advanced };
}

/**
 * Score a tool MENU by the complexity of its argument schemas.
 *
 * The composite weighs the three things that separate "a small model can
 * drive this" from "it will hallucinate arguments": how many parameters a
 * call has to get right, how deeply they nest, and whether the schema uses
 * constructs (unions, arrays of objects, long enums) that require the model
 * to reason about structure rather than fill blanks. Tools with an
 * unreadable schema are skipped, not counted as simple.
 */
export function scoreToolSchemas(tools: unknown[]): ToolSchemaComplexity {
  let analyzed = 0;
  let paramSum = 0;
  let maxParams = 0;
  let maxDepth = 0;
  let advancedTools = 0;
  let requiredSum = 0;

  for (const tool of tools ?? []) {
    const schema = toolParameterSchema(tool);
    if (!schema) continue;
    analyzed += 1;

    const properties = asRecord(schema.properties);
    const paramCount = properties ? Object.keys(properties).length : 0;
    paramSum += paramCount;
    maxParams = Math.max(maxParams, paramCount);

    const required = Array.isArray(schema.required) ? schema.required.length : 0;
    requiredSum += required;

    const walk = walkSchema(schema, 1);
    maxDepth = Math.max(maxDepth, walk.depth);
    if (walk.advanced) advancedTools += 1;
  }

  if (analyzed === 0) return EMPTY_TOOL_COMPLEXITY;

  const avgParams = paramSum / analyzed;
  const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
  // Equal thirds: argument breadth, structural depth, advanced constructs.
  const score = clamp01(
    (clamp01(avgParams / PARAMS_SATURATION)
      + clamp01((maxDepth - 1) / (DEPTH_SATURATION - 1))
      + advancedTools / analyzed)
      / 3,
  );

  return {
    toolsAnalyzed: analyzed,
    avgParams: Math.round(avgParams * 10) / 10,
    maxParams,
    maxDepth,
    advancedSchemaTools: advancedTools,
    avgRequiredParams: Math.round((requiredSum / analyzed) * 10) / 10,
    score: Math.round(score * 100) / 100,
    band:
      score >= COMPLEX_BAND_SCORE
        ? 'complex'
        : score >= MODERATE_BAND_SCORE
          ? 'moderate'
          : 'simple',
  };
}

// ── Language detection ─────────────────────────────────────────────────────

export interface LanguageMix {
  /** ISO 639-1 code of the dominant language, or 'unknown'. */
  primary: string;
  /** Share of classified samples that landed on `primary`, in [0,1]. */
  primaryShare: number;
  /** Share of classified samples that are NOT English, in [0,1]. */
  nonEnglishShare: number;
  /** Samples that could be classified (short/empty ones are skipped). */
  classified: number;
  samples: number;
}

export const UNKNOWN_LANGUAGE_MIX: LanguageMix = {
  primary: 'unknown',
  primaryShare: 0,
  nonEnglishShare: 0,
  classified: 0,
  samples: 0,
};

/** Below this many word tokens a sample is too short to classify. */
const MIN_WORDS_FOR_LANGUAGE = 8;
/** A stopword verdict needs this share of the sample's matched hits. */
const MIN_LANGUAGE_CONFIDENCE = 0.35;
/**
 * Absolute and relative floors on stopword evidence. Without them a single
 * incidental hit decides — 'SELECT id FROM users ORDER BY id' would be
 * classified English on the strength of one 'from'. Natural prose runs 30–50%
 * function words, so 8% is a floor that code, logs and identifier soup fail
 * and real sentences clear comfortably.
 */
const MIN_STOPWORD_HITS = 3;
const MIN_STOPWORD_DENSITY = 0.08;
/** Characters inspected per sample — prompts can be huge. */
const LANGUAGE_SAMPLE_CHARS = 4_000;

/**
 * Non-Latin scripts are decided by codepoint, before any stopword work: a
 * text is Japanese if it contains kana, Korean if it contains hangul, and so
 * on. Order matters — kana and hangul outrank Han, which both borrow.
 */
const SCRIPT_RANGES: Array<{ code: string; pattern: RegExp }> = [
  { code: 'ja', pattern: /[぀-ヿ]/ },
  { code: 'ko', pattern: /[가-힯ᄀ-ᇿ]/ },
  { code: 'zh', pattern: /[一-鿿]/ },
  { code: 'ru', pattern: /[Ѐ-ӿ]/ },
  { code: 'ar', pattern: /[؀-ۿ]/ },
  { code: 'he', pattern: /[֐-׿]/ },
  { code: 'el', pattern: /[Ͱ-Ͽ]/ },
  { code: 'th', pattern: /[฀-๿]/ },
  { code: 'hi', pattern: /[ऀ-ॿ]/ },
];

/** Share of characters that must belong to a script before it decides. */
const SCRIPT_DOMINANCE = 0.15;

/**
 * Function-word sets. These are the highest-frequency words of each language
 * and barely overlap across them, which is what makes counting them a
 * reliable classifier on samples of a sentence or more. Turkish is first
 * because it is the case this console exists to serve.
 */
const STOPWORDS: Record<string, string[]> = {
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'olarak', 'daha', 'çok', 'gibi', 'ama', 'veya', 'değil', 'kadar', 'sonra', 'önce', 'olan', 'olduğu', 'var', 'yok', 'her', 'tüm', 'göre', 'ise', 'da', 'de', 'mi', 'ne', 'şey', 'eğer', 'ancak'],
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'with', 'you', 'are', 'this', 'as', 'be', 'it', 'on', 'or', 'not', 'your', 'from', 'they', 'will', 'can', 'if', 'when', 'what', 'which', 'have', 'has', 'should'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'ein', 'eine', 'sich', 'auf', 'von', 'zu', 'den', 'dem', 'werden', 'auch', 'wird', 'oder'],
  fr: ['le', 'la', 'les', 'et', 'des', 'du', 'un', 'une', 'est', 'pas', 'pour', 'dans', 'que', 'qui', 'sur', 'avec', 'vous', 'plus', 'sont', 'ce'],
  es: ['el', 'la', 'los', 'las', 'que', 'de', 'en', 'un', 'una', 'por', 'para', 'con', 'no', 'es', 'se', 'su', 'lo', 'como', 'más', 'pero'],
  it: ['il', 'la', 'di', 'che', 'un', 'una', 'per', 'non', 'con', 'sono', 'del', 'della', 'come', 'più', 'anche', 'nel', 'alla', 'questo'],
  pt: ['de', 'que', 'do', 'da', 'em', 'um', 'uma', 'para', 'com', 'não', 'os', 'as', 'no', 'na', 'por', 'mais', 'como', 'você'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'niet', 'dat', 'op', 'te', 'voor', 'met', 'zijn', 'aan', 'door', 'ook'],
};

const STOPWORD_INDEX: Array<{ code: string; words: Set<string> }> = Object.entries(STOPWORDS).map(
  ([code, words]) => ({ code, words: new Set(words) }),
);

/**
 * Classify one text sample. Returns an ISO 639-1 code, or undefined when the
 * sample is too short or too ambiguous to call — an honest abstention beats a
 * coin flip, because the caller uses this to gate model candidates.
 */
export function detectLanguage(raw: string): string | undefined {
  const text = (raw ?? '').slice(0, LANGUAGE_SAMPLE_CHARS);
  if (!text.trim()) return undefined;

  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length > 0) {
    for (const { code, pattern } of SCRIPT_RANGES) {
      const matches = letters.match(new RegExp(pattern.source, 'gu'));
      if (matches && matches.length / letters.length >= SCRIPT_DOMINANCE) return code;
    }
  }

  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < MIN_WORDS_FOR_LANGUAGE) return undefined;

  const hits = new Map<string, number>();
  let total = 0;
  for (const word of words) {
    for (const { code, words: set } of STOPWORD_INDEX) {
      if (!set.has(word)) continue;
      hits.set(code, (hits.get(code) ?? 0) + 1);
      total += 1;
    }
  }
  if (total < MIN_STOPWORD_HITS || total / words.length < MIN_STOPWORD_DENSITY) {
    return undefined;
  }

  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  const [topCode, topHits] = ranked[0];
  if (topHits / total < MIN_LANGUAGE_CONFIDENCE) return undefined;
  // A tie between two languages is an abstention, not a guess.
  if (ranked.length > 1 && ranked[1][1] === topHits) return undefined;
  return topCode;
}

/**
 * Aggregate per-sample verdicts into a workload-level language mix.
 * Unclassifiable samples are excluded from the shares rather than counted as
 * English — the difference matters when the gate is "is this traffic
 * non-English?".
 */
export function detectLanguageMix(texts: string[]): LanguageMix {
  const counts = new Map<string, number>();
  let classified = 0;
  for (const text of texts ?? []) {
    const code = detectLanguage(text);
    if (!code) continue;
    classified += 1;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  if (classified === 0) return { ...UNKNOWN_LANGUAGE_MIX, samples: (texts ?? []).length };

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const nonEnglish = classified - (counts.get('en') ?? 0);
  return {
    primary: ranked[0][0],
    primaryShare: Math.round((ranked[0][1] / classified) * 100) / 100,
    nonEnglishShare: Math.round((nonEnglish / classified) * 100) / 100,
    classified,
    samples: (texts ?? []).length,
  };
}
