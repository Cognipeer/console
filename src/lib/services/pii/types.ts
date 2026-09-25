/**
 * Public types for the standalone PII service.
 */

import type {
  IPiiPolicy,
  IPiiCustomPattern,
  PiiAction,
  PiiEngine,
  PiiLanguage,
} from '@/lib/database';
import type { PiiSeverity } from './categories';

export type { PiiAction, PiiEngine, PiiLanguage, IPiiCustomPattern };

/** A single occurrence of PII in scanned text. */
export interface PiiFinding {
  /** Category id (built-in id or custom pattern's `categoryId`). */
  category: string;
  /** Whether this came from a custom pattern. */
  source: 'builtin' | 'custom';
  /** Severity for this finding. */
  severity: PiiSeverity;
  /** The matched value (verbatim from input). */
  value: string;
  /** Zero-based start offset in the input text. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** Display label (locale-aware). */
  label: string;
  /** Locale-aware message describing the detection. */
  message: string;
  /** Action applied to this finding (detect / redact / mask / block). */
  action: PiiAction;
  /** Whether this finding should block in caller policy semantics. */
  block: boolean;
  /** Suggested replacement when redacting/masking. Always present so the caller
   *  can stitch the output with a single pass even in detect-only mode. */
  replacement: string;

  // ── PII v2 (additive — undefined on any pre-v2 caller/test) ──────────────
  /**
   * 0–1 confidence, this category's `baseScore` plus a context-word boost
   * (see `confidence.ts`), or the noisy-OR of multiple detectors agreeing on
   * the same span (`detectAsync`'s fusion). NOT used to filter `detect()`'s
   * output unless a policy sets `detection.minConfidence > 0` — its absence
   * of effect on the default path is what keeps every pre-v2 policy's
   * findings identical to before this field existed.
   */
  confidence?: number;
  /** Which layer raised this finding. `detect()` (sync, pattern-only) always reports 'pattern'; `detectAsync` can also report 'dictionary' or 'ner'. */
  detector?: 'pattern' | 'dictionary' | 'ner';
  /** Short human-readable reasons (context word matched, sequence pattern, checksum) — the confidence number's audit trail. */
  evidence?: string[];
}

/** A single vault entry: maps a token back to its original value. */
export interface PiiVaultEntry {
  /** Original (pre-tokenization) value. */
  value: string;
  /** Category id the value was detected as. */
  category: string;
}

/**
 * Token → original-value mapping returned by tokenize operations. Hold onto
 * this and pass it back to `detokenize` to restore the original text (e.g.
 * after a round-trip through an LLM). Keys are tokens like `[EMAIL_1]`.
 */
export type PiiVault = Record<string, PiiVaultEntry>;

/** Result returned to API consumers (text-shaped). */
export interface PiiScanResult {
  /** Input text length (characters). */
  inputLength: number;
  /** Findings sorted by start offset. */
  findings: PiiFinding[];
  /** Output text after applying findings' replacements (only when action != detect). */
  outputText: string;
  /** Whether any finding has `block === true`. */
  hasBlocking: boolean;
  /** The action that was applied (echo of input/policy). */
  action: PiiAction;
  /** Languages used for the scan. */
  languages: PiiLanguage[];
  /** Token → original-value vault. Present only when action === 'tokenize'. */
  vault?: PiiVault;
  /** PII v2: present (non-empty) only when `detectAsync` ran and something didn't complete as requested — a NER model unavailable, a window timing out, input clipped. Absent on the `detect()` (pattern-only) path. */
  degraded?: string[];
}

export interface PiiServicePolicyView extends Omit<IPiiPolicy, '_id'> {
  id: string;
}

/** One category as shown to an operator — the shape both engines' catalogs
 *  (`services/pii/categories.ts`'s `PII_CATEGORIES` and
 *  `cognipeerCategories.ts`'s `COGNIPEER_PII_CATEGORIES`) are normalised
 *  into, so the UI (`PiiPolicyEditor`) never has to know which one it is
 *  rendering. */
export interface CategoryCatalogEntry {
  id: string;
  label: string;
  description: string;
  languages: PiiLanguage[];
  severity: 'low' | 'medium' | 'high';
  defaultEnabled: boolean;
}

export interface CreatePiiPolicyInput {
  name: string;
  description?: string;
  projectId?: string;
  defaultAction: PiiAction;
  /** Absent = 'regex'. See `PiiEngine`'s own doc comment. */
  engine?: PiiEngine;
  categories: Record<string, boolean>;
  customPatterns?: IPiiCustomPattern[];
  languages?: PiiLanguage[];
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export type UpdatePiiPolicyInput = Partial<Omit<CreatePiiPolicyInput, 'projectId'>>;

export interface DetectInput {
  text: string;
  /** Categories to enable. If omitted, defaultEnabled set is used. */
  categories?: Record<string, boolean>;
  /** Custom regex patterns (one-off, not persisted). */
  customPatterns?: IPiiCustomPattern[];
  /** Languages to include. Default: ['global']. */
  languages?: PiiLanguage[];
  /** Locale for finding labels/messages. Default: 'en'. */
  locale?: PiiLanguage;
  /** Which detector runs this ad-hoc scan. Absent = 'regex' — the ad-hoc
   *  routes have no stored policy to read it from, so a caller testing a
   *  cognipeer-engine draft (not yet saved) must pass it explicitly. */
  engine?: PiiEngine;
}

export interface RedactInput extends DetectInput {
  action?: 'redact' | 'mask';
}

/** Input for the tokenize operation (same detection options as DetectInput). */
export type TokenizeInput = DetectInput;

/** Input for the detokenize operation: tokenized text + the vault to reverse it. */
export interface DetokenizeInput {
  /** Text containing tokens (e.g. an LLM response that echoed `[EMAIL_1]`). */
  text: string;
  /** Vault returned by a prior tokenize call. */
  vault: PiiVault;
}
