/**
 * Custom probe builder — turns a persisted `IRedTeamCustomProbe` definition into
 * a runtime `Probe` the engine can drive, exactly like the built-in catalog.
 *
 * The mapping is deliberately thin: the stored attempts become `ProbeAttempt`s
 * (with `{{canary}}` substituted into the system turn) and the stored detector
 * selection is composed from the same detector factories the built-ins use, so
 * a custom probe is a first-class citizen of the probe → detect → decide loop.
 */

import type { IRedTeamCustomProbe } from '@/lib/database';
import { createLlmJudgeDetector, createPatternDetector, createRefusalDetector } from '../detectors';
import type { Detector, OwaspLlmCategory, Probe, ProbeAttempt, Severity } from '../types';

/** Selection keys for custom probes are namespaced to avoid built-in clashes. */
export const CUSTOM_PROBE_PREFIX = 'custom:';

export function isCustomProbeKey(key: string): boolean {
  return key.startsWith(CUSTOM_PROBE_PREFIX);
}

/** Validation error thrown when a definition cannot produce a runnable probe. */
export class CustomProbeError extends Error {}

/** Assert a definition is runnable. Throws CustomProbeError with a clear reason. */
export function validateCustomProbe(def: Pick<IRedTeamCustomProbe, 'attempts' | 'detectors'>): void {
  if (!Array.isArray(def.attempts) || def.attempts.length === 0) {
    throw new CustomProbeError('a custom probe needs at least one attempt');
  }
  for (const a of def.attempts) {
    if (!Array.isArray(a.turns) || a.turns.length === 0 || a.turns.some((t) => typeof t !== 'string' || !t.trim())) {
      throw new CustomProbeError(`attempt "${a.id ?? '?'}" must have at least one non-empty turn`);
    }
  }
  const d = def.detectors ?? {};
  const judgeCount = d.judges?.length ?? 0;
  if (!d.refusal && !d.pattern && judgeCount === 0) {
    throw new CustomProbeError('a custom probe needs at least one detector (refusal, pattern, or a judge lens)');
  }
}

function buildDetectors(def: IRedTeamCustomProbe): Detector[] {
  const detectors: Detector[] = [];
  const d = def.detectors ?? {};
  if (d.refusal) detectors.push(createRefusalDetector());
  if (d.pattern) detectors.push(createPatternDetector());
  for (const judge of d.judges ?? []) {
    detectors.push(
      createLlmJudgeDetector({
        lens: judge.lens,
        rubric: judge.rubric,
        threshold: judge.threshold,
      }),
    );
  }
  return detectors;
}

function buildAttempts(def: IRedTeamCustomProbe): ProbeAttempt[] {
  return def.attempts.map((a) => {
    const system = a.system && a.canary ? a.system.replace(/\{\{\s*canary\s*\}\}/g, a.canary) : a.system;
    return {
      id: a.id,
      turns: a.turns,
      system,
      expect: {
        canary: a.canary,
        forbiddenPatterns: a.forbiddenPatterns,
        refusalExpected: a.refusalExpected ?? true,
      },
      adaptive: a.adaptive,
      objective: a.objective,
    };
  });
}

/** Convert a stored definition into a runtime Probe. Throws if not runnable. */
export function buildCustomProbe(def: IRedTeamCustomProbe): Probe {
  validateCustomProbe(def);
  const detectors = buildDetectors(def);
  const attempts = buildAttempts(def);
  return {
    key: def.key,
    family: def.family || 'custom',
    category: def.category as OwaspLlmCategory,
    severity: def.severity as Severity,
    description: def.description,
    detectors,
    generate: () => attempts,
  };
}
