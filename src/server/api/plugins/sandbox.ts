/**
 * Sandbox admin API (cookie-authenticated, RBAC service: 'sandbox').
 *
 * Manages runners, templates, volumes, instances, terminal sessions and
 * settings for the Agent Runtime Sandbox subsystem. Routes are written without
 * the '/api' prefix (added by the parent). Independent of gpu-fleet.
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getSessionContext, safeReadJsonBody } from '../fastify-utils';
import { registerSandboxToolboxRoutes } from './client-sandbox-toolbox';
import {
  createRunner,
  deleteRunner,
  getRunner,
  listRunners,
  rotateRunnerToken,
} from '@/lib/services/sandbox/runnerService';
import {
  listManagedRunnerIds,
  startLocalRunner,
  stopLocalRunner,
} from '@/lib/services/sandbox/localRunnerManager';
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
} from '@/lib/services/sandbox/templateService';
import { seedDefaultTemplates } from '@/lib/services/sandbox/templateLibrary';
import { codeRunInSandbox, execInSandbox } from '@/lib/services/sandbox/execService';
import { createVolume, deleteVolume, listVolumes } from '@/lib/services/sandbox/volumeService';
import {
  createInstance,
  deleteInstance,
  getInstance,
  listInstances,
  openTerminal,
  startInstance,
  stopInstance,
} from '@/lib/services/sandbox/instanceService';
import {
  ensureSandboxSettings,
  getSandboxSettings,
  updateSandboxSettings,
} from '@/lib/services/sandbox/settingsService';

const log = createLogger('api:sandbox-admin');

export const sandboxApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Runners ──────────────────────────────────────────────────────────
  app.get('/sandbox/runners', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const runners = await listRunners(ctx.tenantDbName);
    const managed = new Set(listManagedRunnerIds());
    const STALE_MS = 90_000;
    const isFresh = (lastSeenAt: Date | null) =>
      Boolean(lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < STALE_MS);
    return reply.code(200).send({
      runners: runners.map((r) => {
        const managedRunning = managed.has(r.id);
        // A stale 'online' record (no recent heartbeat, not console-managed) is
        // effectively offline — keeps the UI honest after restarts/crashes.
        const status = r.status === 'online' && !managedRunning && !isFresh(r.lastSeenAt) ? 'offline' : r.status;
        return { ...r, status, managedRunning };
      }),
    });
  });

  app.post('/sandbox/runners', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const body = safeReadJsonBody(request) as { name?: string };
    if (!body.name) return reply.code(400).send({ error: 'name-required' });
    const result = await createRunner({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      name: body.name,
      createdBy: ctx.userId,
    });
    return reply.code(201).send({
      runner: result.runner,
      registrationToken: result.registrationToken,
      expiresAt: result.expiresAt.toISOString(),
      tenantSlug: ctx.tenantSlug,
    });
  });

  app.get<{ Params: { id: string } }>('/sandbox/runners/:id', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const runner = await getRunner(ctx.tenantDbName, request.params.id);
    if (!runner) return reply.code(404).send({ error: 'Not found' });
    return reply.code(200).send({ runner });
  });

  app.post<{ Params: { id: string } }>('/sandbox/runners/:id/rotate-token', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const result = await rotateRunnerToken(ctx.tenantDbName, request.params.id);
    if (!result) return reply.code(404).send({ error: 'Not found' });
    return reply.code(200).send({
      registrationToken: result.registrationToken,
      expiresAt: result.expiresAt.toISOString(),
      tenantSlug: ctx.tenantSlug,
    });
  });

  // Start / stop a console-managed local runner agent (self-hosted convenience).
  app.post<{ Params: { id: string } }>('/sandbox/runners/:id/start', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const proto = (request.headers['x-forwarded-proto'] as string) || 'http';
    const host = request.headers.host ?? 'localhost:3000';
    try {
      await startLocalRunner({
        tenantDbName: ctx.tenantDbName,
        tenantSlug: ctx.tenantSlug,
        runnerId: request.params.id,
        consoleUrl: `${proto}://${host}`,
      });
      return reply.code(200).send({ ok: true, running: true });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'start-failed' });
    }
  });

  app.post<{ Params: { id: string } }>('/sandbox/runners/:id/stop', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    await stopLocalRunner(ctx.tenantDbName, request.params.id);
    return reply.code(200).send({ ok: true, running: false });
  });

  app.delete<{ Params: { id: string } }>('/sandbox/runners/:id', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const ok = await deleteRunner(ctx.tenantDbName, request.params.id);
    return reply.code(ok ? 200 : 404).send({ ok });
  });

  // ── Templates ────────────────────────────────────────────────────────
  app.get('/sandbox/templates', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    return reply.code(200).send({ templates: await listTemplates(ctx.tenantDbName) });
  });

  app.post('/sandbox/templates', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const body = safeReadJsonBody(request) as Record<string, unknown>;
    if (!body.key || !body.name || !body.baseImage) {
      return reply.code(400).send({ error: 'key, name, baseImage required' });
    }
    const template = await createTemplate(
      ctx.tenantDbName,
      ctx.tenantId,
      {
        key: String(body.key),
        name: String(body.name),
        description: (body.description as string) ?? null,
        baseImage: String(body.baseImage),
        runtime: String(body.runtime ?? 'multi'),
        isolation: String(body.isolation ?? 'runc'),
        resources: (body.resources as Record<string, unknown>) ?? {},
        env: (body.env as Record<string, string>) ?? {},
        entrypoint: (body.entrypoint as string[]) ?? null,
        toolboxPort: Number(body.toolboxPort ?? 8787),
        previewPorts: (body.previewPorts as Array<Record<string, unknown>>) ?? [],
        volumeMounts: (body.volumeMounts as Array<Record<string, unknown>>) ?? [],
        projectId: null,
      },
      ctx.userId,
    );
    return reply.code(201).send({ template });
  });

  app.post('/sandbox/templates/seed', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const created = await seedDefaultTemplates(ctx.tenantDbName, ctx.tenantId, ctx.userId);
    return reply.code(200).send({ created });
  });

  app.delete<{ Params: { id: string } }>('/sandbox/templates/:id', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const ok = await deleteTemplate(ctx.tenantDbName, request.params.id);
    return reply.code(ok ? 200 : 404).send({ ok });
  });

  // ── Volumes ──────────────────────────────────────────────────────────
  app.get('/sandbox/volumes', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    return reply.code(200).send({ volumes: await listVolumes(ctx.tenantDbName) });
  });

  app.post('/sandbox/volumes', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const body = safeReadJsonBody(request) as Record<string, unknown>;
    if (!body.name || !body.container || !body.prefix) {
      return reply.code(400).send({ error: 'name, container, prefix required' });
    }
    const volume = await createVolume(
      ctx.tenantDbName,
      ctx.tenantId,
      {
        name: String(body.name),
        provider: (body.provider as 'azure-blob' | 's3' | 'local') ?? 'local',
        container: String(body.container),
        prefix: String(body.prefix),
        projectId: null,
      },
      ctx.userId,
    );
    return reply.code(201).send({ volume });
  });

  app.delete<{ Params: { id: string } }>('/sandbox/volumes/:id', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const ok = await deleteVolume(ctx.tenantDbName, request.params.id);
    return reply.code(ok ? 200 : 404).send({ ok });
  });

  // ── Instances ────────────────────────────────────────────────────────
  app.get('/sandbox/instances', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    return reply.code(200).send({ instances: await listInstances(ctx.tenantDbName) });
  });

  app.post('/sandbox/instances', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const body = safeReadJsonBody(request) as Record<string, unknown>;
    if (!body.templateId || !body.name) {
      return reply.code(400).send({ error: 'templateId, name required' });
    }
    try {
      const instance = await createInstance(
        ctx.tenantDbName,
        ctx.tenantId,
        {
          templateId: String(body.templateId),
          name: String(body.name),
          runnerId: (body.runnerId as string) ?? null,
          volumeId: (body.volumeId as string) ?? null,
          env: (body.env as Record<string, string>) ?? {},
          projectId: null,
        },
        ctx.userId,
      );
      return reply.code(201).send({ instance });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'create-failed' });
    }
  });

  app.get<{ Params: { id: string } }>('/sandbox/instances/:id', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const instance = await getInstance(ctx.tenantDbName, request.params.id);
    if (!instance) return reply.code(404).send({ error: 'Not found' });
    return reply.code(200).send({ instance });
  });

  app.post<{ Params: { id: string } }>('/sandbox/instances/:id/start', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const instance = await startInstance(ctx.tenantDbName, ctx.tenantId, request.params.id, ctx.userId);
    if (!instance) return reply.code(404).send({ error: 'Not found' });
    return reply.code(200).send({ instance });
  });

  app.post<{ Params: { id: string } }>('/sandbox/instances/:id/stop', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const instance = await stopInstance(ctx.tenantDbName, ctx.tenantId, request.params.id, ctx.userId);
    if (!instance) return reply.code(404).send({ error: 'Not found' });
    return reply.code(200).send({ instance });
  });

  app.delete<{ Params: { id: string } }>('/sandbox/instances/:id', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const instance = await deleteInstance(ctx.tenantDbName, ctx.tenantId, request.params.id, ctx.userId);
    if (!instance) return reply.code(404).send({ error: 'Not found' });
    return reply.code(200).send({ instance });
  });

  app.post<{ Params: { id: string } }>('/sandbox/instances/:id/terminal', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const body = safeReadJsonBody(request) as { cwd?: string; cols?: number; rows?: number; shell?: string };
    const result = await openTerminal({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      instanceId: request.params.id,
      openedBy: ctx.userId,
      input: body,
    });
    if (!result) return reply.code(404).send({ error: 'Not found' });
    return reply.code(200).send(result);
  });

  // ── Playground exec / code (cookie-auth) ─────────────────────────────
  app.post<{ Params: { id: string } }>('/sandbox/instances/:id/exec', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const body = safeReadJsonBody(request) as { command?: string; cwd?: string; timeoutSec?: number };
    if (!body.command) return reply.code(400).send({ error: 'command required' });
    const result = await execInSandbox({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      instanceId: request.params.id,
      command: body.command,
      cwd: body.cwd,
      timeoutSec: body.timeoutSec,
      by: ctx.userId,
    });
    if (!result) return reply.code(404).send({ error: 'Not found or not ready' });
    return reply.code(200).send(result);
  });

  app.post<{ Params: { id: string } }>('/sandbox/instances/:id/code', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const body = safeReadJsonBody(request) as {
      code?: string;
      language?: 'python' | 'javascript' | 'typescript' | 'bash';
      timeoutSec?: number;
    };
    if (!body.code) return reply.code(400).send({ error: 'code required' });
    const result = await codeRunInSandbox({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      instanceId: request.params.id,
      code: body.code,
      language: body.language,
      timeoutSec: body.timeoutSec,
      by: ctx.userId,
    });
    if (!result) return reply.code(404).send({ error: 'Not found or not ready' });
    return reply.code(200).send(result);
  });

  // ── Settings ─────────────────────────────────────────────────────────
  app.get('/sandbox/settings', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const settings =
      (await getSandboxSettings(ctx.tenantDbName)) ??
      (await ensureSandboxSettings(ctx.tenantDbName, ctx.tenantId));
    return reply.code(200).send({ settings });
  });

  app.put('/sandbox/settings', async (request, reply) => {
    const ctx = getSessionContext(request);
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    const body = safeReadJsonBody(request) as Record<string, unknown>;
    const settings = await updateSandboxSettings(ctx.tenantDbName, ctx.tenantId, {
      terminalSessionTtlSeconds: body.terminalSessionTtlSeconds as number | undefined,
      defaultStorageProvider: body.defaultStorageProvider as string | undefined,
      defaultIsolation: body.defaultIsolation as string | undefined,
      idleReapSeconds: body.idleReapSeconds as number | undefined,
    });
    return reply.code(200).send({ settings });
  });

  // Toolbox (fs/git/sessions) under the cookie-authed admin API, so the
  // dashboard Playground can exercise the same operations as the client API.
  registerSandboxToolboxRoutes(app, {
    prefix: '/sandbox/instances/:id',
    wrap: (handler) => async (request, reply) => {
      const ctx = getSessionContext(request);
      if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
      return handler(request, reply);
    },
    resolveCtx: async (request) => {
      const ctx = getSessionContext(request);
      if (!ctx) throw new Error('Unauthorized');
      const { id } = request.params as { id: string };
      return { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, instanceId: id, by: ctx.userId };
    },
  });

  log.info('sandbox admin API registered');
};
