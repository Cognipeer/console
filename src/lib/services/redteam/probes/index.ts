/**
 * Probe registry. Built-in adversarial probes keyed for selection by a
 * campaign. `buildProbes(keys)` resolves a selection (or all) into configured
 * Probe instances ready for the runner.
 */

import type { IRedTeamCustomProbe } from '@/lib/database';
import type { Probe } from '../types';
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
};

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
}

function catalogEntry(probe: Probe, custom = false, name?: string): ProbeCatalogEntry {
  return {
    key: probe.key,
    name: name ?? probe.key,
    family: probe.family,
    category: probe.category,
    severity: probe.severity,
    description: probe.description,
    custom,
  };
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
        return catalogEntry(buildCustomProbe(def), true, def.name);
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
 * Passing no keys (or undefined) selects every built-in probe (never custom —
 * custom probes are opt-in and must be selected explicitly). Any `custom:`-keyed
 * selection is resolved against `customProbes`.
 */
export function buildProbes(keys?: string[], customProbes: IRedTeamCustomProbe[] = []): Probe[] {
  const selected = keys && keys.length > 0 ? keys : BUILTIN_PROBE_KEYS;
  const customByKey = new Map(customProbes.map((def) => [def.key, def]));
  return selected.map((key) => {
    if (isCustomProbeKey(key)) {
      const def = customByKey.get(key);
      if (!def) throw new Error(`Unknown red-team probe: "${key}"`);
      return buildCustomProbe(def);
    }
    const factory = PROBE_REGISTRY[key];
    if (!factory) throw new Error(`Unknown red-team probe: "${key}"`);
    return factory();
  });
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
export { buildCustomProbe, validateCustomProbe, CustomProbeError, CUSTOM_PROBE_PREFIX, isCustomProbeKey } from './customProbe';
