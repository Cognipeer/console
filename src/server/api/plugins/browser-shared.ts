/**
 * Route bodies shared by the dashboard (`/api/browser/*`) and client
 * (`/api/client/v1/browser/*`) browser APIs.
 *
 * The two surfaces differ only in how they authenticate: the dashboard reads
 * a session cookie, the client API a bearer token. Everything after that —
 * validation, service calls, status codes, error shape — must be identical,
 * because "can I do this over the API?" should never depend on which door the
 * caller came through. Writing them twice is how they drift, so the bodies
 * live here and each plugin supplies only its context resolver.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  clearBrowserStorageState,
  createBrowserFlow,
  deleteBrowserFlow,
  exportSessionStorageState,
  getBrowserFlow,
  getBrowserFlowRun,
  listBrowserFlowRuns,
  listBrowserFlows,
  readSessionObservations,
  recordBrowserFlow,
  runBrowserFlow,
  searchPageText,
  setBrowserStorageState,
  updateBrowserFlow,
} from '@/lib/services/browser';
import {
  createBrowserFlowInputSchema,
  recordBrowserFlowInputSchema,
  runBrowserFlowInputSchema,
  updateBrowserFlowInputSchema,
} from '@/lib/services/browser/validation';
import { readJsonBody } from '../fastify-utils';

/** Tenant/project scope plus the actor name stamped onto created records. */
export interface BrowserRouteContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  actor: string;
}

type Sender = (reply: FastifyReply, error: unknown, fallback: string) => unknown;

interface Deps {
  /** Resolves auth for this surface, or throws to reject the request. */
  resolve: (request: FastifyRequest) => Promise<BrowserRouteContext>;
  sendError: Sender;
}

const scope = (ctx: BrowserRouteContext) => ({
  tenantDbName: ctx.tenantDbName,
  tenantId: ctx.tenantId,
  projectId: ctx.projectId,
});

// ── Flows ───────────────────────────────────────────────────────────────

export function browserFlowHandlers({ resolve, sendError }: Deps) {
  return {
    create: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const body = createBrowserFlowInputSchema.parse(readJsonBody<unknown>(request));
        const flow = await createBrowserFlow(scope(ctx), { ...body, createdBy: ctx.actor });
        return reply.code(201).send({ flow });
      } catch (error) {
        return sendError(reply, error, 'Failed to create browser flow');
      }
    },

    list: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const query = (request.query ?? {}) as { status?: string; browserId?: string; search?: string };
        const flows = await listBrowserFlows(scope(ctx), query);
        return reply.code(200).send({ flows });
      } catch (error) {
        return sendError(reply, error, 'Failed to list browser flows');
      }
    },

    get: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const { idOrKey } = request.params as { idOrKey: string };
        const flow = await getBrowserFlow(scope(ctx), idOrKey);
        if (!flow) return reply.code(404).send({ error: 'Browser flow not found' });
        return reply.code(200).send({ flow });
      } catch (error) {
        return sendError(reply, error, 'Failed to load browser flow');
      }
    },

    update: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const { idOrKey } = request.params as { idOrKey: string };
        const body = updateBrowserFlowInputSchema.parse(readJsonBody<unknown>(request));
        const flow = await updateBrowserFlow(scope(ctx), idOrKey, { ...body, updatedBy: ctx.actor });
        if (!flow) return reply.code(404).send({ error: 'Browser flow not found' });
        return reply.code(200).send({ flow });
      } catch (error) {
        return sendError(reply, error, 'Failed to update browser flow');
      }
    },

    remove: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const { idOrKey } = request.params as { idOrKey: string };
        const ok = await deleteBrowserFlow(scope(ctx), idOrKey);
        if (!ok) return reply.code(404).send({ error: 'Browser flow not found' });
        return reply.code(200).send({ deleted: true });
      } catch (error) {
        return sendError(reply, error, 'Failed to delete browser flow');
      }
    },

    /** Turn a driven session into a replayable flow. */
    record: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const body = recordBrowserFlowInputSchema.parse(readJsonBody<unknown>(request));
        const flow = await recordBrowserFlow(scope(ctx), { ...body, createdBy: ctx.actor });
        return reply.code(201).send({ flow });
      } catch (error) {
        return sendError(reply, error, 'Failed to record browser flow');
      }
    },

    /**
     * Run a flow and wait for it.
     *
     * Synchronous on purpose: a flow is bounded by its own step timeouts, and
     * a caller that asked to run one almost always needs the outcome. Long
     * schedules go through the run history instead of holding a connection.
     */
    run: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const { idOrKey } = request.params as { idOrKey: string };
        const body = runBrowserFlowInputSchema.parse(readJsonBody<unknown>(request) ?? {});
        const run = await runBrowserFlow(scope(ctx), idOrKey, {
          ...body,
          trigger: 'api',
          createdBy: ctx.actor,
        });
        // A failed RUN is a successful REQUEST: the caller asked to execute a
        // flow and got a complete, inspectable answer. Returning 5xx here
        // would make a broken selector look like a broken server.
        return reply.code(200).send({ run });
      } catch (error) {
        return sendError(reply, error, 'Failed to run browser flow');
      }
    },

    listRuns: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const query = (request.query ?? {}) as {
          flowId?: string;
          status?: string;
          limit?: string;
          skip?: string;
        };
        const runs = await listBrowserFlowRuns(scope(ctx), {
          flowId: query.flowId,
          status: query.status,
          limit: query.limit ? Number(query.limit) : undefined,
          skip: query.skip ? Number(query.skip) : undefined,
        });
        return reply.code(200).send({ runs });
      } catch (error) {
        return sendError(reply, error, 'Failed to list browser flow runs');
      }
    },

    getRun: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const { runId } = request.params as { runId: string };
        const run = await getBrowserFlowRun(scope(ctx), runId);
        if (!run) return reply.code(404).send({ error: 'Browser flow run not found' });
        return reply.code(200).send({ run });
      } catch (error) {
        return sendError(reply, error, 'Failed to load browser flow run');
      }
    },
  };
}

