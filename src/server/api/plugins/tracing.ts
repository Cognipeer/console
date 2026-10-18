import type { FastifyPluginAsync } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import { ENTITY_METRIC_BUCKET_MS } from '@/lib/database/provider/types.base';
import type {
  AlertStatePhase,
  IAlertRule,
  IAlertState,
  IIncident,
  IncidentSeverity,
} from '@/lib/database/provider/types.domain';
import { getEntityBaselineProvider, type EntityBandPoint } from '@/enterprise/alert-extensions';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { getEntitySeries, getEntitySummaries } from '@/lib/services/entityMetrics';
import { resolveHealthRange as resolveHealthRangeFor, sparkBucketMs, type HealthRange } from '@/lib/services/entityMetrics/healthRange';
import { resolveTraceSession } from '@/lib/services/agents/traceSession';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';
import {
  authorizeServiceForRequest,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import { offsetPageOf, pageOfVisibleRows, refuseTracingThread, sendSessionRefusal } from './agent-session-access';

const logger = createLogger('api:tracing');

// Same key charset the ingest sanitizer enforces (client-tracing.ts) — the
// key reaches a Mongo `metadata.<key>` dot-path / SQLite JSON path in the DB
// layer, so an unvalidated key is a query-shape injection surface.
const METADATA_KEY_PATTERN = /^[a-zA-Z0-9_]{1,40}$/;

function parseMetadataFilter(query: Record<string, string | undefined>):
  | { metadataKey?: string; metadataValue?: string }
  | { error: string } {
  const key = query.metadataKey?.trim();
  if (!key) return {};
  if (!METADATA_KEY_PATTERN.test(key)) {
    return { error: '`metadataKey` must match /^[a-zA-Z0-9_]{1,40}$/' };
  }
  return { metadataKey: key, metadataValue: query.metadataValue };
}

const HEALTH_SPARK_POINTS = 24;
const HEALTH_DEFAULT_LIMIT = 200;
const HEALTH_MAX_LIMIT = 500;
const BASELINE_LOOKBACK_DAYS = 14;
/** Upper bound of sessions read to find the first time each agent version was seen. */
const VERSION_MARKER_SESSION_LIMIT = 5000;
const INCIDENT_MARKER_LIMIT = 200;
const INCIDENT_READ_CONCURRENCY = 8;
/** Silent agents with an active alert that are added to the scoreboard. */
const HEALTH_MISSING_KEYS_LIMIT = 50;
const SEVERITY_RANK: Record<IncidentSeverity, number> = { critical: 3, warning: 2, info: 1 };

/** Health range from the request query, inside the configured rollup retention. */
function resolveHealthRange(query: Record<string, string | undefined>): HealthRange | { error: string } {
  return resolveHealthRangeFor(query, getConfig().health.entityMetricsRetentionDays);
}

function parseHealthLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return HEALTH_DEFAULT_LIMIT;
  return Math.min(parsed, HEALTH_MAX_LIMIT);
}

type AlertMaps = { rules: Map<string, IAlertRule>; incidents: Map<string, IIncident> };

/** Which agents the enabled agent-module rules target: every agent, or a set of selected keys. */
type AgentRuleCoverage = { all: boolean; keys: Set<string> };

/**
 * Coverage of the enabled agent-module rules (one in-memory pass over the rules read once per request).
 * Legacy-scoped rules (no entity scope) target no agent here.
 */
function agentRuleCoverage(rules: Iterable<IAlertRule>): AgentRuleCoverage {
  const coverage: AgentRuleCoverage = { all: false, keys: new Set() };
  for (const rule of rules) {
    if (!rule.enabled || rule.module !== 'agents') continue;
    const entity = rule.entity;
    if (!entity || entity.entityType !== 'agent') continue;
    if (entity.mode === 'all') coverage.all = true;
    else if (entity.mode === 'selected') for (const key of entity.keys ?? []) coverage.keys.add(key);
  }
  return coverage;
}

function isCovered(coverage: AgentRuleCoverage, agentKey: string): boolean {
  return coverage.all || coverage.keys.has(agentKey);
}

