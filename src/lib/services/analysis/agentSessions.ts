/**
 * Agent sessions as an Analysis source.
 *
 * Sessions (`agent_conversations`) are read in place: nothing is copied into the
 * analysis corpus. This module holds the pure mapping/versioning helpers and the
 * small DB-calling helpers (candidate paging, run selection) the service uses.
 */

import type { getDatabase } from '@/lib/database';
import type {
  IAgentConversation,
  IAnalysisResult,
  IAnalysisRunTarget,
  IAnalysisSource,
} from '@/lib/database';
import type { AnalysisConversation, AnalysisMessage } from './types';

type Db = Awaited<ReturnType<typeof getDatabase>>;
type AgentSessionTarget = Extract<IAnalysisRunTarget, { kind: 'agent_sessions' }>;
type AgentSessionSource = Extract<IAnalysisSource, { kind: 'agent_sessions' }>;

/** Synthetic traffic (`metadata.source`): never analyzed as real sessions. */
export const EXCLUDED_ORIGINS = ['evaluation', 'redteam'];

const DEFAULT_MIN_MESSAGES = 2;
const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_DAYS = 7;
/** Rows per provider page while scanning for candidates (meta only, so cheap). */
const PAGE_SIZE = 200;
/** Ids per `ids` lookup (provider limit is 500). */
const ID_CHUNK = 500;
/** Hard stop for a candidate scan so a huge window can't run unbounded. */
const MAX_SCAN = 50_000;

/** Ids of an agent conversation as a plain string (works for ObjectId and string ids). */
export function conversationId(conv: Pick<IAgentConversation, '_id'>): string {
  const id = conv._id;
  return typeof id === 'string' ? id : id ? String(id) : '';
}

/** Where the session came from (`metadata.source`), if the writer recorded it. */
export function originOf(conv: Pick<IAgentConversation, 'metadata'>): string | null {
  const source = conv.metadata?.source;
  return typeof source === 'string' && source ? source : null;
}

export function isExcludedOrigin(conv: Pick<IAgentConversation, 'metadata'>): boolean {
  const origin = originOf(conv);
  return origin !== null && EXCLUDED_ORIGINS.includes(origin);
}

/** Flatten message content (a string, or a list of text parts) to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const text = (part as { text?: unknown } | null)?.text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function toIso(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const d = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Map a session to the engine's conversation. Only user/assistant turns with
 * text are kept (tool steps and empty turns carry nothing to decide on).
 * `referenceFields` are the human answers of an earlier review, so accuracy
 * mode can score against them.
 */
export function agentConversationToAnalysis(
  conv: IAgentConversation,
  referenceFields?: Record<string, unknown>,
): AnalysisConversation {
  const transcript: AnalysisMessage[] = [];
  for (const message of conv.messages ?? []) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const content = contentToText(message.content).trim();
    if (!content) continue;
    transcript.push({ role: message.role, content });
  }
  return {
    id: conversationId(conv),
    transcript,
    metadata: { agentKey: conv.agentKey, title: conv.title, origin: originOf(conv) },
    occurredAt: toIso(conv.updatedAt),
    ...(referenceFields && Object.keys(referenceFields).length > 0 ? { referenceFields } : {}),
  };
}

export type SourceVersion = NonNullable<IAnalysisResult['sourceVersion']>;

/** What an analysis saw of a session: enough to tell that it has changed since. */
export function sourceVersionOf(conv: Pick<IAgentConversation, 'messages'>): SourceVersion {
  const messages = conv.messages ?? [];
  const lastMessageAt = messages.length ? toIso(messages[messages.length - 1].timestamp) : undefined;
  return { messageCount: messages.length, ...(lastMessageAt ? { lastMessageAt } : {}) };
}

export function sameVersion(a?: SourceVersion | null, b?: SourceVersion | null): boolean {
  if (!a || !b) return false;
  return a.messageCount === b.messageCount && (a.lastMessageAt ?? null) === (b.lastMessageAt ?? null);
}

