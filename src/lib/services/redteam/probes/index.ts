/**
 * Probe registry. Built-in adversarial probes keyed for selection by a
 * campaign. `buildProbes(keys)` resolves a selection (or all) into configured
 * Probe instances ready for the runner.
 */

import type { IRedTeamCustomAttempt, IRedTeamCustomProbe } from '@/lib/database';
import type { Probe, ProbeDetectorSpec, ProbePolarity, ProbeReference, ProbeRequirement, ProbeTargetKind } from '../types';
import { buildCustomProbe, isCustomProbeKey } from './customProbe';
import { createPromptInjectionProbe } from './promptInjection';
import { createJailbreakProbe } from './jailbreak';
import { createSensitiveInfoProbe } from './sensitiveInfoDisclosure';
import { createSystemPromptLeakageProbe } from './systemPromptLeakage';
import { createEncodingInjectionProbe } from './encodingInjection';
import { createInsecureOutputProbe } from './insecureOutput';
import { createExcessiveAgencyProbe } from './excessiveAgency';
import { createOverrelianceProbe } from './overreliance';
import { createPiiGenerationProbe } from './piiGeneration';
import { createDataExtractionProbe } from './dataExtraction';
import { LIBRARY_PROBES } from './library';

/** The probes a campaign runs when it selects none: the original ten. The library probes are opt-in. */
export const DEFAULT_PROBE_KEYS: readonly string[] = [
  'prompt-injection',
  'encoding-injection',
  'jailbreak',
  'sensitive-info-disclosure',
  'system-prompt-leakage',
  'pii-generation',
  'data-extraction',
  'insecure-output-handling',
  'excessive-agency',
  'overreliance-hallucination',
];

/** Factory per built-in probe key. Add new probes here. */
export const PROBE_REGISTRY: Record<string, () => Probe> = {
  'prompt-injection': createPromptInjectionProbe,
  'encoding-injection': createEncodingInjectionProbe,
  jailbreak: createJailbreakProbe,
  'sensitive-info-disclosure': createSensitiveInfoProbe,
  'system-prompt-leakage': createSystemPromptLeakageProbe,
  'pii-generation': createPiiGenerationProbe,
  'data-extraction': createDataExtractionProbe,
  'insecure-output-handling': createInsecureOutputProbe,
  'excessive-agency': createExcessiveAgencyProbe,
  'overreliance-hallucination': createOverrelianceProbe,
  ...LIBRARY_PROBES,
};

/** Every built-in key (validation and the catalog); a campaign with no selection runs DEFAULT_PROBE_KEYS. */
export const BUILTIN_PROBE_KEYS = Object.keys(PROBE_REGISTRY);

/** Catalog metadata for UI / API listing, without instantiating detectors twice. */
export interface ProbeCatalogEntry {
  key: string;
  /** Friendly display label (built-ins reuse the key; custom probes their name). */
  name: string;
  family: string;
  category: string;
  severity: string;
  description: string;
  /** True for user-authored probes (built-ins are false / omitted). */
  custom?: boolean;
  /**
   * Every attempt of the probe plants a system turn (a secret or a rule to leak),
   * so the probe cannot run against a target that keeps its own instructions, as
   * an agent does.
   */
  requiresSystemPrompt: boolean;
  /** At least one attempt is adaptive: it needs an attacker model to escalate. */
  needsJudgeModel: boolean;
  /** Built-in revision (custom probes: 1). A clone records the version it copied. */
  version: number;
  technique?: string;
  references: ProbeReference[];
  /** Target kinds the probe runs against. */
  targets: ProbeTargetKind[];
  requires: ProbeRequirement[];
  /** ISO date the probe joined the catalog. */
  addedAt?: string;
  polarity: ProbePolarity;
  /** Every attempt carries a forged history, so only a target that takes the caller's history can run it. */
  requiresHistory: boolean;
  attemptCount: number;
  /** Attempts that run on an agent: no system turn, no history, and the probe targets agents. */
  agentAttemptCount: number;
  /** Detector keys in build order, e.g. `refusal`, `pattern`, `pii`, `llm-judge:<lens>`. */
  detectors: string[];
  /** In DEFAULT_PROBE_KEYS (runs when a campaign selects no probes). */
  isDefault: boolean;
  /** Custom probes only. */
  id?: string;
  origin?: 'manual' | 'clone' | 'import';
  clonedFrom?: { probeKey: string; version: number };
  sourceName?: string;
}

