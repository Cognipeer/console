/**
 * Verify the browser surface through @cognipeer/console-sdk.
 *
 * Lives outside the test suite because the SDK is a SIBLING package, not a
 * console dependency — importing it from a committed test would tie the
 * console's suite to whatever happens to be checked out next door. The API
 * itself is covered by `src/__tests__/integration/browser-client-api.test.ts`;
 * this script proves the published client reaches the same surface.
 *
 * Run it from the console repo:
 *   npx tsx scripts/verify-browser-sdk.mjs
 *
 * It must go through tsx (not bare node): the imports below use the same
 * `@/…` specifiers the server does, and mixing those with relative paths
 * loads two copies of the database module — two singletons, and a token
 * written to one that the other cannot see.
 *
 * It boots its own SQLite database, its own Fastify API and its own fixture
 * site, so it touches nothing that already exists.
 */

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-sdk-verify-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'sdk_verify_main';
process.env.BROWSER_BLOCK_PRIVATE_NETWORK = 'false';
process.env.JWT_SECRET ||= 'sdk-verify-secret-must-be-at-least-32-chars!!';
process.env.NODE_ENV = 'test';

const SDK_ENTRY = path.resolve(process.cwd(), '../console-sdk/dist/index.mjs');

const PAGE = `<!doctype html>
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

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const { default: Fastify } = await import('fastify');
  const { reloadConfig } = await import('@/lib/core/config');
  const { getDatabase, disconnectDatabase } = await import('@/lib/database');
  const { browserManager } = await import('@/lib/services/browser/browserManager');
  const { createApiTokenSecret, hashApiToken } =
    await import('@/lib/services/apiTokens/tokenHashing');
  const { fastifyApiPlugin } = await import('@/server/api/plugin');
  const { bootstrapApplication } = await import('@/server/bootstrap');

  reloadConfig();

  const origin = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const originUrl = `http://127.0.0.1:${origin.address().port}/`;

  const db = await getDatabase();
  await db.connect();
  const tenant = await db.createTenant({
    companyName: 'SDK Verify',
    slug: 'sdk-verify',
    dbName: 'sdk_verify_tenant',
    licenseType: 'enterprise',
  });
  const tenantId = String(tenant._id);
  await db.switchToTenant('sdk_verify_tenant');
  const user = await db.createUser({
    email: 'sdk@example.com',
    password: 'x',
    name: 'SDK',
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
  const apiKey = createApiTokenSecret();
  await db.createApiToken({
    userId: String(user._id),
    tenantId,
    projectId: String(project._id),
    label: 'sdk-verify',
    tokenHash: hashApiToken(apiKey),
    tokenPrefix: apiKey.slice(0, 8),
  });

  await bootstrapApplication();

  const api = Fastify({ logger: false });
  api.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, payload, done) => done(null, payload),
  );
  await api.register(fastifyApiPlugin, { prefix: '/api' });
  await api.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${api.server.address().port}`;

  const { CognipeerClient } = await import(pathToFileURL(SDK_ENTRY).href);
  const client = new CognipeerClient({ apiKey, baseURL: baseUrl });

  console.log('\nSDK → browser surface');

  const browser = await client.browsers.create({
    name: 'SDK Browser',
    defaultSessionConfig: {
      headless: true,
      actionTimeoutMs: 8000,
      navigationTimeoutMs: 15000,
      dialogPolicy: 'dismiss',
      timezoneId: 'Europe/Istanbul',
    },
  });
  check('browsers.create', Boolean(browser.id));

  const listed = await client.browsers.list();
  check('browsers.list', listed.some((item) => item.id === browser.id));

  const profile = await client.browsers.setProfile(browser.id, {
    cookies: [{ name: 'sdk', value: 'secret-value', domain: '127.0.0.1', path: '/' }],
    origins: [],
  }, 'sdk.json');
  check('browsers.setProfile', profile.cookieCount === 1);

  const reread = await client.browsers.get(browser.id);
  check(
    'profile ciphertext never returned',
    !JSON.stringify(reread).includes('secret-value'),
  );
  check('profile summary returned', reread.storageStateMeta?.cookieCount === 1);

  const session = await client.browserSessions.create({ browserId: browser.id });
  check('browserSessions.create', Boolean(session.sessionKey));

  await client.browserSessions.action(session.sessionKey, { type: 'goto', url: originUrl });

  const typed = await client.browserSessions.action(session.sessionKey, {
    type: 'type', label: 'Purchase order', text: 'SDK-1',
  });
  check('action by durable label target', typed.ok === true);
  check('resolvedTarget returned', Boolean(typed.resolvedTarget));

  const found = await client.browserSessions.find(session.sessionKey, 'Look up');
  check('browserSessions.find', found.matches.length > 0);

  const clicked = await client.browserSessions.action(session.sessionKey, {
    type: 'click',
    ...found.matches[0].target,
  });
  check('click a target returned by find', clicked.ok === true);

  const read = await client.browserSessions.extract(session.sessionKey, { selector: '#result' });
  check('browserSessions.extract', read.values[0] === 'FOUND SDK-1', read.values[0]);

  const snap = await client.browserSessions.snapshot(session.sessionKey);
  check('snapshot carries element refs', /\[ref=e\d+\]/.test(snap.ariaSnapshot));

  const diagnostics = await client.browserSessions.diagnostics(session.sessionKey);
  check('browserSessions.diagnostics', Array.isArray(diagnostics.console));

  const exported = await client.browserSessions.exportProfile(session.sessionKey);
  check('browserSessions.exportProfile', Array.isArray(exported.cookies));

  await client.browserSessions.close(session.sessionKey);

  const flow = await client.browserFlows.record({
    sessionId: session.id,
    name: 'SDK flow',
    status: 'active',
  });
  check('browserFlows.record', flow.steps.length > 0);
  check('recording stores no volatile ref', !JSON.stringify(flow.steps).match(/"ref"\s*:/));
  check('typed values became inputs', (flow.inputs ?? []).length > 0);

  await client.browserFlows.update(flow.key, {
    steps: [
      ...flow.steps,
      { action: { type: 'extract', selector: '#result' }, captureAs: 'result' },
    ],
  });

  const run = await client.browserFlows.run(flow.key, {
    inputs: Object.fromEntries((flow.inputs ?? []).map((input) => [input.name, 'SDK-2'])),
  });
  check('browserFlows.run succeeded', run.status === 'succeeded', run.errorMessage);
  check('replay used the supplied input', run.outputs?.result === 'FOUND SDK-2', String(run.outputs?.result));

  const runs = await client.browserFlows.listRuns({ flowId: flow.id });
  check('browserFlows.listRuns', runs.length > 0);

  const fetchedRun = await client.browserFlows.getRun(runs[0].id);
  check('browserFlows.getRun', fetchedRun.id === runs[0].id);

  await client.browserFlows.delete(flow.key);
  let deleted = false;
  try {
    await client.browserFlows.get(flow.key);
  } catch {
    deleted = true;
  }
  check('browserFlows.delete', deleted);

  await client.browsers.clearProfile(browser.id);
  const cleared = await client.browsers.get(browser.id);
  check('browsers.clearProfile', !cleared.storageStateMeta);

  await browserManager.shutdown().catch(() => {});
  await api.close().catch(() => {});
  await new Promise((resolve) => origin.close(resolve));
  await disconnectDatabase().catch(() => {});
  rmSync(tmpRoot, { force: true, recursive: true });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  rmSync(tmpRoot, { force: true, recursive: true });
  process.exit(1);
});
