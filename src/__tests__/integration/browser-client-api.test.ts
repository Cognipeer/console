/**
 * The browser client API, against the real Fastify routes.
 *
 * Everything a person can do in the dashboard has to be doable from the API —
 * otherwise the console is the only client and any automation someone wants
 * to build stops at the UI. That is easy to claim and easy to break, so this
 * drives the whole journey over HTTP with a bearer token: create a browser,
 * attach a signed-in profile, drive a session, record it, replay it.
 *
 * The server is the actual API plugin on a bare Fastify instance — no Next,
 * no mocked services, a real SQLite database and a real Chromium.
 *
 * The SDK is exercised against this same surface by
 * `scripts/verify-browser-sdk.mjs`; it lives outside the suite because
 * `@cognipeer/console-sdk` is a sibling package, not a console dependency.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-browser-api-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'browser_api_main';
process.env.BROWSER_BLOCK_PRIVATE_NETWORK = 'false';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import { browserManager } from '@/lib/services/browser/browserManager';
import { createApiTokenSecret, hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import { fastifyApiPlugin } from '@/server/api/plugin';
import { bootstrapApplication } from '@/server/bootstrap';

const APP = `<!doctype html>
<html><body>
  <h1>Vendor Portal</h1>
  <label for="po">Purchase order</label>
  <input id="po" />
  <button type="button" onclick="go()">Look up</button>
  <p id="result">nothing</p>
  <script>
    function go() {
      document.getElementById('result').textContent =
        'FOUND ' + document.getElementById('po').value;
    }
  </script>
</body></html>`;

let origin: Server;
let originUrl = '';
let api: FastifyInstance;
let apiUrl = '';
let token = '';

async function http(
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${apiUrl}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

beforeAll(async () => {
  reloadConfig();

  origin = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(APP);
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/`;

  // ── Tenant, user and an API token to authenticate with ────────────
  const db = await getDatabase();
  await db.connect();

  const tenant = await db.createTenant({
    companyName: 'API Test Co',
    slug: 'api-test',
    dbName: 'browser_api_tenant',
    licenseType: 'enterprise',
  });
  const tenantId = String(tenant._id);
  await db.switchToTenant('browser_api_tenant');

  const user = await db.createUser({
    email: 'api@example.com',
    password: 'x',
    name: 'API Tester',
    tenantId,
    role: 'owner',
    licenseId: 'test',
  });

  const project = await db.createProject({
    tenantId,
    key: 'default',
    name: 'Default Project',
    createdBy: String(user._id),
  });

  const secret = createApiTokenSecret();
  await db.createApiToken({
    userId: String(user._id),
    tenantId,
    projectId: String(project._id),
    label: 'test',
    tokenHash: hashApiToken(secret),
    tokenPrefix: secret.slice(0, 8),
  });
  token = secret;

  // Every non-health route 503s until bootstrap finishes — the server starts
  // listening before it is ready, on purpose, so a test that skips this gets
  // "Server is still starting up" for everything.
  await bootstrapApplication();

  // ── The API surface itself, with no Next in the way ───────────────
  api = Fastify({ logger: false });
  api.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, payload, done) => done(null, payload),
  );
  await api.register(fastifyApiPlugin, { prefix: '/api' });
  await api.listen({ port: 0, host: '127.0.0.1' });
  apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  await browserManager.shutdown().catch(() => undefined);
  await api?.close().catch(() => undefined);
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  await disconnectDatabase().catch(() => undefined);
  rmSync(tmpRoot, { force: true, recursive: true });
});

describe('client API', () => {
  let browserId = '';
  let sessionKey = '';
  let sessionId = '';
  let flowKey = '';

  it('creates a browser', async () => {
    const res = await http('POST', '/api/client/v1/browser/browsers', {
      name: 'API Browser',
      defaultSessionConfig: {
        headless: true,
        actionTimeoutMs: 8_000,
        navigationTimeoutMs: 15_000,
        // A knob that did not exist before this change — proves the API
        // accepts the expanded session config, not just the old four fields.
        dialogPolicy: 'accept',
        timezoneId: 'Europe/Istanbul',
      },
    });
    expect(res.status).toBe(201);
    browserId = String((res.body.browser as { id: string }).id);
    expect(browserId).toBeTruthy();
  }, 60_000);

  it('attaches a signed-in profile and never reads it back', async () => {
    const res = await http('PUT', `/api/client/v1/browser/browsers/${browserId}/profile`, {
      fileName: 'profile.json',
      storageState: {
        cookies: [{
          name: 'sid',
          value: 'do-not-leak-me',
          domain: '127.0.0.1',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 7200,
        }],
        origins: [],
      },
    });
    expect(res.status).toBe(200);
    expect((res.body.profile as { cookieCount: number }).cookieCount).toBe(1);

    const fetched = await http('GET', `/api/client/v1/browser/browsers/${browserId}`);
    expect(fetched.status).toBe(200);
    expect(JSON.stringify(fetched.body)).not.toContain('do-not-leak-me');
    expect(JSON.stringify(fetched.body)).not.toContain('storageStateEnc');
  }, 60_000);

  it('rejects a profile file that is not a storageState export', async () => {
    const res = await http('PUT', `/api/client/v1/browser/browsers/${browserId}/profile`, {
      storageState: { nope: true },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('drives a session through the API', async () => {
    const created = await http('POST', '/api/client/v1/browser/sessions', { browserId });
    expect(created.status).toBe(201);
    const session = created.body.session as { id: string; sessionKey: string };
    sessionId = session.id;
    sessionKey = session.sessionKey;

    expect((await http('POST', `/api/client/v1/browser/sessions/${sessionKey}/actions`, {
      type: 'goto', url: originUrl,
    })).status).toBe(200);

    // A durable target, straight over HTTP — no snapshot ref involved.
    const typed = await http('POST', `/api/client/v1/browser/sessions/${sessionKey}/actions`, {
      type: 'type', label: 'Purchase order', text: 'PO-77',
    });
    expect(typed.status).toBe(200);
    const typedResult = typed.body.result as { ok: boolean; resolvedTarget?: Record<string, unknown> };
    expect(typedResult.ok).toBe(true);
    // The durable descriptor comes back so a caller can save it into a flow.
    expect(typedResult.resolvedTarget).toBeDefined();

    expect((await http('POST', `/api/client/v1/browser/sessions/${sessionKey}/actions`, {
      type: 'click', role: 'button', name: 'Look up',
    })).status).toBe(200);

    const read = await http('POST', `/api/client/v1/browser/sessions/${sessionKey}/extract`, {
      selector: '#result',
    });
    expect((read.body.result as { values: string[] }).values[0]).toBe('FOUND PO-77');
  }, 120_000);

  it('exposes session diagnostics and text search', async () => {
    const found = await http('GET', `/api/client/v1/browser/sessions/${sessionKey}/find?text=Look%20up`);
    expect(found.status).toBe(200);
    expect((found.body as { matches: unknown[] }).matches.length).toBeGreaterThan(0);

    const diagnostics = await http('GET', `/api/client/v1/browser/sessions/${sessionKey}/diagnostics`);
    expect(diagnostics.status).toBe(200);
    expect(Array.isArray(diagnostics.body.console)).toBe(true);
  }, 60_000);

  it('records the session into a flow and replays it', async () => {
    await http('DELETE', `/api/client/v1/browser/sessions/${sessionKey}`);

    const recorded = await http('POST', '/api/client/v1/browser/flows/record', {
      sessionId,
      name: 'Look up a PO',
      status: 'active',
    });
    expect(recorded.status).toBe(201);
    const flow = recorded.body.flow as {
      key: string;
      steps: unknown[];
      inputs: Array<{ name: string }>;
    };
    flowKey = flow.key;
    expect(flow.steps.length).toBeGreaterThan(0);
    expect(JSON.stringify(flow.steps)).not.toMatch(/"ref"\s*:/);

    // Give the flow something to hand back, then replay with a new value.
    const updated = await http('PATCH', `/api/client/v1/browser/flows/${flowKey}`, {
      steps: [
        ...(flow.steps as Array<Record<string, unknown>>),
        { action: { type: 'extract', selector: '#result' }, captureAs: 'result' },
      ],
    });
    expect(updated.status).toBe(200);

    const run = await http('POST', `/api/client/v1/browser/flows/${flowKey}/run`, {
      inputs: { [flow.inputs[0].name]: 'PO-9001' },
    });
    expect(run.status).toBe(200);
    const result = run.body.run as { status: string; outputs: Record<string, unknown> };
    expect(result.status).toBe('succeeded');
    expect(result.outputs.result).toBe('FOUND PO-9001');
  }, 180_000);

  it('lists flows and their run history', async () => {
    const flows = await http('GET', '/api/client/v1/browser/flows');
    expect(flows.status).toBe(200);
    expect((flows.body.flows as unknown[]).length).toBeGreaterThan(0);

    const runs = await http('GET', '/api/client/v1/browser/flow-runs');
    expect(runs.status).toBe(200);
    expect((runs.body.runs as unknown[]).length).toBeGreaterThan(0);
  }, 60_000);

  it('refuses a flow step that carries a volatile ref', async () => {
    const res = await http('POST', '/api/client/v1/browser/flows', {
      name: 'Bad',
      browserId,
      steps: [{ action: { type: 'click', ref: 'e7' } }],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('cannot store `ref`');
  }, 60_000);

  it('rejects an unauthenticated call', async () => {
    const res = await fetch(`${apiUrl}/api/client/v1/browser/browsers`);
    expect(res.status).toBe(401);
  }, 60_000);
});
