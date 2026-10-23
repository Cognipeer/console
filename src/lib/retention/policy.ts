/**
 * Tenant retention policy: how many days each data class is kept.
 *
 * Resolution, last one wins:  built-in class default  →  RETENTION_<CLASS>_DAYS
 * (deployment)  →  tenant policy  →  project override.  Every number is then
 * clamped to the class range, and `audit` never goes below
 * RETENTION_AUDIT_MIN_DAYS.
 *
 * Storage: one document (`tenant`) in the IAM document store's
 * `retention_policies` collection, identical on MongoDB and SQLite. A tenant
 * that never saved a policy runs on the deployment defaults.
 *
 * Shortening is delayed: a save that would make anything expire sooner keeps
 * the old numbers for RETENTION_SHORTEN_DELAY_HOURS (as `pending`), so a
 * mistyped 3 instead of 30 can still be cancelled before the sweep acts on it.
 * Lengthening applies at once.
 */

import { getConfig } from '@/lib/core/config';
import type { DatabaseProvider } from '@/lib/database';
import {
  RETENTION_CLASS_IDS,
  RETENTION_CLASSES,
  RETENTION_PRESETS,
  isRetentionClassId,
  isRetentionPresetId,
  type RetentionClassId,
  type RetentionPresetId,
} from './classes';
import { policyDrivenClasses } from './targets';

const COLLECTION = 'retention_policies' as const;
const DOC_ID = 'tenant';
const HOUR_MS = 60 * 60 * 1000;
/** A project override list that size is a configuration mistake, not a policy. */
const MAX_PROJECT_OVERRIDES = 200;

export type ClassDays = Partial<Record<RetentionClassId, number>>;

export interface RetentionPolicyInput {
  preset: RetentionPresetId | 'custom';
  classes: ClassDays;
  /** projectId → the classes that project keeps differently. */
  projects: Record<string, ClassDays>;
}

