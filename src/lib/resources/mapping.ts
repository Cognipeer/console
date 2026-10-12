/**
 * Helpers shared by every provider. Providers build `ResourceRecord`s from an
 * explicit whitelist; these keep that boring and uniform.
 */
import type { ResourceAttribute, ResourceStatusTone } from './types';

const MAX_ATTRIBUTE_STRING = 120;

/** String id/key/name field, or null when empty/absent. ObjectIds stringify. */
export function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'string' ? value : String(value);
  return s.length > 0 ? s : null;
}

/**
 * Tenant-wide rows are stored as null, missing, '' (rag) — and SQLite mappers
 * that do `String(row.projectId)` turn a NULL column into the literal 'null'.
 * Everything collapses to null so the registry has ONE tenant-wide spelling.
 */
export function normalizeProjectId(value: unknown): string | null {
  const s = str(value);
  if (s === null || s === 'null' || s === 'undefined') return null;
  return s;
}

/** Date | ISO string | epoch -> ISO string; null when absent or unparseable. */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const OK = new Set(['active', 'enabled', 'published', 'ready']);
const OFF = new Set(['inactive', 'disabled', 'draft', 'paused']);
const WARN = new Set(['error', 'errored', 'failed']);

export function toneForStatus(status: string | null | undefined): ResourceStatusTone {
  if (!status) return 'neutral';
  const s = status.toLowerCase();
  if (OK.has(s)) return 'ok';
  if (OFF.has(s)) return 'off';
  if (WARN.has(s)) return 'warn';
  return 'neutral';
}

/** Status for a type that only has an `enabled` boolean. */
export function statusFromEnabled(enabled: unknown): string | null {
  if (typeof enabled !== 'boolean') return null;
  return enabled ? 'enabled' : 'disabled';
}

/**
 * Whitelist-builds the `attributes` list from already-chosen safe facts. Only
 * primitives survive (objects/arrays are dropped, never serialised), empty values
 * are skipped, and long strings are clipped so a field that unexpectedly holds a
 * blob cannot leak much of it.
 */
export function buildAttributes(facts: Record<string, unknown>): ResourceAttribute[] {
  const out: ResourceAttribute[] = [];
  for (const [key, value] of Object.entries(facts)) {
    if (typeof value === 'string') {
      if (value.length === 0) continue;
      out.push({
        key,
        value: value.length > MAX_ATTRIBUTE_STRING ? `${value.slice(0, MAX_ATTRIBUTE_STRING)}…` : value,
      });
    } else if (typeof value === 'number') {
      if (Number.isFinite(value)) out.push({ key, value });
    } else if (typeof value === 'boolean') {
      out.push({ key, value });
    }
  }
  return out;
}
