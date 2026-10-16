/**
 * Trace sessions delivered in parts.
 *
 * agent-sdk ≥ 0.14 keeps one trace session per turn even when the turn takes
 * several invokes (a run that paused for a tool approval, a question or a
 * client tool, then resumed). Each later part arrives with a `continuation`
 * marker and only its own events; the session-level totals it carries already
 * cover every part. Both write paths — the console's own sink for hosted
 * agents and the client ingest for SDK users — append such a part instead of
 * replacing the session's events.
 */

import type { IAgentTracingSession } from '@/lib/database';

/**
 * `continuation` on a session the SDK delivers in parts (agent-sdk ≥ 0.14):
 * the run paused for a tool approval, a question or a client tool, and this
 * payload is a later part. Read loosely so an older SDK, which never sets it,
 * keeps the replace-on-save behaviour.
 */
export function readTraceContinuationMarker(session: unknown): { part: number; firstSequence: number } | undefined {
    const marker = (session as { continuation?: { part?: unknown; firstSequence?: unknown } } | null)?.continuation;
    if (!marker || typeof marker !== 'object') return undefined;
    const part = Number(marker.part);
    const firstSequence = Number(marker.firstSequence);
    if (!Number.isInteger(part) || part < 2 || !Number.isInteger(firstSequence) || firstSequence < 1) return undefined;
    return { part, firstSequence };
}

/**
 * Folds a continued part's session doc onto the stored one. The SDK sends
 * cumulative totals (tokens, bytes, event counts, start time), so those are
 * taken as they come; what this sink derives from the part's own events —
 * models and tools used, reasoning tokens, truncations, the event count — is
 * added to what earlier parts stored. Attribution and tags set by the first
 * part (which knew the model choice) are kept when a later part lacks them.
 */
export function mergeContinuedSessionDoc(
    doc: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'>,
    existing: IAgentTracingSession,
    counts: { storedEvents: number; newEvents: number },
): void {
    doc.modelsUsed = Array.from(new Set([...(existing.modelsUsed ?? []), ...(doc.modelsUsed ?? [])]));
    doc.toolsUsed = Array.from(new Set([...(existing.toolsUsed ?? []), ...(doc.toolsUsed ?? [])]));
    doc.totalReasoningTokens = (existing.totalReasoningTokens ?? 0) + (doc.totalReasoningTokens ?? 0);
    doc.truncatedEvents = (existing.truncatedEvents ?? 0) + (doc.truncatedEvents ?? 0);
    doc.totalEvents = counts.storedEvents + counts.newEvents;
    doc.metadata = { ...(existing.metadata ?? {}), ...(doc.metadata ?? {}) };
    doc.agentModel = doc.agentModel && doc.agentModel !== 'unknown-model' ? doc.agentModel : existing.agentModel;
    doc.agent = { ...(existing.agent ?? {}), ...(doc.agent ?? {}) };
    if (existing.startedAt && (!doc.startedAt || new Date(existing.startedAt) < new Date(doc.startedAt))) {
        doc.startedAt = new Date(existing.startedAt);
    }
}

