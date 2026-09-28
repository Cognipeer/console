/**
 * `@cognipeer/guardrail` ships no type declarations (plain CJS,
 * `module.exports = { Guardrail }`). This mirrors the real surface in
 * `packages/js/src/index.js` of the `cognipeer/guardrail` training repo —
 * only `load` and `scan`, which is all `families/cognipeerGuardrail.ts` calls.
 */
declare module '@cognipeer/guardrail' {
  export interface GuardrailLoadOptions {
    /** Defaults to the model bundled inside the package. */
    modelDir?: string;
    /** Defaults to 'strict'. */
    profile?: 'strict' | 'balanced' | 'sensitive';
    /** Defaults to unbounded (every character scanned). */
    maxScanChars?: number | null;
  }

  export interface GuardrailScanResult {
    /** Raw sigmoid probability per category — not threshold-relative. */
    scores: Record<string, number>;
    /** Threshold-relative 0..1 risk; 0.5 is the decision boundary. */
    risk: Record<string, number>;
    /** Category ids whose risk crossed 0.5. */
    triggered: string[];
    flagged: boolean;
    maxRisk: number;
    /** True when `maxScanChars` cut the input before scoring. */
    truncated: boolean;
  }

  export class Guardrail {
    static load(opts?: GuardrailLoadOptions): Promise<Guardrail>;
    scan(text: string): Promise<GuardrailScanResult>;
  }
}
