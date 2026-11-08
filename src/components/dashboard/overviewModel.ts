/**
 * What the dashboard home shows, worked out from data it already has: the `GET /api/dashboard` stats and recent
 * sessions, the services the navigation offers the person in the ACTIVE project (roles, group grants, custom policies
 * and project limits, as the engine decides them) and the services this browser opened last.
 *
 * The API blanks the numbers of a service the caller cannot read (models, vector, tracing), so a number is shown
 * only to someone who can open its service; a zero would otherwise read as "you have none".
 */

export interface OverviewStats {
  models: { total: number; llm: number; embedding: number };
  vectors: { providers: number; indexes: number };
  tracing: { totalSessions: number; totalTokens: number; activeSessions: number };
  apiCalls: { total: number; trend: number };
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

/** A service as the home's lists read it (the navigation's definition). */
interface HomeService {
  id: string;
  isSettings?: boolean;
  defaultPinned?: boolean;
}

/** How many services "Your services" shows; the others are in the menu. */
export const HOME_SERVICES_LIMIT = 6;

/** What the home lists: every service the person can open except Home itself and the Settings pages. */
function listed<T extends HomeService>(services: readonly T[]): T[] {
  return services.filter((service) => String(service.id) !== 'services-home' && !service.isSettings);
}

/**
 * "Recently opened": the services this browser opened last (`recents`, the latest first) that the person can still
 * open, Settings pages left out.
 */
export function recentlyOpenedServices<T extends HomeService>(services: readonly T[], recents: readonly string[]): T[] {
  const byId = new Map(listed(services).map((service) => [String(service.id), service]));
  return recents.map((id) => byId.get(id)).filter((service): service is T => service !== undefined);
}

/**
 * "Your services": the services the person can open, the recently opened first, then the ones a new console starts
 * with (`defaultPinned`), then the others in the menu's order; at most `limit`. `more` counts the ones left out (they
 * are all in the menu).
 */
export function homeServices<T extends HomeService>(
  services: readonly T[],
  recents: readonly string[],
  limit = HOME_SERVICES_LIMIT,
): { shown: T[]; more: number } {
  const all = listed(services);
  const recent = recentlyOpenedServices(all, recents);
  const opened = new Set(recent.map((service) => String(service.id)));
  const others = all.filter((service) => !opened.has(String(service.id)));
  const ordered = [
    ...recent,
    ...others.filter((service) => service.defaultPinned),
    ...others.filter((service) => !service.defaultPinned),
  ];
  return { shown: ordered.slice(0, limit), more: Math.max(0, ordered.length - limit) };
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
