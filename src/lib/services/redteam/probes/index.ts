/**
 * Probe registry. Built-in adversarial probes keyed for selection by a
 * campaign. `buildProbes(keys)` resolves a selection (or all) into configured
 * Probe instances ready for the runner.
 */

import type { Probe } from '../types';
import { createPromptInjectionProbe } from './promptInjection';
import { createJailbreakProbe } from './jailbreak';
import { createSensitiveInfoProbe } from './sensitiveInfoDisclosure';
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
  family: string;
  category: string;
  severity: string;
  description: string;
}

export function listProbeCatalog(): ProbeCatalogEntry[] {
  return BUILTIN_PROBE_KEYS.map((key) => {
    const probe = PROBE_REGISTRY[key]();
    return {
      key: probe.key,
      family: probe.family,
      category: probe.category,
      severity: probe.severity,
      description: probe.description,
    };
  });
}

/**
 * Resolve probe keys into configured Probe instances. Unknown keys throw so a
 * misconfigured campaign fails loudly rather than silently scanning nothing.
 * Passing no keys (or undefined) selects every built-in probe.
 */
export function buildProbes(keys?: string[]): Probe[] {
  const selected = keys && keys.length > 0 ? keys : BUILTIN_PROBE_KEYS;
  return selected.map((key) => {
    const factory = PROBE_REGISTRY[key];
    if (!factory) throw new Error(`Unknown red-team probe: "${key}"`);
    return factory();
  });
}

export {
  createPromptInjectionProbe,
  createJailbreakProbe,
  createSensitiveInfoProbe,
  createEncodingInjectionProbe,
  createInsecureOutputProbe,
  createExcessiveAgencyProbe,
  createOverrelianceProbe,
  createPiiGenerationProbe,
  createDataExtractionProbe,
};