/** Pending/firing alert states of enabled agent-module rules, by agent name. Two cheap reads, no incident reads. */
async function loadAgentAlertStates(
  scope: { tenantDbName: string; tenantId: string; projectId: string },
): Promise<{ states: Map<string, IAlertState[]>; coverage: AgentRuleCoverage } & AlertMaps> {
  const states = new Map<string, IAlertState[]>();
  const rules = new Map<string, IAlertRule>();
  const incidents = new Map<string, IIncident>();
  let coverage: AgentRuleCoverage = { all: false, keys: new Set() };
  await runWithTenantScope(scope.tenantDbName, async (db) => {
    const agentRules = (await db.listAlertRules(scope.tenantId, { projectId: scope.projectId, enabled: true }))
      .filter((rule) => rule.module === 'agents' && rule._id !== undefined);
    if (agentRules.length === 0) return;
    coverage = agentRuleCoverage(agentRules);
    for (const rule of agentRules) rules.set(String(rule._id), rule);
    const active = await db.listAlertStates({
      projectId: scope.projectId,
      ruleIds: [...rules.keys()],
      phases: ['pending', 'firing'],
    });
    for (const state of active) {
      if (!state.entityKey) continue;
      const list = states.get(state.entityKey) ?? [];
      list.push(state);
      states.set(state.entityKey, list);
    }
  });
  return { states, rules, incidents, coverage };
}

/**
 * Severity of a firing alert is the one of its incident: read the incidents of the firing states of
 * `entityKeys` only (the agents actually shown), into `maps.incidents`. Best effort per incident.
 */
async function loadFiringIncidents(
  scope: { tenantDbName: string; projectId: string },
  states: Map<string, IAlertState[]>,
  entityKeys: Iterable<string>,
  maps: AlertMaps,
): Promise<void> {
  const incidentIds = new Set<string>();
  for (const key of entityKeys) {
    for (const state of states.get(key) ?? []) {
      if (state.phase === 'firing' && state.incidentId) incidentIds.add(state.incidentId);
    }
  }
  if (incidentIds.size === 0) return;
  const ids = [...incidentIds];
  await runWithTenantScope(scope.tenantDbName, async (db) => {
    // Point reads by id with a small fixed fan-out: a wide scoreboard never opens hundreds of reads at once.
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try {
          const incident = await db.findIncidentById(id, scope.projectId);
          if (incident) maps.incidents.set(id, incident);
        } catch (error) {
          logger.warn('Incident of a firing agent alert unavailable', { error });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(INCIDENT_READ_CONCURRENCY, ids.length) }, worker));
  });
}

function severityOf(
  state: IAlertState,
  maps: AlertMaps,
): IncidentSeverity | undefined {
  const incident = state.incidentId ? maps.incidents.get(state.incidentId) : undefined;
  if (incident) return incident.severity;
  const configured = maps.rules.get(state.ruleId)?.severity;
  return configured && configured !== 'auto' ? configured : undefined;
}

type AgentAlertSummary = { phase: AlertStatePhase | null; severity?: IncidentSeverity; incidentId?: string };

/** The state to show for an agent: firing before pending, then the most severe. */
function summarizeAgentAlert(
  agentStates: IAlertState[] | undefined,
  maps: AlertMaps,
  includeDetails: boolean,
): AgentAlertSummary {
  if (!agentStates || agentStates.length === 0) return { phase: null };
  let best: { state: IAlertState; severity?: IncidentSeverity } | null = null;
  const rank = (entry: { state: IAlertState; severity?: IncidentSeverity }) =>
    (entry.state.phase === 'firing' ? 10 : 0) + (entry.severity ? SEVERITY_RANK[entry.severity] : 0);
  for (const state of agentStates) {
    const candidate = { state, severity: severityOf(state, maps) };
    if (!best || rank(candidate) > rank(best)) best = candidate;
  }
  if (!best) return { phase: null };
  return {
    phase: best.state.phase === 'firing' ? 'firing' : 'pending',
    ...(best.severity ? { severity: best.severity } : {}),
    ...(includeDetails && best.state.incidentId ? { incidentId: best.state.incidentId } : {}),
  };
}

type HealthMarker = { t: number; type: 'version' | 'incident'; label: string; href?: string };

/**
 * First time each agent version was seen in the range, from a bounded read of the agent's sessions
 * (newest first). When the read hit the bound the oldest part of the range was not read: the
 * versions first seen within one rollup bucket of the oldest session read may have started earlier
 * (their time is unknown), so they are left out and `partial` tells the client that earlier
 * versions may be missing.
 */