export interface RetentionPolicy extends RetentionPolicyInput {
  /** The saved policy that takes over at `effectiveAt` (a shortening waiting out its delay). */
  pending: (RetentionPolicyInput & { effectiveAt: string; requestedBy: string | null }) | null;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type DaysSource = 'default' | 'deployment' | 'tenant' | 'project';

export interface ResolvedClass {
  days: number;
  source: DaysSource;
  minDays: number;
  maxDays: number;
}

export class RetentionPolicyError extends Error {
  readonly code = 'validation' as const;
  constructor(readonly details: Array<{ message: string; field?: string }>) {
    super(details.map((d) => d.message).join('; '));
    this.name = 'RetentionPolicyError';
  }
}

export function emptyPolicy(): RetentionPolicy {
  // The built-in class defaults are the Standard preset's numbers.
  return { preset: 'standard', classes: {}, projects: {}, pending: null, version: 0, updatedAt: null, updatedBy: null };
}

/** The shortest a class may be: its own minimum, and the deployment floor for `audit`. */
export function classMinDays(id: RetentionClassId): number {
  const min = RETENTION_CLASSES[id].minDays;
  return id === 'audit' ? Math.max(min, getConfig().retention.auditMinDays) : min;
}

function clampDays(id: RetentionClassId, days: number): number {
  const min = classMinDays(id);
  return Math.min(Math.max(Math.round(days), min), Math.max(RETENTION_CLASSES[id].maxDays, min));
}

/** The deployment-level number (no tenant policy). */
function deploymentDays(id: RetentionClassId): { days: number; source: DaysSource } {
  const env = (getConfig().retention.classDays as ClassDays)[id];
  if (env !== undefined) return { days: clampDays(id, env), source: 'deployment' };
  return { days: clampDays(id, RETENTION_CLASSES[id].defaultDays), source: 'default' };
}

/** Effective days per class for the tenant, or for one project when `projectId` is given. */
export function resolveClasses(policy: RetentionPolicyInput, projectId?: string): Record<RetentionClassId, ResolvedClass> {
  const out = {} as Record<RetentionClassId, ResolvedClass>;
  const project = projectId ? policy.projects[projectId] : undefined;
  for (const id of RETENTION_CLASS_IDS) {
    let resolved = deploymentDays(id);
    const tenantDays = policy.classes[id];
    if (tenantDays !== undefined) resolved = { days: clampDays(id, tenantDays), source: 'tenant' };
    const projectDays = project?.[id];
    if (projectDays !== undefined) resolved = { days: clampDays(id, projectDays), source: 'project' };
    out[id] = { ...resolved, minDays: classMinDays(id), maxDays: RETENTION_CLASSES[id].maxDays };
  }
  return out;
}

// ── validation ────────────────────────────────────────────────────────────

function parseClassDays(value: unknown, field: string, details: Array<{ message: string; field?: string }>): ClassDays {
  const out: ClassDays = {};
  if (value === undefined || value === null) return out;
  if (typeof value !== 'object' || Array.isArray(value)) {
    details.push({ message: 'must be an object of class → days', field });
    return out;
  }
  const editable = policyDrivenClasses();
  for (const [key, days] of Object.entries(value as Record<string, unknown>)) {
    if (!isRetentionClassId(key) || !editable.has(key)) {
      details.push({ message: `"${key}" is not a class a policy can set`, field: `${field}.${key}` });
      continue;
    }
    if (days === null || days === undefined) continue;
    if (typeof days !== 'number' || !Number.isInteger(days)) {
      details.push({ message: 'must be a whole number of days', field: `${field}.${key}` });
      continue;
    }
    const min = classMinDays(key);
    const max = RETENTION_CLASSES[key].maxDays;
    if (days < min || days > max) {
      details.push({ message: `must be between ${min} and ${max} days`, field: `${field}.${key}` });
      continue;
    }
    out[key] = days;
  }
  return out;
}

/** Checks a policy sent by the API. A preset with no `classes` means "the preset's numbers". */
export function parsePolicyInput(body: unknown): RetentionPolicyInput {
  const details: Array<{ message: string; field?: string }> = [];
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const preset = raw.preset === undefined ? 'custom' : raw.preset;
  if (preset !== 'custom' && !isRetentionPresetId(preset)) {
    details.push({ message: 'unknown preset', field: 'preset' });
  }
  let classes = parseClassDays(raw.classes, 'classes', details);
  if (raw.classes === undefined && isRetentionPresetId(preset)) classes = { ...RETENTION_PRESETS[preset] };

  const projects: Record<string, ClassDays> = {};
  if (raw.projects !== undefined && raw.projects !== null) {
    if (typeof raw.projects !== 'object' || Array.isArray(raw.projects)) {
      details.push({ message: 'must be an object of projectId → classes', field: 'projects' });
    } else {
      const entries = Object.entries(raw.projects as Record<string, unknown>);
      if (entries.length > MAX_PROJECT_OVERRIDES) {
        details.push({ message: `at most ${MAX_PROJECT_OVERRIDES} project overrides`, field: 'projects' });
      }
      for (const [projectId, value] of entries.slice(0, MAX_PROJECT_OVERRIDES)) {
        // Keys land in a stored document: no dots, no `$`.
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
          details.push({ message: 'invalid project id', field: `projects.${projectId}` });
          continue;
        }
        const days = parseClassDays(value, `projects.${projectId}`, details);
        if (Object.keys(days).length > 0) projects[projectId] = days;
      }
    }
  }
  if (details.length > 0) throw new RetentionPolicyError(details);
  return { preset: preset as RetentionPolicyInput['preset'], classes, projects };
}

// ── storage ───────────────────────────────────────────────────────────────

function fromStored(data: Record<string, unknown> | undefined): RetentionPolicy {
  if (!data) return emptyPolicy();
  const policy = emptyPolicy();
  policy.preset = data.preset === 'custom' || isRetentionPresetId(data.preset) ? data.preset : 'custom';
  policy.classes = (data.classes as ClassDays) ?? {};
  policy.projects = (data.projects as Record<string, ClassDays>) ?? {};
  policy.pending = (data.pending as RetentionPolicy['pending']) ?? null;
  policy.version = typeof data.version === 'number' ? data.version : 0;
  policy.updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null;
  policy.updatedBy = typeof data.updatedBy === 'string' ? data.updatedBy : null;
  return policy;
}

