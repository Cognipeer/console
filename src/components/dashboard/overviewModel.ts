/**
 * What the dashboard home (Overview) shows, worked out from data it already has: the `GET /api/dashboard` stats,
 * daily series and recent sessions, and the services the navigation offers the person in the ACTIVE project
 * (roles, group grants, custom policies and project limits, as the engine decides them).
 *
 * The API blanks the numbers of a service the caller cannot read (models, vector, tracing), so a number is shown
 * only to someone who can open its service; a zero would otherwise read as "you have none".
 *
 * Shared by the community page and the Enterprise overlay's page.
 */

export interface OverviewStats {
  models: { total: number; llm: number; embedding: number };
  vectors: { providers: number; indexes: number };
  tracing: { totalSessions: number; totalTokens: number; activeSessions: number };
  apiCalls: { total: number; trend: number };
}

export interface OverviewDailyPoint {
  date: string;
  sessionsCount: number;
  totalTokens: number;
}

/** A session from `recentSessions` (dates arrive as ISO strings). */
export interface OverviewSession {
  sessionId: string;
  agentName?: string;
  status?: string;
  startedAt?: string;
  durationMs?: number;
  totalTokens?: number;
}

interface OfferedService {
  id: string;
  href: string;
}

/** The line of a stat tile, from the API's daily series. None for fewer than two days: a line needs two points. */
export function dailyLine(
  daily: readonly OverviewDailyPoint[] | undefined,
  key: 'sessionsCount' | 'totalTokens',
): number[] | undefined {
  if (!daily || daily.length < 2) return undefined;
  return daily.map((point) => Number(point[key]) || 0);
}

export type OverviewTileId = 'sessions' | 'tokens' | 'models' | 'indexes';

/**
 * The stat tiles, each only for a person who can open the service its number comes from: agent sessions and
 * tokens from Tracing, models from Model Hub, indexes from Vector.
 */
export function overviewTiles(offered: ReadonlySet<string>): OverviewTileId[] {
  const tiles: OverviewTileId[] = [];
  if (offered.has('tracing')) tiles.push('sessions', 'tokens');
  if (offered.has('models')) tiles.push('models');
  if (offered.has('vector')) tiles.push('indexes');
  return tiles;
}

export type GetStartedStepId = 'model' | 'knowledge' | 'agent';

export interface GetStartedStep {
  id: GetStartedStepId;
  href: string;
  done: boolean;
  /** An optional step does not keep the card on the page. */
  optional: boolean;
}

/**
 * The first steps of a project, ticked from what the project already has:
 *
 * 1. Connect a model: done once the project has an LLM. Needs Model Hub.
 * 2. Add knowledge (optional): an embedding model and a vector index. Needs Model Hub and Vector, whose counts tell
 *    whether it is done; it links to Knowledge Engine when the person can open it, else to Vector.
 * 3. Build an agent and try it: done after the first agent session. Needs Agents, and Tracing for the session count.
 *
 * A step is left out when the person cannot open the service it links to, or cannot read the numbers that tick it
 * (it could never be ticked). `stats` must cover the whole project (the "Total" period), not a date range.
 */
export function getStartedSteps(services: readonly OfferedService[], stats: OverviewStats): GetStartedStep[] {
  const hrefs = new Map(services.map((service) => [String(service.id), service.href]));
  const steps: GetStartedStep[] = [];
  const models = hrefs.get('models');
  if (models) {
    steps.push({ id: 'model', href: models, done: stats.models.llm > 0, optional: false });
  }
  const vector = hrefs.get('vector');
  if (models && vector) {
    steps.push({
      id: 'knowledge',
      href: hrefs.get('rag') ?? vector,
      done: stats.models.embedding > 0 && stats.vectors.indexes > 0,
      optional: true,
    });
  }
  const agents = hrefs.get('agents');
  if (agents && hrefs.has('tracing')) {
    steps.push({ id: 'agent', href: agents, done: stats.tracing.totalSessions > 0, optional: false });
  }
  return steps;
}

/** Every step that is not optional is done (or there is none): the card has nothing left to suggest. */
export function getStartedComplete(steps: readonly GetStartedStep[]): boolean {
  return steps.every((step) => step.optional || step.done);
}

/** Link to a tracing session's page. */
export function sessionHref(sessionId: string): string {
  return `/dashboard/tracing/sessions/${encodeURIComponent(sessionId)}`;
}
