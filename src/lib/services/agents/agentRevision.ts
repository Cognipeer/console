/**
 * Runs an agent test — an evaluation suite or a red-team scan — on the
 * configuration it asked for (`AgentRevision`). A leaf module like
 * `agentConfigResolution`: it needs the database and a hash, nothing from the
 * run engine, so the test services can call it without loading the runtime.
 */

import { createHash } from 'node:crypto';
import { getDatabase, type AgentRevision, type IAgent, type IAgentRunRevision } from '@/lib/database';
import { stableStringify } from '@/lib/services/alerts/ruleShape';

/**
 * What `executeAgentChat` is handed: one published version, the published
 * version as each call finds it, or neither — the saved draft.
 */
export type AgentRunSelector = { version: number } | { usePublished: true } | Record<string, never>;

/** A run request that cannot be honoured as asked (HTTP 400). A missing agent or version throws a plain "not found" error instead, as elsewhere. */
export class AgentRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRevisionError';
  }
}

/**
 * The selector for a stored default when nothing pinned the run first — the
 * behaviour of a caller that builds an invoker straight from a target.
 */
export function selectorForStoredDefault(stored: unknown): AgentRunSelector {
  if (stored === 'draft') return {};
  if (typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 1) return { version: stored };
  return { usePublished: true };
}

/** A short hash of a draft config, so two draft runs can be told apart and an edit during a run noticed. */
export function draftFingerprint(config: IAgent['config'] | undefined): string {
  return createHash('sha256').update(stableStringify(config ?? {})).digest('hex').slice(0, 12);
}

async function loadAgent(tenantDbName: string, agentKey: string, projectId: string | undefined) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const agent = await db.findAgentByKey(agentKey, projectId);
  if (!agent) throw new Error(`Agent "${agentKey}" not found`);
  return { db, agent };
}

/**
 * Refuse, when the run is created, a run that could not start: the agent is
 * gone or the version it pins was never published. Without this the run would
 * be created and then fail every item with the same error.
 */
export async function assertAgentRevisionRunnable(
  tenantDbName: string,
  agentKey: string,
  projectId: string | undefined,
  requested: AgentRevision,
): Promise<void> {
  const { db, agent } = await loadAgent(tenantDbName, agentKey, projectId);
  if (typeof requested !== 'number') return;
  const version = await db.findAgentVersion(String(agent._id), requested);
  if (!version) throw new Error(`Version ${requested} not found for agent "${agentKey}"`);
}

export interface StartedAgentRevision {
  /** What the run records: the request plus what answered. */
  revision: IAgentRunRevision;
  /** Handed to every `executeAgentChat` call of the run. */
  selector: AgentRunSelector;
  /** Draft runs: whether the draft was saved since the run started. Always false for a version. */
  draftChanged(): Promise<boolean>;
}

/**
 * Pin a run's configuration as it starts. `published` becomes the number
 * published right now, so every item runs that one snapshot even if someone
 * publishes halfway through. With nothing published it falls back to the
 * draft, as an API call to the agent would, and the record says so
 * (`version: null`). A draft is read afresh by every call, so the run keeps the
 * draft's fingerprint and checks it again at the end.
 */
export async function startAgentRevision(
  tenantDbName: string,
  agentKey: string,
  projectId: string | undefined,
  requested: AgentRevision,
): Promise<StartedAgentRevision> {
  const { db, agent } = await loadAgent(tenantDbName, agentKey, projectId);
  const agentId = String(agent._id);

  let version: number | null = null;
  if (typeof requested === 'number') {
    const snapshot = await db.findAgentVersion(agentId, requested);
    if (!snapshot) throw new Error(`Version ${requested} not found for agent "${agentKey}"`);
    version = snapshot.version;
  } else if (requested === 'published' && agent.publishedVersion) {
    const snapshot = await db.findAgentVersion(agentId, agent.publishedVersion);
    if (snapshot) version = snapshot.version;
  }

  if (version !== null) {
    const pinned = version;
    return {
      revision: { requested, agentKey, version: pinned },
      selector: { version: pinned },
      draftChanged: async () => false,
    };
  }

  const fingerprint = draftFingerprint(agent.config);
  return {
    revision: { requested, agentKey, version: null, draftFingerprint: fingerprint },
    selector: {},
    draftChanged: async () => {
      const current = await loadAgent(tenantDbName, agentKey, projectId).catch(() => null);
      return !current || draftFingerprint(current.agent.config) !== fingerprint;
    },
  };
}