/** Number of user/assistant messages (works on `meta` rows, whose content is empty). */
export function turnCount(conv: Pick<IAgentConversation, 'messages'>): number {
  return (conv.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant').length;
}

/**
 * Whether a session is worth analyzing: real traffic, not mid-turn, and long
 * enough. The idle window is applied by the query (`updatedTo`).
 */
export function isCandidate(conv: IAgentConversation, target: Pick<AgentSessionTarget, 'minMessages'>): boolean {
  if (isExcludedOrigin(conv)) return false;
  if (conv.runtimeStatus === 'running' || conv.runtimeStatus === 'requires_action') return false;
  return turnCount(conv) >= target.minMessages;
}

/** The run target a definition's source describes: `to` honours the idle window, `from` the look-back. */
export function buildAgentSessionTarget(
  source: AgentSessionSource,
  now: Date,
  daysOverride?: number,
): AgentSessionTarget {
  const idleMinutes = source.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  const days = daysOverride ?? source.days ?? DEFAULT_DAYS;
  return {
    kind: 'agent_sessions',
    agentKeys: source.agentKeys,
    minMessages: source.minMessages ?? DEFAULT_MIN_MESSAGES,
    idleMinutes,
    from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(now.getTime() - idleMinutes * 60 * 1000).toISOString(),
  };
}

/**
 * Page a target's candidate sessions (meta only, newest first) until `limit`
 * are found. `filterBatch` lets the caller drop sessions a run would not pick
 * (e.g. already analyzed) while paging, so the limit counts only usable rows.
 */
export async function listAgentSessionCandidates(
  db: Db,
  projectId: string,
  target: AgentSessionTarget,
  options: {
    limit: number;
    ownOnly?: { userId: string; viewableAgentKeys?: string[] };
    filterBatch?: (batch: IAgentConversation[]) => Promise<IAgentConversation[]>;
  },
): Promise<IAgentConversation[]> {
  const out: IAgentConversation[] = [];
  let before: { updatedAt: Date; id: string } | undefined;
  let scanned = 0;
  while (out.length < options.limit && scanned < MAX_SCAN) {
    const page = await db.listAgentConversationsForAnalysis({
      projectId,
      agentKeys: target.agentKeys,
      updatedFrom: new Date(target.from),
      updatedTo: new Date(target.to),
      ownOnly: options.ownOnly,
      before,
      limit: PAGE_SIZE,
      fields: 'meta',
    });
    if (page.length === 0) break;
    scanned += page.length;
    let batch = page.filter((conv) => isCandidate(conv, target));
    if (options.filterBatch) batch = await options.filterBatch(batch);
    out.push(...batch);
    if (page.length < PAGE_SIZE) break;
    const last = page[page.length - 1];
    before = { updatedAt: new Date(last.updatedAt ?? 0), id: conversationId(last) };
  }
  return out.slice(0, options.limit);
}

/** Latest results of a set of sources (sessions or imported conversations) by one definition, keyed by source id. */
export async function loadResultsBySource(
  db: Db,
  projectId: string,
  definitionKey: string,
  sourceKind: 'conversation' | 'agent_session',
  ids: string[],
): Promise<Map<string, IAnalysisResult>> {
  const byId = new Map<string, IAnalysisResult>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const rows = await db.listAnalysisResults({
      projectId,
      definitionKey,
      sourceKind,
      sourceIds: chunk,
      limit: chunk.length,
    });
    for (const row of rows) byId.set(row.sourceId, row);
  }
  return byId;
}

export interface AgentSessionSelection {
  strategy: string;
  sampleSize?: number;
  conversationKeys?: string[];
}

function sample<T>(items: T[], size: number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, size);
}

/**
 * Resolve the session ids a run covers.
 *   - changed (default): never analyzed, or changed since the analysis
 *   - unanalyzed       : never analyzed
 *   - random           : a sample of the window
 *   - all              : everything in the window
 *   - keys             : explicit ids, kept only if they belong to the target's agents and are real traffic
 */
export async function selectAgentSessionIds(
  db: Db,
  params: {
    projectId: string;
    definitionKey: string;
    target: AgentSessionTarget;
    selection?: AgentSessionSelection;
    legacyKeys?: string[];
    max: number;
  },
): Promise<string[]> {
  const { projectId, definitionKey, target, max } = params;
  const sel: AgentSessionSelection =
    params.selection ??
    (params.legacyKeys && params.legacyKeys.length > 0
      ? { strategy: 'keys', conversationKeys: params.legacyKeys }
      : { strategy: 'changed' });

  if (sel.strategy === 'keys') {
    const wanted = Array.from(new Set(sel.conversationKeys ?? [])).slice(0, max);
    const found = new Set<string>();
    for (let i = 0; i < wanted.length; i += ID_CHUNK) {
      const chunk = wanted.slice(i, i + ID_CHUNK);
      const rows = await db.listAgentConversationsForAnalysis({
        projectId,
        agentKeys: target.agentKeys,
        ids: chunk,
        limit: chunk.length,
        fields: 'meta',
      });
      for (const row of rows) if (!isExcludedOrigin(row)) found.add(conversationId(row));
    }
    return wanted.filter((id) => found.has(id));
  }

  const onlyNew = sel.strategy === 'unanalyzed';
  const onlyChanged = sel.strategy === 'changed';
  const filterBatch =
    onlyNew || onlyChanged
      ? async (batch: IAgentConversation[]): Promise<IAgentConversation[]> => {
          if (batch.length === 0) return batch;
          const existing = await loadResultsBySource(db, projectId, definitionKey, 'agent_session', batch.map(conversationId));
          return batch.filter((conv) => {
            const result = existing.get(conversationId(conv));
            if (!result) return true;
            return onlyChanged && !sameVersion(result.sourceVersion, sourceVersionOf(conv));
          });
        }
      : undefined;

  const candidates = await listAgentSessionCandidates(db, projectId, target, { limit: max, filterBatch });
  const ids = candidates.map(conversationId);
  if (sel.strategy === 'random') {
    return sample(ids, Math.max(1, Math.min(sel.sampleSize ?? ids.length, ids.length)));
  }
  return ids;
}