async function loadVersionMarkers(
  scope: { tenantDbName: string; projectId: string },
  agentName: string,
  range: HealthRange,
): Promise<{ markers: HealthMarker[]; partial: boolean }> {
  const { sessions } = await runWithTenantScope(scope.tenantDbName, (db) =>
    db.listAgentTracingSessions({
      agentNameExact: agentName,
      from: new Date(range.fromMs).toISOString(),
      to: new Date(range.toMs).toISOString(),
      limit: String(VERSION_MARKER_SESSION_LIMIT),
      includeTotal: false,
      projection: { agentVersion: 1, startedAt: 1, createdAt: 1 },
    }, scope.projectId),
  );
  const partial = sessions.length >= VERSION_MARKER_SESSION_LIMIT;
  const firstSeen = new Map<string, number>();
  let oldest = Number.POSITIVE_INFINITY;
  for (const row of sessions) {
    const at = new Date((row.startedAt ?? row.createdAt) as Date | string).getTime();
    if (!Number.isFinite(at)) continue;
    if (at < oldest) oldest = at;
    const version = typeof row.agentVersion === 'string' ? row.agentVersion.trim() : '';
    if (!version) continue;
    const known = firstSeen.get(version);
    if (known === undefined || at < known) firstSeen.set(version, at);
  }
  const href = `/dashboard/tracing/sessions?agent=${encodeURIComponent(agentName)}`;
  const markers: HealthMarker[] = [];
  for (const [version, t] of firstSeen) {
    if (partial && t - oldest < ENTITY_METRIC_BUCKET_MS) continue;
    markers.push({ t, type: 'version', label: /^v\d/i.test(version) ? version : `v${version}`, href });
  }
  return { markers, partial };
}

/** Incidents opened for the agent inside the range. */
async function loadIncidentMarkers(
  scope: { tenantDbName: string; tenantId: string; projectId: string },
  agentName: string,
  range: HealthRange,
): Promise<HealthMarker[]> {
  const incidents = await runWithTenantScope(scope.tenantDbName, (db) =>
    db.listIncidents(scope.tenantId, {
      projectId: scope.projectId,
      module: 'agents',
      entityKey: agentName,
      limit: INCIDENT_MARKER_LIMIT,
    }),
  );
  const markers: HealthMarker[] = [];
  for (const incident of incidents) {
    const t = new Date(incident.firedAt).getTime();
    if (!Number.isFinite(t) || t < range.fromMs || t > range.toMs) continue;
    markers.push({
      t,
      type: 'incident',
      label: incident.ruleName,
      ...(incident._id ? { href: `/dashboard/alerts/incidents/${String(incident._id)}` } : {}),
    });
  }
  return markers;
}

/** Normal-range band of the agent's error rate and p95 from the baseline seam; null without a provider or on failure. */
async function loadBaselineBand(
  scope: { tenantDbName: string; tenantId: string; projectId: string },
  agentName: string,
  range: HealthRange & { bucketMs: number },
): Promise<{ errorRate: EntityBandPoint[]; p95Ms: EntityBandPoint[] } | null> {
  const provider = getEntityBaselineProvider();
  if (!provider) return null;
  const base = {
    ...scope,
    entityType: 'agent' as const,
    entityKey: agentName,
    fromMs: range.fromMs,
    toMs: range.toMs,
    bucketMs: range.bucketMs,
    lookbackDays: BASELINE_LOOKBACK_DAYS,
  };
  try {
    const [errorRate, p95Ms] = await Promise.all([
      provider.band({ ...base, metric: 'agent_error_rate' }),
      provider.band({ ...base, metric: 'agent_p95_duration_ms' }),
    ]);
    return { errorRate, p95Ms };
  } catch (error) {
    logger.warn('Agent baseline band unavailable', { error });
    return null;
  }
}