function toStored(policy: RetentionPolicy): Record<string, unknown> {
  return { ...policy };
}

/**
 * The tenant's policy, with a pending shortening applied (and saved, unless
 * `persist` is false) once it is due. The caller has already bound the tenant.
 */
export async function loadPolicy(db: DatabaseProvider, now = new Date(), persist = true): Promise<RetentionPolicy> {
  const doc = await db.iamDocGet(COLLECTION, DOC_ID);
  const policy = fromStored(doc?.data);
  if (policy.pending && Date.parse(policy.pending.effectiveAt) <= now.getTime()) {
    const { preset, classes, projects, requestedBy } = policy.pending;
    const applied: RetentionPolicy = {
      preset,
      classes,
      projects,
      pending: null,
      version: policy.version + 1,
      updatedAt: now.toISOString(),
      updatedBy: requestedBy,
    };
    if (persist) await db.iamDocPut(COLLECTION, DOC_ID, toStored(applied));
    return applied;
  }
  return policy;
}

/** Every (project or tenant) scope whose effective days differ between two policies. */
function scopesOf(a: RetentionPolicyInput, b: RetentionPolicyInput): Array<string | undefined> {
  return [undefined, ...new Set([...Object.keys(a.projects), ...Object.keys(b.projects)])];
}

/** The classes that would expire sooner under `next` than under `current`, per scope. */
export function shortenedClasses(current: RetentionPolicyInput, next: RetentionPolicyInput): Array<{ projectId?: string; class: RetentionClassId; from: number; to: number }> {
  const out: Array<{ projectId?: string; class: RetentionClassId; from: number; to: number }> = [];
  for (const projectId of scopesOf(current, next)) {
    const before = resolveClasses(current, projectId);
    const after = resolveClasses(next, projectId);
    for (const id of policyDrivenClasses()) {
      if (after[id].days < before[id].days) out.push({ projectId, class: id, from: before[id].days, to: after[id].days });
    }
  }
  return out;
}

/**
 * Saves a policy. Lengthening is immediate; every shortening keeps its current
 * number (pinned explicitly) until the delay passes, and the full requested
 * policy waits as `pending`.
 */
export async function savePolicy(
  db: DatabaseProvider,
  input: RetentionPolicyInput,
  actor: string | null,
  now = new Date(),
): Promise<RetentionPolicy> {
  const current = await loadPolicy(db, now);
  const delayHours = getConfig().retention.shortenDelayHours;
  const shortened = delayHours > 0 ? shortenedClasses(current, input) : [];

  let active: RetentionPolicyInput = input;
  let pending: RetentionPolicy['pending'] = null;
  if (shortened.length > 0) {
    const classes: ClassDays = { ...input.classes };
    const projects: Record<string, ClassDays> = Object.fromEntries(
      Object.entries(input.projects).map(([id, days]) => [id, { ...days }]),
    );
    for (const item of shortened) {
      if (item.projectId) projects[item.projectId] = { ...projects[item.projectId], [item.class]: item.from };
      else classes[item.class] = item.from;
    }
    active = { preset: current.preset, classes, projects };
    pending = { ...input, effectiveAt: new Date(now.getTime() + delayHours * HOUR_MS).toISOString(), requestedBy: actor };
  }

  const saved: RetentionPolicy = {
    ...active,
    pending,
    version: current.version + 1,
    updatedAt: now.toISOString(),
    updatedBy: actor,
  };
  await db.iamDocPut(COLLECTION, DOC_ID, toStored(saved));
  return saved;
}

/** Drops a pending shortening; the active numbers stay. */
export async function cancelPending(db: DatabaseProvider, actor: string | null, now = new Date()): Promise<RetentionPolicy> {
  const current = await loadPolicy(db, now);
  if (!current.pending) return current;
  const saved: RetentionPolicy = { ...current, pending: null, version: current.version + 1, updatedAt: now.toISOString(), updatedBy: actor };
  await db.iamDocPut(COLLECTION, DOC_ID, toStored(saved));
  return saved;
}
