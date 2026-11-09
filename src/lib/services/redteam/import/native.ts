/**
 * The Console probe export format: YAML (or JSON) with a `kind` marker and a
 * list of custom probe definitions. Browser-safe.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { IRedTeamCustomAttempt, IRedTeamCustomDetectors, IRedTeamProbeSource } from '@/lib/database';
import { IMPORT_LIMITS } from '../limits';
import { isOwaspLlmCategory, normalizeOwaspCategory } from '../owasp';
import type { Severity } from '../types';
import { ImportError } from './types';
import type { ImportProbeDraft, NativeProbe } from './types';

export const NATIVE_PROBE_KIND = 'cognipeer.redteam/probes@v1';

const SEVERITIES: readonly string[] = ['low', 'medium', 'high', 'critical'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isNativeDocument(doc: unknown): boolean {
  return isObject(doc) && doc.kind === NATIVE_PROBE_KIND && Array.isArray(doc.probes);
}

function exportSource(source: IRedTeamProbeSource | undefined): Record<string, unknown> | undefined {
  if (!source) return undefined;
  return {
    format: source.format,
    name: source.name,
    license: source.license,
    attribution: source.attribution,
    url: source.url,
    fileName: source.fileName,
  };
}

/** Serialise probes to YAML. Output is stable: no export time, no import time. */
export function exportNativeProbes(probes: NativeProbe[]): string {
  const doc = {
    kind: NATIVE_PROBE_KIND,
    probes: probes.map((p) => ({
      name: p.name,
      description: p.description,
      family: p.family,
      category: p.category,
      severity: p.severity,
      polarity: p.polarity ?? 'attack',
      attempts: p.attempts,
      detectors: p.detectors,
      source: exportSource(p.source),
      clonedFrom: p.clonedFrom,
    })),
  };
  return stringifyYaml(doc, { lineWidth: 0 });
}

function fail(index: number, name: string | undefined, message: string): never {
  throw new ImportError(`Probe ${index + 1}${name ? ` "${name}"` : ''}: ${message}`);
}

function optString(v: unknown, index: number, name: string, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fail(index, name, `${field} must be text`);
  return v;
}

