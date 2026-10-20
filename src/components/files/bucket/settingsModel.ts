/**
 * The Settings tab as pure functions: the General form (what changed, what is acceptable), the bucket's prefix and
 * when it is locked, the gauges of the Usage card, the delete dialog's rules and where a blocking agent is
 * linked to. Kept apart from the components so the rules are tested without a DOM.
 */

import { resolveServiceCatalogEntry } from '@/lib/services/serviceCatalog';
import type { BucketDetail, BucketUser, FileLimits, UpdateBucketInput } from '../filesApi';
import {
  BUCKET_DESCRIPTION_MAX,
  BUCKET_NAME_MAX,
  BUCKET_PREFIX_MAX,
  bucketDescriptionFault,
  bucketNameFault,
  bucketPrefixFault,
  normalizeBucketPrefix,
} from '../shared/bucketRules';
import { DELETE_STALLED_AFTER_MS, isQuietFor } from '../shared/jobClock';

/* ── General ─────────────────────────────────────────────────────────────── */

export const NAME_MAX_LENGTH = BUCKET_NAME_MAX;
export const DESCRIPTION_MAX_LENGTH = BUCKET_DESCRIPTION_MAX;

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
  return bucketNameFault(name);
}

export type DescriptionProblem = 'tooLong';

export function descriptionProblem(description: string): DescriptionProblem | null {
  return bucketDescriptionFault(description);
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

/** The longest prefix the field takes (the server's limit, after the slashes around it are dropped). */
export const PREFIX_MAX_LENGTH = BUCKET_PREFIX_MAX;

/**
 * Where the bucket's objects sit inside the provider: its own prefix, or its key when it has none (`''` is the
 * provider's root). The server resolves it the same way.
 */
export function effectivePrefix(bucket: Pick<BucketDetail, 'key' | 'prefix'>): string {
  const own = bucket.prefix;
  if (own === undefined || own === null) return bucket.key;
  return own.replace(/^\/+|\/+$/g, '');
}

/** A prefix as typed: blanks and the slashes around it do not count, and a doubled slash inside is one. */
export function normalizePrefixInput(text: string): string {
  return normalizeBucketPrefix(text);
}

/** `controlChars` is a backslash or a control character; `dotSegments` a `.` folder or `..` anywhere. */
export type PrefixProblem = 'dotSegments' | 'controlChars' | 'tooLong';

export function prefixProblem(text: string): PrefixProblem | null {
  const fault = bucketPrefixFault(text);
  if (fault === null) return null;
  return fault === 'dots' ? 'dotSegments' : fault === 'control' ? 'controlChars' : 'tooLong';
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

export function quotaOf(limits: FileLimits | null | undefined): {
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
export function agentFilesHref(agent: Pick<BucketUser, 'agentId'>): string {
  return `/dashboard/agents/${encodeURIComponent(agent.agentId)}?tab=files`;
}

export interface DeleteRules {
  /** An agent keeps its session files here: the bucket cannot be deleted until it picks another. */
  blocked: boolean;
  agents: BucketUser[];
  fileCount: number;
  /** The bucket holds files: deleting it asks what becomes of them (removed from the provider too, or left there). */
  holdsFiles: boolean;
  /** A delete-with-files job is running (or was, before it was lost). */
  deleting: boolean;
  /** `deleting` for so long that the job was most likely lost with a restart: asking again queues it anew. */
  stalled: boolean;
  /** Why the last delete-with-files run stopped before the bucket was gone; null when it did not stop. */
  lastError: string | null;
}

type DeleteSubject = Partial<Pick<BucketDetail, 'usedBy' | 'stats' | 'deleting' | 'deleteError' | 'metadata' | 'updatedAt'>>;

export function deleteRules(bucket: DeleteSubject, now: number = Date.now()): DeleteRules {
  const agents = Array.isArray(bucket.usedBy) ? bucket.usedBy : [];
  const fileCount = bucket.stats?.fileCount ?? 0;
  const deleting = bucket.deleting === true;
  return {
    blocked: agents.length > 0,
    agents,
    fileCount,
    holdsFiles: fileCount > 0,
    deleting,
    // The server marks the bucket (and so touches `updatedAt`) when the job is asked for, and not again until it ends.
    stalled: deleting && isQuietFor(bucket.updatedAt, DELETE_STALLED_AFTER_MS, now),
    lastError: deleting ? null : deleteErrorOf(bucket),
  };
}

/**
 * Why the last delete-with-files run stopped, when the bucket says so. The list and the bucket carry it as
 * `deleteError`; an answer to an update (which returns the bare bucket) only has it in `metadata`.
 */
export function deleteErrorOf(bucket: Pick<DeleteSubject, 'deleteError' | 'metadata'>): string | null {
  if (typeof bucket.deleteError === 'string' && bucket.deleteError.trim()) return bucket.deleteError.trim();
  const value = bucket.metadata?.deleteError;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return null;
}