// ── Signed-in profile + session observation ─────────────────────────────

export function browserProfileHandlers({ resolve, sendError }: Deps) {
  return {
    /**
     * Attach a `storageState` profile to a browser.
     *
     * Accepts the file's JSON directly, so `curl -d @profile.json` and a
     * drag-and-drop in the UI hit the same endpoint. The payload is encrypted
     * on write and never readable back — the response is the summary only.
     */
    uploadProfile: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const { idOrKey } = request.params as { idOrKey: string };
        const body = readJsonBody<Record<string, unknown>>(request) ?? {};
        // Both shapes are accepted: the raw Playwright export, and a wrapper
        // carrying the filename the operator uploaded.
        const state = body.storageState ?? body;
        const summary = await setBrowserStorageState(scope(ctx), idOrKey, {
          storageState: state,
          uploadedBy: ctx.actor,
          sourceFileName: typeof body.fileName === 'string' ? body.fileName : undefined,
        });
        return reply.code(200).send({ profile: summary });
      } catch (error) {
        return sendError(reply, error, 'Failed to attach browser profile');
      }
    },

    deleteProfile: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const { idOrKey } = request.params as { idOrKey: string };
        const ok = await clearBrowserStorageState(scope(ctx), idOrKey, ctx.actor);
        if (!ok) return reply.code(404).send({ error: 'Browser not found' });
        return reply.code(200).send({ deleted: true });
      } catch (error) {
        return sendError(reply, error, 'Failed to clear browser profile');
      }
    },

    /**
     * Export a live session's cookies + origin storage.
     *
     * The other half of "sign in once": drive the login by hand in the live
     * preview, export here, POST it to `uploadProfile`, and every scheduled
     * run afterwards starts authenticated.
     */
    exportSessionProfile: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const { sessionKey } = request.params as { sessionKey: string };
        const storageState = await exportSessionStorageState(scope(ctx), sessionKey);
        return reply.code(200).send({ storageState });
      } catch (error) {
        return sendError(reply, error, 'Failed to export session profile');
      }
    },

    observations: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const { sessionKey } = request.params as { sessionKey: string };
        const observations = await readSessionObservations(scope(ctx), sessionKey);
        return reply.code(200).send(observations);
      } catch (error) {
        return sendError(reply, error, 'Failed to read session diagnostics');
      }
    },

    find: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ctx = await resolve(request);
        const { sessionKey } = request.params as { sessionKey: string };
        const query = (request.query ?? {}) as { text?: string; limit?: string };
        if (!query.text) return reply.code(400).send({ error: '`text` is required' });
        const result = await searchPageText(scope(ctx), sessionKey, query.text, {
          limit: query.limit ? Number(query.limit) : undefined,
        });
        return reply.code(200).send(result);
      } catch (error) {
        return sendError(reply, error, 'Failed to search page text');
      }
    },
  };
}