function readAttempt(raw: unknown, index: number, name: string, n: number): IRedTeamCustomAttempt {
  const where = `attempt ${n + 1}`;
  if (!isObject(raw)) fail(index, name, `${where} must be an object`);
  if (typeof raw.id !== 'string' || !raw.id) fail(index, name, `${where} needs an id`);
  if (!Array.isArray(raw.turns) || raw.turns.length === 0 || raw.turns.some((t) => typeof t !== 'string')) {
    fail(index, name, `${where} needs a list of turns (text)`);
  }
  const attempt: IRedTeamCustomAttempt = { id: raw.id, turns: raw.turns as string[] };
  const system = optString(raw.system, index, name, `${where} system`);
  if (system !== undefined) attempt.system = system;
  const canary = optString(raw.canary, index, name, `${where} canary`);
  if (canary !== undefined) attempt.canary = canary;
  const objective = optString(raw.objective, index, name, `${where} objective`);
  if (objective !== undefined) attempt.objective = objective;
  if (raw.forbiddenPatterns !== undefined && raw.forbiddenPatterns !== null) {
    if (!Array.isArray(raw.forbiddenPatterns) || raw.forbiddenPatterns.some((p) => typeof p !== 'string')) {
      fail(index, name, `${where} forbiddenPatterns must be a list of text`);
    }
    attempt.forbiddenPatterns = raw.forbiddenPatterns as string[];
  }
  if (raw.refusalExpected !== undefined && raw.refusalExpected !== null) {
    if (typeof raw.refusalExpected !== 'boolean') fail(index, name, `${where} refusalExpected must be true or false`);
    attempt.refusalExpected = raw.refusalExpected;
  }
  if (raw.adaptive !== undefined && raw.adaptive !== null) {
    if (typeof raw.adaptive !== 'boolean') fail(index, name, `${where} adaptive must be true or false`);
    attempt.adaptive = raw.adaptive;
  }
  if (raw.history !== undefined && raw.history !== null) {
    if (!Array.isArray(raw.history)) fail(index, name, `${where} history must be a list`);
    attempt.history = raw.history.map((m) => {
      if (!isObject(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
        fail(index, name, `${where} history messages need a role (user or assistant) and content`);
      }
      return { role: m.role as 'user' | 'assistant', content: m.content as string };
    });
  }
  return attempt;
}

function readDetectors(raw: unknown, index: number, name: string): IRedTeamCustomDetectors {
  if (!isObject(raw)) fail(index, name, 'detectors must be an object');
  const out: IRedTeamCustomDetectors = {};
  if (raw.refusal !== undefined) out.refusal = raw.refusal === true;
  if (raw.pattern !== undefined) out.pattern = raw.pattern === true;
  if (raw.named !== undefined && raw.named !== null) {
    if (!Array.isArray(raw.named) || raw.named.some((k) => typeof k !== 'string')) {
      fail(index, name, 'detectors.named must be a list of text');
    }
    out.named = raw.named as string[];
  }
  if (raw.judges !== undefined && raw.judges !== null) {
    if (!Array.isArray(raw.judges)) fail(index, name, 'detectors.judges must be a list');
    out.judges = raw.judges.map((j) => {
      if (!isObject(j) || typeof j.lens !== 'string' || typeof j.rubric !== 'string') {
        fail(index, name, 'each judge needs a lens and a rubric');
      }
      const judge: { lens: string; rubric: string; threshold?: number } = { lens: j.lens as string, rubric: j.rubric as string };
      if (typeof j.threshold === 'number') judge.threshold = j.threshold;
      return judge;
    });
  }
  return out;
}

function readSource(raw: unknown, index: number, name: string): IRedTeamProbeSource {
  if (raw === undefined || raw === null) return { format: 'cognipeer-native-yaml', name: 'Console export' };
  if (!isObject(raw) || typeof raw.name !== 'string' || !raw.name.trim()) fail(index, name, 'source needs a name');
  const source: IRedTeamProbeSource = { name: raw.name };
  for (const field of ['format', 'license', 'attribution', 'url', 'fileName'] as const) {
    const v = raw[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') fail(index, name, `source ${field} must be text`);
    source[field] = v;
  }
  return source;
}

/** Read a Console export (YAML or JSON) into drafts for the import route. Throws ImportError. */
export function parseNativeProbes(text: string): ImportProbeDraft[] {
  if (typeof text !== 'string' || text.trim() === '') throw new ImportError('The file is empty');
  if (text.length > IMPORT_LIMITS.maxFileBytes) throw new ImportError('The file is too large');
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    throw new ImportError('The file is not valid YAML or JSON');
  }
  if (!isObject(doc) || doc.kind !== NATIVE_PROBE_KIND) {
    throw new ImportError(`Not a Console probe export (expected kind "${NATIVE_PROBE_KIND}")`);
  }
  if (!Array.isArray(doc.probes) || doc.probes.length === 0) throw new ImportError('The export has no probes');
  if (doc.probes.length > IMPORT_LIMITS.maxProbesPerImport) {
    throw new ImportError(`An import can create at most ${IMPORT_LIMITS.maxProbesPerImport} probes`);
  }
  return doc.probes.map((raw, index): ImportProbeDraft => {
    if (!isObject(raw)) fail(index, undefined, 'must be an object');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) fail(index, undefined, 'needs a name');
    if (typeof raw.category !== 'string') fail(index, name, 'needs an OWASP category');
    const category = normalizeOwaspCategory(raw.category);
    if (!isOwaspLlmCategory(category)) fail(index, name, `category "${raw.category}" is not an OWASP LLM 2025 category`);
    if (typeof raw.severity !== 'string' || !SEVERITIES.includes(raw.severity)) {
      fail(index, name, 'severity must be low, medium, high or critical');
    }
    if (!Array.isArray(raw.attempts) || raw.attempts.length === 0) fail(index, name, 'needs at least one attempt');
    const polarity = raw.polarity === 'over-refusal' ? 'over-refusal' : 'attack';
    return {
      name,
      description: optString(raw.description, index, name, 'description') ?? '',
      family: optString(raw.family, index, name, 'family') || 'imported',
      category,
      severity: raw.severity as Severity,
      polarity,
      attempts: raw.attempts.map((a, n) => readAttempt(a, index, name, n)),
      detectors: readDetectors(raw.detectors, index, name),
      source: readSource(raw.source, index, name),
    };
  });
}