export const tracingApiPlugin: FastifyPluginAsync = async (app) => {
  const dashboardHandler = withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const searchParams = new URLSearchParams(request.query as Record<string, string>);
      const filter = parseDashboardDateFilterFromSearchParams(searchParams);
      const from = searchParams.get('from') || filter.from?.toISOString();
      const to = searchParams.get('to') || filter.to?.toISOString();
      const timezone = searchParams.get('timezone') || undefined;

      const overview = await AgentTracingService.getDashboardOverview(
        session.tenantDbName,
        projectId,
        {
          from,
          timezone,
          to,
        },
      );

      return reply.code(200).send(overview);
    } catch (error) {
      logger.error('Tracing dashboard error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch dashboard data',
        });
    }
  });

  app.get('/tracing/dashboard', dashboardHandler);
  app.post('/tracing/dashboard', dashboardHandler);

  const sessionsHandler = withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const metadataFilter = parseMetadataFilter(query);
      if ('error' in metadataFilter) {
        return reply.code(400).send({ error: metadataFilter.error });
      }
      // A tracing session of an agent is a turn of somebody's session: the sessions of an agent whose other
      // people's sessions the caller may not view are left out. The default caller gets one plain read; a
      // restricted caller's page is filled from further reads, so it is not short while the list goes on.
      const { skip, limit } = offsetPageOf(query);
      let latest: Awaited<ReturnType<typeof AgentTracingService.listSessions>> | undefined;
      const page = await pageOfVisibleRows(request, {
        start: skip,
        limit,
        minBatch: 25,
        threadIdOf: (row: { threadId?: string | null }) => row.threadId,
        actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
        fetchPage: async (position, size) => {
          latest = await AgentTracingService.listSessions(session.tenantDbName, projectId, {
            // `agentName` is accepted as the spelling the session rows use.
            agent: query.agent ?? query.agentName,
            from: query.from,
            limit: String(size),
            query: query.query,
            skip: String(position),
            status: query.status,
            to: query.to,
            // Only sessions with truncatedEvents > 0 (a truncated/cut-off model
            // response somewhere in the session).
            truncated: query.truncated === 'true' ? true : undefined,
            ...metadataFilter,
          });
          const total = latest.total;
          return { rows: latest.sessions, after: (consumed) => (position + consumed >= total ? null : position + consumed) };
        },
      });
      if (!page.restricted && latest) return reply.code(200).send(latest);
      // A restricted caller's total cannot be known without reading everything: say where the next page starts instead.
      return reply.code(200).send({ sessions: page.rows, hasMore: page.next !== null, nextSkip: page.next });
    } catch (error) {
      logger.error('List tracing sessions error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch sessions',
        });
    }
  });

  app.get('/tracing/sessions', sessionsHandler);
  app.post('/tracing/sessions', sessionsHandler);

  app.get('/tracing/sessions/:sessionId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionId } = request.params as { sessionId: string };
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const result = await AgentTracingService.getSessionDetail(
        session.tenantDbName,
        projectId,
        sessionId,
        {
          includeEventContent: query.includeEventContent !== 'false',
        },
      );

      if (!result) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      const refusal = await refuseTracingThread(request, result.session.threadId, { actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId } });
      if (refusal) return sendSessionRefusal(reply, request, refusal);

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Get tracing session detail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch session detail',
        });
    }
  }));

  app.get('/tracing/sessions/:sessionId/events/:eventId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { eventId, sessionId } = request.params as { eventId: string; sessionId: string };
      const refusal = await refuseTracingThread(request, await AgentTracingService.getSessionThreadId(session.tenantDbName, projectId, sessionId), { actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId } });
      if (refusal) return sendSessionRefusal(reply, request, refusal);
      const result = await AgentTracingService.getSessionEventDetail(
        session.tenantDbName,
        projectId,
        sessionId,
        eventId,
      );

      if (!result) {
        return reply.code(404).send({ error: 'Event not found' });
      }

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Get tracing session event detail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch event detail',
        });
    }
  }));

  app.get('/tracing/threads', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const metadataFilter = parseMetadataFilter(query);
      if ('error' in metadataFilter) {
        return reply.code(400).send({ error: metadataFilter.error });
      }
      const { skip, limit } = offsetPageOf(query);
      let latest: Awaited<ReturnType<typeof AgentTracingService.listThreads>> | undefined;
      const page = await pageOfVisibleRows(request, {
        start: skip,
        limit,
        minBatch: 25,
        threadIdOf: (row: { threadId?: unknown }) => (typeof row.threadId === 'string' ? row.threadId : null),
        actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
        fetchPage: async (position, size) => {
          latest = await AgentTracingService.listThreads(session.tenantDbName, projectId, {
            agent: query.agent,
            from: query.from,
            limit: String(size),
            skip: String(position),
            status: query.status,
            threadId: query.threadId,
            to: query.to,
            ...metadataFilter,
          });
          const total = latest.total;
          return { rows: latest.threads, after: (consumed) => (position + consumed >= total ? null : position + consumed) };
        },
      });
      if (!page.restricted && latest) return reply.code(200).send(latest);
      return reply.code(200).send({ threads: page.rows, hasMore: page.next !== null, nextSkip: page.next });
    } catch (error) {
      logger.error('List tracing threads error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch threads',
        });
    }
  }));

  app.get('/tracing/threads/:threadId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { threadId } = request.params as { threadId: string };
      const refusal = await refuseTracingThread(request, threadId, { actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId } });
      if (refusal) return sendSessionRefusal(reply, request, refusal);
      const result = await AgentTracingService.getThreadDetail(
        session.tenantDbName,
        projectId,
        threadId,
      );

      if (!result) {
        return reply.code(404).send({ error: 'Thread not found' });
      }

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Get tracing thread detail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch thread',
        });
    }
  }));

  // The agent session a thread belongs to (the thread id is the conversation's id), so the
  // request inspector can draw a recorded `session-file://` picture from the session's content
  // route. It only names the session; opening a file is checked again by that route.
  app.get('/tracing/threads/:threadId/session', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { threadId } = request.params as { threadId: string };
      const ref = await resolveTraceSession({ tenantDbName: session.tenantDbName, projectId, threadId });
      if (!ref) {
        return reply.code(404).send({ error: 'This thread is not an agent session' });
      }
      return reply.code(200).send(ref);
    } catch (error) {
      logger.error('Get tracing thread session error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to resolve the thread session',
        });
    }
  }));

  const agentOverviewHandler = withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { agentName } = request.params as { agentName: string };
      const searchParams = new URLSearchParams(request.query as Record<string, string>);
      const filter = parseDashboardDateFilterFromSearchParams(searchParams);
      const result = await AgentTracingService.getAgentOverview(
        session.tenantDbName,
        projectId,
        agentName,
        {
          from: searchParams.get('from') || filter.from?.toISOString(),
          timezone: searchParams.get('timezone') || undefined,
          to: searchParams.get('to') || filter.to?.toISOString(),
        },
      );

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Get tracing agent overview error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch agent overview',
        });
    }
  });

  app.get('/tracing/agents/:agentName/overview', agentOverviewHandler);
  app.post('/tracing/agents/:agentName/overview', agentOverviewHandler);

  // Lightweight agent directory (sub-nav / pickers) — last 30 days by default.
  app.get('/tracing/agents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const from = query.from
        || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const limit = Number.parseInt(query.limit || '50', 10);
      const result = await AgentTracingService.listRecentAgents(
        session.tenantDbName,
        projectId,
        {
          from,
          limit: Number.isFinite(limit) ? limit : 50,
          to: query.to,
        },
      );

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('List tracing agents error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch agents',
        });
    }
  }));

  // Agent health scoreboard: rollup totals, previous period, sparkline and alert state per agent.
  app.get('/tracing/agents/health', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const range = resolveHealthRange(query);
      if ('error' in range) return reply.code(400).send({ error: range.error });
      const limit = parseHealthLimit(query.limit);
      const scope = { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId };
      // Rule names, incident ids and incident links are for callers who may read alerts; the others keep phase and severity.
      const alertDetails = (await authorizeServiceForRequest(request, 'alerts', { level: 'read' })).allowed;

      const summaryInput = {
        ...scope,
        entityType: 'agent' as const,
        fromMs: range.fromMs,
        toMs: range.toMs,
        sparkPoints: HEALTH_SPARK_POINTS,
      };
      const [rolledUp, alertInfo] = await Promise.all([
        getEntitySummaries(summaryInput),
        loadAgentAlertStates(scope).catch((error) => {
          logger.warn('Agent alert states unavailable for health view', { error });
          return null;
        }),
      ]);
      const summaries = [...rolledUp];

      // An agent that went silent for longer than the range has no rollup rows but may carry a firing
      // absence alert: it still belongs on the scoreboard (zero totals).
      if (alertInfo) {
        const present = new Set(summaries.map((summary) => summary.entityKey));
        const missing = [...alertInfo.states.keys()].filter((key) => !present.has(key)).slice(0, HEALTH_MISSING_KEYS_LIMIT);
        if (missing.length > 0) {
          try {
            summaries.push(...await getEntitySummaries({ ...summaryInput, keys: missing }));
            summaries.sort((a, b) => b.totals.requests - a.totals.requests || a.entityKey.localeCompare(b.entityKey));
          } catch (error) {
            logger.warn('Silent agents with active alerts unavailable for health view', { error });
          }
        }
      }

      const page = summaries.slice(0, limit);
      if (alertInfo) {
        await loadFiringIncidents(scope, alertInfo.states, page.map((summary) => summary.entityKey), alertInfo);
      }
      const agents = page.map((summary) => ({
        name: summary.entityKey,
        totals: summary.totals,
        previous: summary.previous,
        spark: summary.spark,
        alert: {
          ...(alertInfo
            ? summarizeAgentAlert(alertInfo.states.get(summary.entityKey), alertInfo, alertDetails)
            : { phase: null }),
          // Whether any enabled rule watches this agent: `phase: null` alone cannot tell "healthy" from "unmonitored".
          covered: alertInfo ? isCovered(alertInfo.coverage, summary.entityKey) : false,
        },
      }));

      const bucketMs = sparkBucketMs(range, HEALTH_SPARK_POINTS);
      return reply.code(200).send({
        // Spark point i starts at `sparkFromMs + i * bucketMs` (the first bucket is floored to a bucket boundary, so it can start before `fromMs`).
        range: { ...range, bucketMs, sparkFromMs: Math.floor(range.fromMs / bucketMs) * bucketMs },
        // False when the alert rules or states could not be read: every `alert` below is then unknown, not OK.
        alertsAvailable: alertInfo !== null,
        agents,
        total: summaries.length,
      });
    } catch (error) {
      logger.error('Get tracing agents health error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch agents health',
        });
    }
  }));

  // Health of one agent: bucketed series, baseline band, version/incident markers and alert counts.
  app.get('/tracing/agents/:agentName/health', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { agentName } = request.params as { agentName: string };
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const range = resolveHealthRange(query);
      if ('error' in range) return reply.code(400).send({ error: range.error });
      const scope = { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId };
      const alertDetails = (await authorizeServiceForRequest(request, 'alerts', { level: 'read' })).allowed;

      const series = await getEntitySeries({
        ...scope,
        entityType: 'agent',
        entityKey: agentName,
        fromMs: range.fromMs,
        toMs: range.toMs,
      });
      const seriesRange = series.range;

      // Context around the series is best effort: a failure here must not blank the charts.
      const [baseline, versionMarkers, incidentMarkers, alertInfo] = await Promise.all([
        loadBaselineBand(scope, agentName, seriesRange),
        loadVersionMarkers(scope, agentName, seriesRange).catch((error) => {
          logger.warn('Agent version markers unavailable', { error });
          return { markers: [] as HealthMarker[], partial: false };
        }),
        alertDetails
          ? loadIncidentMarkers(scope, agentName, seriesRange).catch((error) => {
            logger.warn('Agent incident markers unavailable', { error });
            return [] as HealthMarker[];
          })
          : Promise.resolve([] as HealthMarker[]),
        loadAgentAlertStates(scope).catch((error) => {
          logger.warn('Agent alert states unavailable for health view', { error });
          return null;
        }),
      ]);

      const agentStates = alertInfo?.states.get(agentName) ?? [];
      const markers = [...versionMarkers.markers, ...incidentMarkers].sort((a, b) => a.t - b.t);

      return reply.code(200).send({
        range: seriesRange,
        buckets: series.buckets,
        totals: series.totals,
        previous: series.previous,
        baseline,
        markers,
        // True when the session read behind the version markers hit its bound: earlier versions may be missing.
        markersPartial: versionMarkers.partial,
        // False when the alert rules or states could not be read: the counts below are then unknown, not zero.
        alertsAvailable: alertInfo !== null,
        alerts: {
          firing: agentStates.filter((state) => state.phase === 'firing').length,
          pending: agentStates.filter((state) => state.phase === 'pending').length,
          // Whether any enabled rule watches this agent.
          covered: alertInfo ? isCovered(alertInfo.coverage, agentName) : false,
        },
      });
    } catch (error) {
      logger.error('Get tracing agent health error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch agent health',
        });
    }
  }));

  const modelOverviewHandler = withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { modelName } = request.params as { modelName: string };
      const searchParams = new URLSearchParams(request.query as Record<string, string>);
      const filter = parseDashboardDateFilterFromSearchParams(searchParams);
      const result = await AgentTracingService.getModelOverview(
        session.tenantDbName,
        projectId,
        modelName,
        {
          from: searchParams.get('from') || filter.from?.toISOString(),
          timezone: searchParams.get('timezone') || undefined,
          to: searchParams.get('to') || filter.to?.toISOString(),
        },
      );

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Get tracing model overview error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch model overview',
        });
    }
  });

  app.get('/tracing/models/:modelName/overview', modelOverviewHandler);
  app.post('/tracing/models/:modelName/overview', modelOverviewHandler);
};
