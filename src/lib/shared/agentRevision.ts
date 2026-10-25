/**
 * Agent revisions — which configuration of an agent a test run exercises (see
 * `AgentRevision`). Shared by the API routes that read one from a request, the
 * services that store a default, and the screens that label a run, so every
 * layer reads a value the same way. Dependency-free: type imports only.
 */

import type { AgentRevision, IAgentRunRevision } from '@/lib/database/provider/types.domain';

export type { AgentRevision, IAgentRunRevision };

export type AgentRevisionParse =
  | { ok: true; revision: AgentRevision | undefined }
  | { ok: false; error: string };

/**
 * Read a revision from a request body. Absent stays absent, so a PATCH can
 * leave a stored default alone; `null` means `published`, which is how an edit
 * clears a pin. A version may arrive as digits because CI tends to pass it
 * through an environment variable. Anything else is refused: running some
 * other configuration than the one asked for would be the worst answer.
 */
export function parseAgentRevision(raw: unknown, field = 'agentVersion'): AgentRevisionParse {
  if (raw === undefined) return { ok: true, revision: undefined };
  if (raw === null || raw === 'published') return { ok: true, revision: 'published' };
  if (raw === 'draft') return { ok: true, revision: 'draft' };
  const version = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (Number.isSafeInteger(version) && version >= 1) return { ok: true, revision: version };
  return { ok: false, error: `${field} must be "published", "draft" or a version number (1 or more)` };
}

/**
 * Read one run's override. On a stored default `null` clears the pin (`published`); on a run it is no override
 * at all, as a missing key is, so the target's or campaign's default applies.
 */
export function parseAgentRunOverride(raw: unknown, field = 'agentVersion'): AgentRevisionParse {
  return raw === null ? { ok: true, revision: undefined } : parseAgentRevision(raw, field);
}

/** A stored default (a target's or campaign's `agentVersion`) as a revision; anything else follows the published version. */
export function storedAgentRevision(stored: unknown): AgentRevision {
  if (stored === 'draft') return 'draft';
  if (typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 1) return stored;
  return 'published';
}

/** How a revision is stored as a default: following the published version is the absence of a pin. */
export function toStoredAgentVersion(revision: AgentRevision): number | 'draft' | null {
  return revision === 'published' ? null : revision;
}

/**
 * A version picker's value as a stored default: `'draft'` stays, digits pin that version, and anything else
 * (`''`, `'published'`) follows the published version, which is stored as the absence of a pin.
 */
export function storedVersionFromPicker(value: string | null | undefined): number | 'draft' | null {
  if (value === 'draft') return 'draft';
  const version = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

/** `published`, `draft` or `v3`. */
export function agentRevisionLabel(revision: AgentRevision): string {
  return typeof revision === 'number' ? `v${revision}` : revision;
}

/** Two runs that asked for the same revision; they would test the same thing. */
export function sameAgentRevision(a: AgentRevision, b: AgentRevision): boolean {
  return agentRevisionLabel(a) === agentRevisionLabel(b);
}

/** A run's revision in the snake_case envelope of the client API (`/client/v1/*`). */
export function agentRevisionApiView(run: IAgentRunRevision | undefined): Record<string, unknown> | undefined {
  if (!run) return undefined;
  return {
    requested: run.requested,
    version: run.version,
    draft_fingerprint: run.draftFingerprint,
    draft_changed: run.draftChanged,
  };
}

/**
 * One line for a run: what answered, and what was asked for when the two
 * differ — `v4 (published)`, `draft (nothing published)`, `draft · 3f2a…`.
 * A run that has not started yet shows what it asked for.
 */
export function describeRunRevision(run: IAgentRunRevision): string {
  const { requested, version } = run;
  if (version === undefined) return agentRevisionLabel(requested);
  if (typeof version === 'number') return requested === 'published' ? `v${version} (published)` : `v${version}`;
  if (requested === 'published') return 'draft (nothing published)';
  return run.draftFingerprint ? `draft · ${run.draftFingerprint}` : 'draft';
}
