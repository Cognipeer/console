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
import {
  createLlmJudgeDetector,
  createNamedDetector,
  createPatternDetector,
  createRefusalDetector,
  isNamedDetectorKey,
} from '../detectors';
import { patternListError } from '../detectors/safePattern';
import { ATTEMPT_ID_PATTERN, CUSTOM_PROBE_LIMITS } from '../limits';
import { isKnownOwaspCategory, normalizeOwaspCategory } from '../owasp';
import { NAMED_DETECTOR_KEYS } from '../types';
import type {
  Detector,
  NamedDetectorKey,
  OwaspLlmCategory,
  Probe,
  ProbeAttempt,
  ProbeDetectorSpec,
  Severity,
} from '../types';

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
  const namedCount = Array.isArray(d.named) ? d.named.length : 0;
  if (!d.refusal && !d.pattern && namedCount === 0 && judgeCount === 0) {
    throw new CustomProbeError('a custom probe needs at least one detector (refusal, pattern, a named detector, or a judge lens)');
  }
}

type PatternAttempt = Pick<IRedTeamCustomProbe['attempts'][number], 'id' | 'forbiddenPatterns'>;

function samePatterns(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((p, i) => p === y[i]);
}

/**
 * Save-time limits on the forbidden patterns a user stores. Checked when a probe
 * is created or changed, not when it runs: a stored probe that predates the
 * limits still runs, and its patterns are bounded at match time instead. On an
 * update, an attempt whose pattern list is unchanged from the stored one is not
 * checked again, so such a probe can still be renamed or re-rated.
 */
export function validateCustomProbePatterns(attempts: PatternAttempt[], stored: PatternAttempt[] = []): void {
  const storedById = new Map(stored.map((a) => [a.id, a.forbiddenPatterns]));
  for (const a of attempts) {
    if (storedById.has(a.id) && samePatterns(storedById.get(a.id), a.forbiddenPatterns)) continue;
    const error = patternListError(a.forbiddenPatterns ?? []);
    if (error) throw new CustomProbeError(`attempt "${a.id ?? '?'}": ${error}`);
  }
}

function validateHistory(history: unknown, id: string): void {
  const L = CUSTOM_PROBE_LIMITS;
  if (!Array.isArray(history)) throw new CustomProbeError(`attempt "${id}": history must be a list of messages`);
  if (history.length > L.maxHistoryMessages) {
    throw new CustomProbeError(`attempt "${id}": history has more than ${L.maxHistoryMessages} messages`);
  }
  for (const m of history as Array<{ role?: unknown; content?: unknown }>) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      throw new CustomProbeError(`attempt "${id}": a history message needs the role "user" or "assistant"`);
    }
    if (typeof m.content !== 'string' || !m.content.trim()) {
      throw new CustomProbeError(`attempt "${id}": a history message needs content`);
    }
    if (m.content.length > L.maxTurnChars) throw tooLong('a history message', L.maxTurnChars, id);
  }
}

const CANARY_PLACEHOLDER = /\{\{\s*canary\s*\}\}/;

const tooLong = (what: string, max: number, id?: string) =>
  new CustomProbeError(`${id === undefined ? '' : `attempt "${id}": `}${what} is longer than ${max} characters`);

/**
 * Everything checked when a custom probe is saved: the runnable minimum
 * (`validateCustomProbe`), the size limits, unique well-formed attempt ids, a
 * known OWASP category, a canary that is really planted, and the forbidden
 * patterns (`validateCustomProbePatterns`; pass the stored attempts on an update
 * so unchanged lists are not checked again).
 *
 * Save time only: a probe stored before these rules still runs, which is why
 * `buildCustomProbe` calls just `validateCustomProbe`.
 */