/** A built-in probe in the form of a custom definition: what "clone" copies and the detail page shows. */
export type BuiltinProbeDefinition = ProbeCatalogEntry & {
  attempts: IRedTeamCustomAttempt[];
  detectorSpec: ProbeDetectorSpec;
};

function catalogEntry(probe: Probe, custom = false, name?: string, def?: IRedTeamCustomProbe): ProbeCatalogEntry {
  const attempts = probe.generate();
  const targets = probe.targets ?? ['model', 'agent'];
  return {
    key: probe.key,
    name: name ?? probe.key,
    family: probe.family,
    category: probe.category,
    severity: probe.severity,
    description: probe.description,
    custom,
    requiresSystemPrompt: attempts.length > 0 && attempts.every((a) => Boolean(a.system)),
    needsJudgeModel: attempts.some((a) => a.adaptive === true),
    version: probe.version ?? 1,
    ...(probe.technique ? { technique: probe.technique } : {}),
    references: probe.references ?? [],
    targets: [...targets],
    requires: probe.requires ?? [],
    ...(probe.addedAt ? { addedAt: probe.addedAt } : {}),
    polarity: probe.polarity ?? 'attack',
    requiresHistory: attempts.length > 0 && attempts.every((a) => (a.history?.length ?? 0) > 0),
    attemptCount: attempts.length,
    agentAttemptCount: targets.includes('agent') ? attempts.filter((a) => !a.system && !(a.history?.length)).length : 0,
    detectors: probe.detectors.map((d) => d.key),
    isDefault: !custom && DEFAULT_PROBE_KEYS.includes(probe.key),
    ...(def
      ? {
          id: def._id !== undefined ? String(def._id) : undefined,
          origin: def.origin ?? 'manual',
          ...(def.clonedFrom ? { clonedFrom: def.clonedFrom } : {}),
          ...(def.source?.name ? { sourceName: def.source.name } : {}),
        }
      : {}),
  };
}

/**
 * A built-in probe as a custom definition (null for an unknown or custom key).
 * The canary value in a system turn is written back as `{{canary}}`, so a clone
 * built with `buildCustomProbe` yields the same attempts and detectors.
 */
export function builtinProbeDefinition(key: string): BuiltinProbeDefinition | null {
  if (!Object.prototype.hasOwnProperty.call(PROBE_REGISTRY, key)) return null;
  const probe = PROBE_REGISTRY[key]();
  if (!probe.detectorSpec) throw new Error(`Built-in red-team probe "${key}" has no detectorSpec`);
  const attempts: IRedTeamCustomAttempt[] = probe.generate().map((a) => {
    const canary = a.expect?.canary;
    const system = a.system && canary ? a.system.split(canary).join('{{canary}}') : a.system;
    return {
      id: a.id,
      turns: [...a.turns],
      ...(system !== undefined ? { system } : {}),
      ...(canary ? { canary } : {}),
      ...(a.expect?.forbiddenPatterns?.length ? { forbiddenPatterns: [...a.expect.forbiddenPatterns] } : {}),
      refusalExpected: a.expect?.refusalExpected ?? true,
      ...(a.adaptive !== undefined ? { adaptive: a.adaptive } : {}),
      ...(a.objective !== undefined ? { objective: a.objective } : {}),
      ...(a.history?.length ? { history: a.history.map((m) => ({ role: m.role, content: m.content })) } : {}),
    };
  });
  return { ...catalogEntry(probe), attempts, detectorSpec: probe.detectorSpec };
}

