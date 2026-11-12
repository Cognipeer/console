import type { FastifyInstance } from 'fastify';
import {
  resolveSandboxAvailability,
} from '@/lib/services/agents/agentSandboxTools';
import type {
  IAgentConfig,
  IAgentRun,
} from '@/lib/database';
import {
  consoleIdentityIssuerInfo,
} from '@/lib/iam/consoleIdentity';
import {
  getConversationById,
} from '@/lib/services/agents';
// By path: the agents barrel does not export the error class.
import {
  checkAgentModel,
} from '@/lib/services/agents/agentService';
import {
  validateAgentConfig,
} from '@/lib/services/agents/agentConfigValidation';
import {
  AGENT_RUN_TRIGGERS,
  getAgentRunStatus,
  listAgentRuns,
  requestAgentRunCancellation,
  resolveAgentRunLimits,
  serializeAgentRun,
  withoutAgentRunContent,
} from '@/lib/services/agents/agentRunService';
import type {
  LicenseType,
} from '@/lib/license/license-manager';
import {
  authorizeEndingOpenRequests,
} from '../agent-approval-authz';
import {
  decideSessionAccess,
  loadSessionForPrincipal,
  sendAuthorizationUnavailable,
  sendSessionRefusal,
  sessionListScope,
  runsWithHiddenContent,
} from '../agent-session-access';
import {
  resolveSessionOwners,
} from '@/lib/services/agents/sessionOwners';
import {
  cancelReminder,
  fireReminderNow,
  listReminders,
  reminderPlatformLimits,
  serializeReminder,
} from '@/lib/services/agents/agentReminders';
import {
  readJsonBody,
  requireProjectContextForRequest,
  withApiRequestContext,
} from '../../fastify-utils';
import {
  requestHasSandboxRead,
  requestHasSandboxWrite,
} from '../sandbox-permission';
import {
  requireScopedAgent,
  logger,
  AGENT_SCOPED,
  sendRouteError,
  RUN_CHANNEL_VALUES,
  sessionTitles,
} from './agentsRouteHelpers';