export function validateCustomProbeDefinition(
  def: Pick<IRedTeamCustomProbe, 'attempts' | 'detectors' | 'category' | 'polarity'>,
  stored: PatternAttempt[] = [],
): void {
  validateCustomProbe(def);
  const L = CUSTOM_PROBE_LIMITS;

  if (!isKnownOwaspCategory(def.category)) {
    throw new CustomProbeError(
      `category "${String(def.category)}" is not an OWASP Top 10 for LLM Applications (2025) category, for example LLM01-prompt-injection`,
    );
  }
  if (def.attempts.length > L.maxAttempts) {
    throw new CustomProbeError(`a custom probe can have at most ${L.maxAttempts} attempts`);
  }

  const seen = new Set<string>();
  for (const a of def.attempts) {
    if (typeof a.id !== 'string' || !ATTEMPT_ID_PATTERN.test(a.id)) {
      throw new CustomProbeError(
        `attempt id "${String(a.id)}" must be 1-${L.maxAttemptIdLength} characters: letters, digits, ".", "_" or "-"`,
      );
    }
    if (seen.has(a.id)) throw new CustomProbeError(`attempt id "${a.id}" is used more than once; ids must be unique within the probe`);
    seen.add(a.id);

    if (a.turns.length > L.maxTurnsPerAttempt) {
      throw new CustomProbeError(`attempt "${a.id}" has more than ${L.maxTurnsPerAttempt} turns`);
    }
    if (a.turns.some((t) => t.length > L.maxTurnChars)) throw tooLong('a turn', L.maxTurnChars, a.id);
    if (a.system !== undefined && a.system.length > L.maxSystemChars) throw tooLong('the system prompt', L.maxSystemChars, a.id);
    if (a.objective !== undefined && a.objective.length > L.maxObjectiveChars) throw tooLong('the objective', L.maxObjectiveChars, a.id);

    if (a.history !== undefined) validateHistory(a.history, a.id);

    if (a.canary && !(a.system && (CANARY_PLACEHOLDER.test(a.system) || a.system.includes(a.canary)))) {
      throw new CustomProbeError(`attempt "${a.id}": Put {{canary}} in the system prompt so the canary is planted`);
    }
  }

  if (def.polarity !== undefined && def.polarity !== 'attack' && def.polarity !== 'over-refusal') {
    throw new CustomProbeError('polarity must be "attack" or "over-refusal"');
  }
  const named = def.detectors?.named;
  if (named !== undefined) {
    if (!Array.isArray(named)) throw new CustomProbeError('named detectors must be a list');
    if (named.length > L.maxNamedDetectors) {
      throw new CustomProbeError(`a custom probe can have at most ${L.maxNamedDetectors} named detectors`);
    }
    const seenNamed = new Set<string>();
    for (const key of named) {
      if (!isNamedDetectorKey(key)) {
        throw new CustomProbeError(`named detector "${String(key)}" is not known; use one of ${NAMED_DETECTOR_KEYS.join(', ')}`);
      }
      if (seenNamed.has(key)) throw new CustomProbeError(`named detector "${key}" is listed more than once`);
      seenNamed.add(key);
    }
  }
  if (def.polarity === 'over-refusal') {
    if (!def.detectors?.refusal) throw new CustomProbeError('an over-refusal probe needs the refusal detector');
    if (def.detectors.pattern || (named?.length ?? 0) > 0) {
      throw new CustomProbeError('an over-refusal probe can use only the refusal detector and judge lenses');
    }
  }

  const judges = def.detectors?.judges ?? [];
  if (judges.length > L.maxJudges) throw new CustomProbeError(`a custom probe can have at most ${L.maxJudges} judge lenses`);
  for (const j of judges) {
    if (typeof j.rubric === 'string' && j.rubric.length > L.maxRubricChars) {
      throw tooLong(`the rubric of judge "${j.lens}"`, L.maxRubricChars);
    }
  }

  validateCustomProbePatterns(def.attempts, stored);
}

/**
 * A canary or a forbidden pattern is only worth anything if something looks for
 * it, so an attempt that has either gets the pattern detector even when the
 * definition switched it off.
 */
function needsPatternDetector(def: IRedTeamCustomProbe): boolean {
  if (def.polarity === 'over-refusal') return false;
  return def.attempts.some((a) => Boolean(a.canary) || (a.forbiddenPatterns?.length ?? 0) > 0);
}

/** The stored detector selection in its declarative form (what a built-in's `detectorSpec` is). */
function buildDetectorSpec(def: IRedTeamCustomProbe): ProbeDetectorSpec {
  const d = def.detectors ?? {};
  const named = (d.named ?? []).filter(isNamedDetectorKey);
  const judges = (d.judges ?? []).map((j) => ({
    lens: j.lens,
    rubric: j.rubric,
    ...(j.threshold !== undefined ? { threshold: j.threshold } : {}),
  }));
  return {
    ...(d.refusal ? { refusal: true } : {}),
    ...(d.pattern || needsPatternDetector(def) ? { pattern: true } : {}),
    ...(named.length > 0 ? { named } : {}),
    ...(judges.length > 0 ? { judges } : {}),
  };
}

function buildDetectors(def: IRedTeamCustomProbe): Detector[] {
  const detectors: Detector[] = [];
  const d = def.detectors ?? {};
  if (d.refusal) detectors.push(createRefusalDetector());
  if (d.pattern || needsPatternDetector(def)) detectors.push(createPatternDetector());
  for (const key of (d.named ?? []).filter(isNamedDetectorKey) as NamedDetectorKey[]) {
    detectors.push(createNamedDetector(key));
  }
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
    const history = (a.history ?? [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: m.content }));
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
      ...(history.length > 0 ? { history } : {}),
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
    // Definitions saved before the 2025 list carry a legacy key; the probe reports the 2025 one.
    category: normalizeOwaspCategory(def.category) as OwaspLlmCategory,
    severity: def.severity as Severity,
    description: def.description,
    polarity: def.polarity ?? 'attack',
    detectorSpec: buildDetectorSpec(def),
    detectors,
    generate: () => attempts,
  };
}