/**
 * Catalog metadata for the built-in probes plus any supplied custom definitions.
 * Custom probes that fail validation are skipped (a half-authored draft should
 * not break the picker), so only runnable probes are advertised.
 */
export function listProbeCatalog(customProbes: IRedTeamCustomProbe[] = []): ProbeCatalogEntry[] {
  const builtins = BUILTIN_PROBE_KEYS.map((key) => catalogEntry(PROBE_REGISTRY[key](), false));
  const custom = customProbes
    .filter((def) => def.enabled !== false)
    .map((def) => {
      try {
        return catalogEntry(buildCustomProbe(def), true, def.name, def);
      } catch {
        return null;
      }
    })
    .filter((e): e is ProbeCatalogEntry => e !== null);
  return [...builtins, ...custom];
}

/**
 * Resolve probe keys into configured Probe instances. Unknown keys throw so a
 * misconfigured campaign fails loudly rather than silently scanning nothing.
 * Passing no keys (or undefined) selects the default set, DEFAULT_PROBE_KEYS (never custom —
 * custom probes are opt-in and must be selected explicitly). Any `custom:`-keyed
 * selection is resolved against `customProbes`.
 */
export function buildProbes(keys?: string[], customProbes: IRedTeamCustomProbe[] = []): Probe[] {
  const selected = keys && keys.length > 0 ? keys : DEFAULT_PROBE_KEYS;
  const customByKey = new Map(customProbes.map((def) => [def.key, def]));
  const probes: Probe[] = [];
  for (const key of selected) {
    if (isCustomProbeKey(key)) {
      const def = customByKey.get(key);
      if (!def) throw new Error(`Unknown red-team probe: "${key}"`);
      // A probe the operator switched off stays in the campaign's selection but
      // is not run, so disabling it takes effect without editing every campaign.
      if (def.enabled === false) continue;
      probes.push(buildCustomProbe(def));
      continue;
    }
    const factory = PROBE_REGISTRY[key];
    if (!factory) throw new Error(`Unknown red-team probe: "${key}"`);
    probes.push(factory());
  }
  return probes;
}

/**
 * Like `buildProbes`, for a campaign whose selection may have outlived its
 * probes: a key that no longer resolves (a deleted custom probe, a built-in
 * that was renamed, a custom definition that no longer validates) is returned in
 * `missing` instead of throwing, so the scan runs what is left and the caller can
 * say what it skipped. A custom probe that is switched off is skipped quietly,
 * as in `buildProbes`.
 */
export function buildProbesLenient(
  keys?: string[],
  customProbes: IRedTeamCustomProbe[] = [],
): { probes: Probe[]; missing: string[] } {
  const selected = keys && keys.length > 0 ? keys : DEFAULT_PROBE_KEYS;
  const customByKey = new Map(customProbes.map((def) => [def.key, def]));
  const probes: Probe[] = [];
  const missing: string[] = [];
  for (const key of selected) {
    if (isCustomProbeKey(key)) {
      const def = customByKey.get(key);
      if (!def) {
        missing.push(key);
        continue;
      }
      if (def.enabled === false) continue;
      try {
        probes.push(buildCustomProbe(def));
      } catch {
        missing.push(key);
      }
      continue;
    }
    const factory = PROBE_REGISTRY[key];
    if (!factory) {
      missing.push(key);
      continue;
    }
    probes.push(factory());
  }
  return { probes, missing };
}

export {
  createPromptInjectionProbe,
  createJailbreakProbe,
  createSensitiveInfoProbe,
  createSystemPromptLeakageProbe,
  createEncodingInjectionProbe,
  createInsecureOutputProbe,
  createExcessiveAgencyProbe,
  createOverrelianceProbe,
  createPiiGenerationProbe,
  createDataExtractionProbe,
};
export {
  buildCustomProbe,
  validateCustomProbe,
  validateCustomProbeDefinition,
  validateCustomProbePatterns,
  CustomProbeError,
  CUSTOM_PROBE_PREFIX,
  isCustomProbeKey,
} from './customProbe';
