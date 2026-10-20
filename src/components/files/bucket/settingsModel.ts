/**
 * The Settings tab as pure functions: the General form (what changed, what is acceptable), the bucket's prefix and
 * when it is locked, the gauges of the Usage card, the delete dialog's rules and where a blocking agent is
 * linked to. Kept apart from the components so the rules are tested without a DOM.
 */

import { resolveServiceCatalogEntry } from '@/lib/services/serviceCatalog';
import type { BucketDetail, BucketUsedByAgent, FilesLimits, UpdateBucketInput } from '../filesApi';

/* ── General ─────────────────────────────────────────────────────────────── */

export const NAME_MAX_LENGTH = 120;

export type BucketStatusValue = 'active' | 'disabled';

export interface SettingsValues {
  name: string;
  description: string;
  status: BucketStatusValue;
}

/** What the form starts from: the saved bucket. */
export function valuesOf(bucket: Pick<BucketDetail, 'name' | 'description' | 'status'>): SettingsValues {
  return {
    name: bucket.name,
    description: bucket.description ?? '',
    status: bucket.status === 'active' ? 'active' : 'disabled',
  };
}

export type NameProblem = 'required' | 'tooLong';

export function nameProblem(name: string): NameProblem | null {
  const trimmed = name.trim();
  if (!trimmed) return 'required';
  return trimmed.length > NAME_MAX_LENGTH ? 'tooLong' : null;
}

/** The fields that differ from the saved bucket, as the PATCH body; empty when nothing changed. */
export function settingsPatch(values: SettingsValues, bucket: Pick<BucketDetail, 'name' | 'description' | 'status'>): UpdateBucketInput {
  const saved = valuesOf(bucket);
  const patch: UpdateBucketInput = {};
  if (values.name.trim() !== saved.name) patch.name = values.name.trim();
  if (values.description.trim() !== saved.description.trim()) patch.description = values.description.trim();
  if (values.status !== saved.status) patch.status = values.status;
  return patch;
}

export function isDirty(values: SettingsValues, bucket: Pick<BucketDetail, 'name' | 'description' | 'status'>): boolean {
  return Object.keys(settingsPatch(values, bucket)).length > 0;
}

/* ── Provider ────────────────────────────────────────────────────────────── */

/** What the provider's driver is called ("Amazon S3", "S3-compatible storage"...); the driver id for one the catalog does not know. */
export function driverNameOf(provider: { driver: string; key?: string; label?: string }): string {
  const entry = resolveServiceCatalogEntry({ driver: provider.driver, domain: 'file', key: provider.key, label: provider.label });
  return entry?.name ?? provider.driver;
}

/**
 * The Providers area is for owners and admins (its layout answers 404 to anybody else), so the links into it are
 * only drawn for them. An unknown role (outside the dashboard shell) counts as allowed: a hint, never the gate.
 */
export function mayOpenProviders(role: string | null | undefined): boolean {
  return !role || role === 'owner' || role === 'admin';
}

/* ── Prefix ──────────────────────────────────────────────────────────────── */

/** The longest prefix the field takes. */
export const PREFIX_MAX_LENGTH = 256;

/**
 * Where the bucket's objects sit inside the provider: its own prefix, or its key when it has none (`''` is the
 * provider's root). The server resolves it the same way.
 */
export function effectivePrefix(bucket: Pick<BucketDetail, 'key' | 'prefix'>): string {
  const own = bucket.prefix;
  if (own === undefined || own === null) return bucket.key;
  return own.replace(/^\/+|\/+$/g, '');
}

/** A prefix as typed: surrounding blanks and slashes do not count (the server trims them as well). */
export function normalizePrefixInput(text: string): string {
  return text.trim().replace(/^\/+|\/+$/g, '');
}

export type PrefixProblem = 'dotSegments' | 'controlChars' | 'tooLong';

export function prefixProblem(text: string): PrefixProblem | null {
  const prefix = normalizePrefixInput(text);
  if (prefix.length > PREFIX_MAX_LENGTH) return 'tooLong';
  if (/[\u0000-\u001f]/.test(prefix)) return 'controlChars';
  if (prefix.split('/').some((segment) => segment === '.' || segment === '..')) return 'dotSegments';
  return null;
}

/** The prefix is fixed once the bucket holds a file (changing it would orphan them): the server answers `prefix_locked`. */
export function isPrefixLocked(bucket: { stats?: { fileCount?: number } | null }): boolean {
  return (bucket.stats?.fileCount ?? 0) > 0;
}

/* ── Usage ───────────────────────────────────────────────────────────────── */

export type GaugeTone = 'ok' | 'warn' | 'err';

export interface Gauge {
  /** 0..100; null when the limit is unlimited (or not a positive number): there is nothing to fill. */
  percent: number | null;
  tone: GaugeTone;
}

export function gaugeOf(used: number, limit: number | null | undefined): Gauge {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return { percent: null, tone: 'ok' };
  const share = Math.max(0, used) / limit;
  const percent = Math.min(100, Math.round(share * 100));
  return { percent, tone: share >= 0.95 ? 'err' : share >= 0.8 ? 'warn' : 'ok' };
}

export function quotaOf(limits: FilesLimits | null | undefined): {
  storage: Gauge & { used: number; limit: number | null };
  files: Gauge & { used: number; limit: number | null };
} | null {
  if (!limits?.quota) return null;
  const { usedBytes, limitBytes, filesUsed, filesLimit } = limits.quota;
  return {
    storage: { ...gaugeOf(usedBytes, limitBytes), used: usedBytes, limit: limitBytes },
    files: { ...gaugeOf(filesUsed, filesLimit), used: filesUsed, limit: filesLimit },
  };
}

/* ── Delete ──────────────────────────────────────────────────────────────── */

/** The agent's Files settings, where its bucket is chosen. */
export function agentFilesHref(agent: Pick<BucketUsedByAgent, 'agentId'>): string {
  return `/dashboard/agents/${encodeURIComponent(agent.agentId)}?tab=files`;
}

export interface DeleteRules {
  /** An agent keeps its session files here: the bucket cannot be deleted until it picks another. */
  blocked: boolean;
  agents: BucketUsedByAgent[];
  fileCount: number;
  /** The bucket holds files: deleting it needs the explicit choice to remove them from the provider too. */
  needsFilesConsent: boolean;
  /** A delete-with-files job is already running. */
  deleting: boolean;
}

export function deleteRules(bucket: Partial<Pick<BucketDetail, 'usedBy' | 'stats' | 'deleting'>>): DeleteRules {
  const agents = Array.isArray(bucket.usedBy) ? bucket.usedBy : [];
  const fileCount = bucket.stats?.fileCount ?? 0;
  return {
    blocked: agents.length > 0,
    agents,
    fileCount,
    needsFilesConsent: fileCount > 0,
    deleting: bucket.deleting === true,
  };
}

/** Why the last delete attempt failed, when the bucket's record says so (a job that could not finish). */
export function deleteErrorOf(bucket: Pick<BucketDetail, 'metadata'>): string | null {
  const value = bucket.metadata?.deleteError;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return null;
}
