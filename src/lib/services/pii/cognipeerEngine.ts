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
 * FORWARDED from the policy: `detection.minConfidence` and
 * `detection.contextBoost`, which mean the same thing in both engines.
 *
 * NOT EXPOSED YET: the package's `detection.mode` tier ladder
 * (`pattern` / `+dictionary` / `+dictionary+ner` / `+ner-verified`). Hardcoded
 * to `pattern+dictionary` below — the lightest tier that still makes
 * `person`/`organization`/`location` reachable, with NO extra dependency
 * (`onnxruntime-node` is only needed for the two NER tiers). Revisit if/when
 * tier selection is exposed in the UI, the same way `services/pii/detector.ts`
 * exposes `IPiiPolicy.detection.mode` for the `regex` engine.
 */

import type { IPiiCustomPattern, PiiAction, PiiDetectionConfig, PiiLanguage } from '@/lib/database';
import type { PiiFinding } from './types';
import { splitLines } from './detector';

/** Cached module reference — the package's functions are stateless calls (no
 *  `.load()` step to repeat, unlike `@cognipeer/guardrail`'s classifier
 *  instance), so this exists only to pay the `import()` cost once. */
let piiModule: Promise<typeof import('@cognipeer/pii')> | undefined;

function getPii() {
  piiModule ??= import('@cognipeer/pii');
  return piiModule;
}

const DEFAULT_MODE = 'pattern+dictionary' as const;

/** Dictionary-only categories: the package's dictionary pass emits them without consulting `categories`. */
const DICTIONARY_CATEGORIES = new Set(['person', 'organization', 'location']);

export interface CognipeerScanOptions {
  categories?: Record<string, boolean>;
  customPatterns?: IPiiCustomPattern[];
  languages?: PiiLanguage[];
  /** Only the engine-neutral knobs travel; the regex engine's `mode`/`ner`
   *  vocabulary does not map onto the package's tiers. */
  detection?: Pick<PiiDetectionConfig, 'minConfidence' | 'contextBoost'>;
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
    detection: {
      mode: DEFAULT_MODE,
      ...(options.detection?.minConfidence !== undefined ? { minConfidence: options.detection.minConfidence } : {}),
      ...(options.detection?.contextBoost !== undefined ? { contextBoost: options.detection.contextBoost } : {}),
    },
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

  type PackageFinding = (typeof scan.findings)[number];
  const toFinding = (f: PackageFinding, offset: number): PiiFinding => ({
    category: f.category,
    source: f.source,
    severity: f.severity,
    value: f.value,
    start: f.start + offset,
    end: f.end + offset,
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
  });

  // shortcut: filters after the package's fusion, so a disabled name span that out-scored an overlapping enabled finding hides it; move the filter into @cognipeer/pii's dictionary pass when the package is next released.
  const enabled = scan.findings.filter((f) => !DICTIONARY_CATEGORIES.has(f.category) || options.categories?.[f.category] === true);

  // The package sweeps its patterns over the whole text, and their separator
  // classes match a line break: "2026-07-18\n118" (a CSV's date cell plus the
  // next row's number) came back as a tc_kimlik, merging two rows of a masked
  // table. The in-house engine sweeps line by line (`splitLines`); here a
  // finding that crosses a line break is dropped and the lines it touched are
  // scanned again on their own, pattern tier only. Remove once the package
  // sweeps by line itself.
  const crossesLine = (f: PackageFinding) => /[\r\n]/.test(f.value);
  const findings = enabled.filter((f) => !crossesLine(f)).map((f) => toFinding(f, 0));
  const crossing = enabled.filter(crossesLine);
  if (crossing.length > 0) {
    const scanLine = action === 'redact' ? pii.redact : action === 'mask' ? pii.mask : pii.detect;
    const overlapsKept = (start: number, end: number) => findings.some((k) => start < k.end && k.start < end);
    const touched = splitLines(text).filter((line) =>
      crossing.some((f) => f.start < line.start + line.text.length && line.start < f.end));
    const rescued: PiiFinding[] = [];
    for (const line of touched) {
      for (const f of scanLine(line.text, callOptions).findings) {
        if (DICTIONARY_CATEGORIES.has(f.category)) continue;
        const finding = toFinding(f, line.start);
        if (!overlapsKept(finding.start, finding.end)) rescued.push(finding);
      }
    }
    findings.push(...rescued);
    findings.sort((a, b) => a.start - b.start);
  }

  const degraded = (scan.degraded ?? []).map((d) => `${d.layer}: ${d.reason}`);
  return { findings, degraded };
}