export function registerAgentsMetaRoutes(app: FastifyInstance): void {
  /**
   * What the Sandbox section of an agent can offer: whether this deployment
   * has the sandbox module, whether the tenant's license unlocks it, the
   * templates to pick from, and the project's persistent sandboxes an agent
   * can be given (`instances`, listed only to a caller with Sandbox read;
   * `canAttach` says whether the caller may choose one). Always 200 —
   * `available: false` with a `reason` is an answer the UI renders, not a
   * failure.
   */
  app.get('/agents/sandbox/capabilities', withApiRequestContext(async (request, reply) => {
    try {
      const { session, projectId } = await requireProjectContextForRequest(request);
      const availability = await resolveSandboxAvailability(session.tenantId);
      if (!availability.available) {
        return reply.code(200).send({ available: false, reason: availability.reason, templates: [], instances: [], canAttach: false });
      }
      const { runner } = availability;
      const templates = await runner.listTemplates(session.tenantDbName, session.tenantId)
        .catch((error: unknown) => {
          logger.warn('Could not list sandbox templates', { error });
          return [];
        });
      const attachSupported = Boolean(runner.listInstances && runner.describeInstance);
      const instances = attachSupported && await requestHasSandboxRead(request, projectId)
        ? await runner.listInstances!(session.tenantDbName, session.tenantId, projectId, { persist: true })
          .catch((error: unknown) => {
            logger.warn('Could not list persistent sandboxes', { error });
            return [];
          })
        : [];
      const canAttach = attachSupported && await requestHasSandboxWrite(request, projectId);
      return reply.code(200).send({
        available: true,
        templates,
        instances: instances.map(({ id, name, state, templateKey }) => ({ id, name, state, ...(templateKey ? { templateKey } : {}) })),
        canAttach,
      });
    } catch (error) {
      return sendRouteError(reply, error, 'Agent sandbox capabilities error', 'Failed to read sandbox capabilities');
    }
  }));

  // What a connected agent set up for Console identity verifies its tokens
  // against (shown on the connect and settings screens).
  app.get('/agents/console-identity', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      return reply.code(200).send(consoleIdentityIssuerInfo(session.tenantId));
    } catch (error) {
      return sendRouteError(reply, error, 'Agent Console identity error', 'Failed to read Console identity details');
    }
  }));

  // Effective run limits for this tenant/project (env ∧ quota). Agents have no
  // say in them any more; the Studio shows them for reference.
  app.get('/agents/execution/limits', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const limits = await resolveAgentRunLimits({
        quotaContext: {
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId,
          licenseType: session.licenseType as LicenseType,
          userId: session.userId,
        },
      });
      return reply.code(200).send({
        syncWaitSeconds: Math.floor(limits.syncWaitMs / 1000),
        maxDurationMinutes: Math.floor(limits.maxDurationMs / 60_000),
        maxActivePerTenant: limits.maxActivePerTenant,
        maxActivePerProject: limits.maxActivePerProject,
      });
    } catch (error) {
      return sendRouteError(reply, error, 'Agent execution limits error', 'Failed to read execution limits');
    }
  }));

  // Background runs of one agent, newest first (Sessions → Background runs).
  app.get('/agents/:agentId/runs', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const query = (request.query ?? {}) as { status?: string; limit?: string; conversationId?: string; triggerId?: string; trigger?: string; channel?: string };
      const trigger = AGENT_RUN_TRIGGERS.find((value) => value === query.trigger);
      const channels = (query.channel ?? '').split(',').filter((value): value is NonNullable<IAgentRun['channel']> => (RUN_CHANNEL_VALUES as readonly string[]).includes(value));
      const allowed = new Set(['scheduled', 'queued', 'running', 'requires_action', 'succeeded', 'failed', 'canceled']);
      const status = (query.status ?? '').split(',').filter((value) => allowed.has(value)) as Array<'scheduled' | 'queued' | 'running' | 'requires_action' | 'succeeded' | 'failed' | 'canceled'>;
      // A run carries the answer of somebody's session: the caller who may not view other people's sessions of
      // this agent sees only the runs they queued, and a run of one session is the session's to read.
      const scope = await sessionListScope(request, { agent, projectId, actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId } });
      if (query.conversationId) {
        const loaded = await loadSessionForPrincipal(request, query.conversationId, {
          need: 'view',
          agentKey: agent.key,
          agent,
          projectId,
          actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
        });
        if (!loaded.ok) return sendSessionRefusal(reply, request, loaded);
      }
      const runs = await listAgentRuns(session.tenantDbName, {
        tenantId: session.tenantId,
        projectId,
        agentKey: agent.key,
        // Every run (queued or inline); a dashboard reservation is not one.
        excludeModes: ['sync'],
        ...(status.length > 0 ? { status } : {}),
        ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        // A trigger's history (Studio's Triggers list links here).
        ...(query.triggerId ? { triggerId: query.triggerId } : {}),
        ...(trigger ? { trigger } : {}),
        ...(channels.length === 1 ? { channel: channels[0] } : {}),
        ...(scope.ownOnly ? { userId: scope.userId } : {}),
        limit: Math.min(Number(query.limit) || 100, 500),
      });
      const shown = channels.length > 1 ? runs.filter((run) => run.channel && channels.includes(run.channel)) : runs;
      const hidden = await runsWithHiddenContent(request, { tenantDbName: session.tenantDbName, userId: session.userId }, shown);
      return reply.code(200).send({
        runs: shown.map((run) => (hidden.has(String(run._id)) ? withoutAgentRunContent(serializeAgentRun(run)) : serializeAgentRun(run))),
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent runs error', 'Failed to list runs');
    }
  }));

  app.post('/agents/:agentId/runs/:runId/cancel', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const { runId } = request.params as { runId: string };
      // Ownership first: the run must belong to THIS agent, not merely to the project.
      const existing = await getAgentRunStatus(session.tenantDbName, session.tenantId, projectId, runId);
      if (!existing || existing.agentKey !== agent.key || existing.mode === 'sync') {
        return reply.code(404).send({ error: 'Run not found' });
      }
      // Cancelling a run is acting on its session: the session's owner always may, anybody else needs
      // `agent.session_manage_others`.
      const conversation = await getConversationById(session.tenantDbName, existing.conversationId);
      if (conversation && conversation.projectId === projectId) {
        const access = await decideSessionAccess(request, conversation, {
          need: 'manage',
          agent,
          actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
          alsoOwnedBy: [existing.userId],
        });
        if (!access.ok) return sendSessionRefusal(reply, request, access);
      }
      // A run paused on an approval is ended by cancelling it, which answers the open request with "no".
      if (existing.status === 'requires_action') {
        if (conversation && conversation.projectId === projectId) {
          const verdict = await authorizeEndingOpenRequests(request, { tenantDbName: session.tenantDbName, conversation, agent });
          if (!verdict.allowed && verdict.unavailable) {
            return sendAuthorizationUnavailable(reply, request, 'dashboard', { action: 'agent.approve', level: 'write', decisionId: verdict.decisionId });
          }
          if (!verdict.allowed) {
            return reply.code(403).send({
              error: 'This run is waiting for an approval or an answer. You are not allowed to answer it, so you cannot cancel it.',
              code: 'forbidden',
              ...(verdict.decisionId ? { decisionId: verdict.decisionId } : {}),
            });
          }
        }
      }
      if (existing.channel === 'reminder' && existing.status === 'scheduled') {
        const canceled = await cancelReminder(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
          runId,
          { agentKey: agent.key, actor: { userId: session.userId, via: 'dashboard' } },
        );
        if (canceled.kind === 'canceled') return reply.code(200).send({ run: serializeAgentRun(canceled.run) });
      }
      const outcome = await requestAgentRunCancellation(session.tenantDbName, session.tenantId, projectId, runId);
      if (outcome.kind === 'not_found') return reply.code(404).send({ error: 'Run not found' });
      if (outcome.kind === 'already_terminal') {
        return reply.code(409).send({ error: `Run is already ${outcome.run.status}` });
      }
      return reply.code(200).send({ run: serializeAgentRun(outcome.run) });
    } catch (error) {
      return sendRouteError(reply, error, 'Cancel agent run error', 'Failed to cancel run');
    }
  }));

  // A reminder that has not fired yet, started now (Sessions → Reminders "Fire now").
  app.post('/agents/:agentId/runs/:runId/fire', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const { runId } = request.params as { runId: string };
      const existing = await getAgentRunStatus(session.tenantDbName, session.tenantId, projectId, runId);
      if (!existing || existing.agentKey !== agent.key || existing.channel !== 'reminder') {
        return reply.code(404).send({ error: 'Reminder not found' });
      }
      // Firing a reminder runs a turn in its session: the session's owner always may, anybody else needs
      // `agent.session_manage_others`.
      const conversation = await getConversationById(session.tenantDbName, existing.conversationId);
      if (!conversation || conversation.projectId !== projectId) return reply.code(404).send({ error: 'Reminder not found' });
      const access = await decideSessionAccess(request, conversation, {
        need: 'manage',
        agent,
        actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
        alsoOwnedBy: [existing.userId],
      });
      if (!access.ok) return sendSessionRefusal(reply, request, access);
      const outcome = await fireReminderNow(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        runId,
        { agentKey: agent.key, actor: { userId: session.userId, via: 'dashboard' } },
      );
      if (outcome.kind === 'not_found') return reply.code(404).send({ error: 'Reminder not found' });
      if (outcome.kind === 'not_scheduled') return reply.code(409).send({ error: `The reminder is already ${outcome.run.status}` });
      if (outcome.kind === 'busy') return reply.code(409).send({ error: outcome.message });
      return reply.code(200).send({ run: serializeAgentRun(outcome.run), reminder: serializeReminder(outcome.run) });
    } catch (error) {
      return sendRouteError(reply, error, 'Fire agent reminder error', 'Failed to fire the reminder');
    }
  }));

  // The reminders the agent set itself, newest first (Sessions → Reminders; a session's own with `sessionId`).
  app.get('/agents/:agentId/reminders', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const query = (request.query ?? {}) as { status?: string; limit?: string; sessionId?: string };
      const actor = { tenantDbName: session.tenantDbName, projectId, userId: session.userId };
      const reminderScope = { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId };
      const scope = await sessionListScope(request, { agent, projectId, actor });
      if (query.sessionId) {
        const loaded = await loadSessionForPrincipal(request, query.sessionId, { need: 'view', agentKey: agent.key, agent, projectId, actor });
        if (!loaded.ok) return sendSessionRefusal(reply, request, loaded);
      }
      // Somebody who may not view other people's sessions sees the reminders of their own (one session they may view: all of it).
      const ownOnly = !query.sessionId && scope.ownOnly ? { userId: scope.userId } : {};
      const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
      const [runs, active] = await Promise.all([
        listReminders(reminderScope, {
          agentKey: agent.key,
          ...(query.sessionId ? { conversationId: query.sessionId } : {}),
          active: query.status !== 'all',
          ...ownOnly,
          limit,
        }),
        listReminders(reminderScope, { agentKey: agent.key, ...(query.sessionId ? { conversationId: query.sessionId } : {}), active: true, ...ownOnly, limit: 500 }),
      ]);
      const owners = await resolveSessionOwners(runs.map((run) => run.userId));
      const titles = await sessionTitles(session.tenantDbName, projectId, runs.map((run) => run.conversationId));
      // A reminder of a session that drew on knowledge base documents the viewer may not read: when and whose, not what.
      const hidden = await runsWithHiddenContent(request, actor, runs);
      return reply.code(200).send({
        reminders: runs.map((run) => {
          const owner = run.userId ? owners.get(run.userId) : undefined;
          const reminder = serializeReminder(run);
          if (hidden.has(String(run._id))) {
            return {
              ...reminder,
              message: null,
              reason: null,
              error: reminder.error ? { type: reminder.error.type, message: null } : null,
              restricted: true,
              ...(owner ? { owner } : {}),
            };
          }
          const title = titles.get(run.conversationId);
          return { ...reminder, ...(owner ? { owner } : {}), ...(title ? { session_title: title } : {}) };
        }),
        summary: { active: active.length },
        scope: { viewOthers: !scope.ownOnly },
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent reminders error', 'Failed to list reminders');
    }
  }));

  // The platform ceilings of agent reminders (env), for the Configure hints.
  app.get('/agents/reminder-limits', withApiRequestContext(async (request, reply) => {
    try {
      await requireProjectContextForRequest(request);
      return reply.code(200).send({ limits: reminderPlatformLimits() });
    } catch (error) {
      return sendRouteError(reply, error, 'Agent reminder limits error', 'Failed to read reminder limits');
    }
  }));

  /**
   * Sends one tiny completion to a model through the agent runtime's own path,
   * so a wrong provider key is caught on the Configure page instead of in the
   * agent's first session. Always 200: the check's own verdict is the body.
   */
  app.post('/agents/model-check', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.modelKey !== 'string' || !body.modelKey) {
        return reply.code(400).send({ error: 'modelKey is required' });
      }
      const result = await checkAgentModel(session.tenantDbName, session.tenantId, projectId, body.modelKey);
      return reply.code(200).send(result);
    } catch (error) {
      return sendRouteError(reply, error, 'Agent model check error', 'Failed to check the model');
    }
  }));

  /**
   * Validates a config without saving it — the stored draft, or the `config`
   * in the body (what the editor currently holds). The Configure page calls
   * this to mark broken fields before Save.
   */
  app.post('/agents/:agentId/validate', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const body = readJsonBody<Record<string, unknown>>(request);
      const config = body.config && typeof body.config === 'object'
        ? body.config as IAgentConfig
        : agent.config;
      const validation = await validateAgentConfig({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        config,
        agentKey: agent.key,
      });
      return reply.code(200).send({ valid: validation.errors.length === 0, ...validation });
    } catch (error) {
      return sendRouteError(reply, error, 'Validate agent config error', 'Failed to validate agent config');
    }
  }));
}
