/**
 * `@cognipeer/pii` ships no type declarations (plain CJS,
 * `module.exports = { detect, redact, mask, ... }`). This mirrors the real
 * surface in `src/index.js` / `src/detector.js` of the `cognipeer/pii`
 * training repo — only what `services/pii/cognipeerEngine.ts` calls.
 */
declare module '@cognipeer/pii' {
  export type PiiDetectionMode =
    | 'pattern'
    | 'pattern+dictionary'
    | 'pattern+dictionary+ner'
    | 'pattern+ner-verified';

  export interface PiiCustomPatternInput {
    id?: string;
    categoryId: string;
    label?: string;
    labels?: Record<string, string>;
    pattern: string;
    flags?: string;
    languages?: string[];
    severity?: 'low' | 'medium' | 'high';
    enabled: boolean;
  }

  export interface PiiDetectOptions {
    /** Category id -> on/off. Absent = the package's own defaultEnabled set. */
    categories?: Record<string, boolean>;
    customPatterns?: PiiCustomPatternInput[];
    languages?: string[];
    locale?: string;
    detection?: {
      mode?: PiiDetectionMode;
      contextBoost?: boolean;
      ner?: {
        minScore?: number;
        maxChars?: number;
        timeoutMs?: number;
        maxConcurrent?: number;
        failMode?: 'open' | 'closed';
        decode?: 'argmax' | 'viterbi';
      };
      verify?: {
        agreeWeight?: number;
        floor?: number;
        checksumFloor?: number;
        contextFloor?: number;
        dictionaryFloor?: number;
        nerOnlyWeight?: number;
        nerOnlyNumberWeight?: number;
      };
    };
  }

  export interface PiiFinding {
    category: string;
    source: 'builtin' | 'custom';
    severity: 'low' | 'medium' | 'high';
    value: string;
    /** Absolute char offsets into the scanned text; `end` is exclusive. */
    start: number;
    end: number;
    label: string;
    message: string;
    action: 'detect' | 'redact' | 'mask' | 'tokenize';
    block: boolean;
    /** Precomputed rewrite for this finding's `action` — `[REDACTED_X]` for
     *  redact, a partial mask for mask/detect. */
    replacement: string;
    confidence: number;
    detector: 'pattern' | 'dictionary' | 'ner';
    evidence: string[];
  }

  export interface PiiScanResult {
    inputLength: number;
    findings: PiiFinding[];
    outputText: string;
    hasBlocking: boolean;
    action: string;
    languages: string[];
    /** Present only when a layer degraded (e.g. NER requested but
     *  onnxruntime-node missing) rather than throwing. */
    degraded?: Array<{ layer: string; reason: string }>;
  }

  export interface PiiCategoryDefinition {
    id: string;
    label: string;
    labels?: Record<string, string>;
    languages: string[];
    severity: 'low' | 'medium' | 'high';
    defaultEnabled: boolean;
  }

  export function detect(text: string, options?: PiiDetectOptions): PiiScanResult;
  export function redact(text: string, options?: PiiDetectOptions): PiiScanResult;
  export function mask(text: string, options?: PiiDetectOptions): PiiScanResult;
  export function detectAsync(text: string, options?: PiiDetectOptions): Promise<PiiScanResult>;
  export function redactAsync(text: string, options?: PiiDetectOptions): Promise<PiiScanResult>;
  export function maskAsync(text: string, options?: PiiDetectOptions): Promise<PiiScanResult>;
  export const categories: PiiCategoryDefinition[];
  export const categoriesById: Record<string, PiiCategoryDefinition>;
}
