/**
 * The `cognipeer` PII engine — a bridge onto the bundled, offline
 * `@cognipeer/pii` npm package, called from `piiService.ts#scanWithPolicy`
 * (and the ad-hoc detect/redact/mask/tokenize routes) whenever
 * `IPiiPolicy.engine === 'cognipeer'`.
 *
 * THE CONTRACT THIS FILE HAS TO MEET: `scanWithPolicy` and every downstream
 * caller (the guardrail `pii` family, `/api/client/v1/pii/*`, the test
 * panel) know only the shape in `./types` — `PiiFinding`/`PiiScanResult` —
 * and never which engine produced it. `scanWithCognipeer` therefore has to
 * behave exactly like the in-house `detect()`/`detectAsync()`
 * (`./detector.ts`) from the CALLER's point of view: same `PiiAction` input
 * (all five values, including `'block'`/`'tokenize'`, which the npm
 * package's own public API does not know about), same finding shape out.
 *
 * NOT EXPOSED YET: the package's `detection.mode` tier ladder
 * (`pattern` / `+dictionary` / `+dictionary+ner` / `+ner-verified`). Hardcoded
 * to `pattern+dictionary` below — the lightest tier that still makes
 * `person`/`organization`/`location` reachable, with NO extra dependency
 * (`onnxruntime-node` is only needed for the two NER tiers). Revisit if/when
 * tier selection is exposed in the UI, the same way `services/pii/detector.ts`
 * exposes `IPiiPolicy.detection.mode` for the `regex` engine.
 */

import type { IPiiCustomPattern, PiiAction, PiiLanguage } from '@/lib/database';
import type { PiiFinding } from './types';

/** Cached module reference — the package's functions are stateless calls (no
 *  `.load()` step to repeat, unlike `@cognipeer/guardrail`'s classifier
 *  instance), so this exists only to pay the `import()` cost once. */
let piiModule: ReturnType<typeof loadPii> | undefined;

function loadPii() {
  return import('@cognipeer/pii');
}

/** Exported for this module's own unit test only. */
export function _resetCognipeerPiiCache(): void {
  piiModule = undefined;
}

function getPii() {
  if (!piiModule) piiModule = loadPii();
  return piiModule;
}

const DEFAULT_MODE = 'pattern+dictionary' as const;

export interface CognipeerScanOptions {
  categories?: Record<string, boolean>;
  customPatterns?: IPiiCustomPattern[];
  languages?: PiiLanguage[];
}

export interface CognipeerScanOutcome {
  findings: PiiFinding[];
  /** Human-readable degradation notes (e.g. a layer falling back) — NOT "this
   *  scan failed"; a thrown error is how that is signalled, same as the
   *  in-house engine. */
  degraded: string[];
}

export async function scanWithCognipeer(
  text: string,
  options: CognipeerScanOptions,
  action: PiiAction,
): Promise<CognipeerScanOutcome> {
  const pii = await getPii();
  const callOptions = {
    categories: options.categories,
    customPatterns: options.customPatterns,
    languages: options.languages,
    detection: { mode: DEFAULT_MODE },
  };

  // The package's public API has three action-shaped calls, not five — see
  // this file's own header. 'block' and 'tokenize' both use `detectAsync`:
  // neither needs the package's own `replacement` (the caller's `tokenize()`
  // helper builds its own token strings from `value`/`start`/`end`, and a
  // 'block' verdict is stamped onto every family's findings identically by
  // `scanWithPolicy` regardless of which engine produced them).
  const scan = action === 'redact'
    ? await pii.redactAsync(text, callOptions)
    : action === 'mask'
      ? await pii.maskAsync(text, callOptions)
      : await pii.detectAsync(text, callOptions);

  const findings: PiiFinding[] = scan.findings.map((f) => ({
    category: f.category,
    source: f.source,
    severity: f.severity,
    value: f.value,
    start: f.start,
    end: f.end,
    label: f.label,
    message: f.message,
    // The REQUESTED action, not the package's own report (which only ever
    // says 'detect'/'redact'/'mask') — matches the in-house `detect()`,
    // which stamps `action: actionMode` verbatim for whatever it was called
    // with, 'block'/'tokenize' included.
    action,
    block: action === 'block',
    replacement: f.replacement,
    confidence: f.confidence,
    detector: f.detector,
    evidence: f.evidence,
  }));

  const degraded = (scan.degraded ?? []).map((d) => `${d.layer}: ${d.reason}`);
  return { findings, degraded };
}
