/**
 * Browser flows, end to end: discover once, record, replay deterministically.
 *
 * This is the whole product claim in one file. A session is driven the way an
 * agent drives one — by aria `ref`, the volatile marker from a snapshot — and
 * then recorded. The replay runs in a NEW session, where every one of those
 * refs has been renumbered, so it can only pass if recording really did
 * substitute durable targets.
 *
 * Backed by a real SQLiteProvider in a temp directory and a real Chromium.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SQLite + temp dir need to be configured BEFORE getDatabase() is ever called.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-browser-flow-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'browser_flow_main';
// 127.0.0.1 is private address space; the fixture server lives there.
process.env.BROWSER_BLOCK_PRIVATE_NETWORK = 'false';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import { browserManager } from '@/lib/services/browser/browserManager';
import { chromiumAvailable } from '../helpers/browserAvailability';
import {
  createBrowser,
  setBrowserStorageState,
  getBrowser,
} from '@/lib/services/browser/browserProfileService';
import {
  captureSnapshot,
  closeBrowserSession,
  createBrowserSession,
  runBrowserAction,
} from '@/lib/services/browser/browserSessionService';
import {
  createBrowserFlow,
  getBrowserFlowRun,
  listBrowserFlowRuns,
  recordBrowserFlow,
  runBrowserFlow,
  updateBrowserFlow,
} from '@/lib/services/browser/browserFlowService';

const TENANT_DB_NAME = 'browser_flow_tenant';
const TENANT_ID = 'tenant-browser-flow';
const ACTOR = 'tester@example.com';
const ctx = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: 'proj-1' };

/**
 * A two-step app: fill a form, submit, land on a result page.
 *
 * Deliberately has no test-ids on the fields — the recording has to survive
 * on role + name and label, which is the realistic case.
 */
const APP = `<!doctype html>
<html><body>
  <h1>Expense Portal</h1>
  <label for="ref">Reference</label>
  <input id="ref" name="ref" />
  <label for="amount">Amount</label>
  <input id="amount" name="amount" />
  <select id="currency" aria-label="Currency">
    <option value="try">TRY</option>
    <option value="eur">EUR</option>
  </select>
  <input type="checkbox" id="urgent" aria-label="Urgent" />
  <button type="button" onclick="submitForm()">Submit expense</button>
  <p id="receipt">no receipt</p>
  <script>
    function submitForm() {
      var r = document.getElementById('ref').value;
      var a = document.getElementById('amount').value;
      var c = document.getElementById('currency').value;
      var u = document.getElementById('urgent').checked ? 'urgent' : 'normal';
      document.getElementById('receipt').textContent =
        'RECEIPT ' + r + '/' + a + c.toUpperCase() + '/' + u;
    }
  </script>
</body></html>`;

let server: Server;
let baseUrl = '';
let browserId = '';

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.connect();
  await db.switchToTenant(TENANT_DB_NAME);

  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(APP);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  const browser = await createBrowser(ctx, {
    name: 'Flow Test Browser',
    createdBy: ACTOR,
    defaultSessionConfig: { headless: true, actionTimeoutMs: 8_000, navigationTimeoutMs: 15_000 },
  });
  browserId = browser.id;
}, 120_000);

afterAll(async () => {
  await browserManager.shutdown().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectDatabase().catch(() => undefined);
  rmSync(tmpRoot, { force: true, recursive: true });
});

/**
 * Drive a session the way an agent does: snapshot, then act on the ref it
 * just saw. Returns the session id so it can be recorded.
 */
async function driveDiscoverySession(): Promise<{ sessionId: string; sessionKey: string }> {
  const session = await createBrowserSession(ctx, {
    browserId,
    name: 'discovery',
    createdBy: ACTOR,
  });
  const key = session.sessionKey;

  await runBrowserAction(ctx, key, { type: 'goto', url: baseUrl });

  const refFor = async (match: string): Promise<string> => {
    const { ariaSnapshot } = await captureSnapshot(ctx, key);
    const ref = ariaSnapshot
      .split('\n')
      .find((line) => line.includes(match))
      ?.match(/\[ref=(e\d+)\]/)?.[1];
    if (!ref) throw new Error(`No ref found for ${match} in:\n${ariaSnapshot}`);
    return ref;
  };

  await runBrowserAction(ctx, key, { type: 'type', ref: await refFor('textbox "Reference"'), text: 'EXP-1001' });
  await runBrowserAction(ctx, key, { type: 'type', ref: await refFor('textbox "Amount"'), text: '250' });
  await runBrowserAction(ctx, key, {
    type: 'select',
    ref: await refFor('combobox "Currency"'),
    labels: ['EUR'],
  });
  await runBrowserAction(ctx, key, { type: 'check', ref: await refFor('checkbox "Urgent"') });
  await runBrowserAction(ctx, key, { type: 'click', ref: await refFor('button "Submit expense"') });

  return { sessionId: session.id, sessionKey: key };
}

describe.skipIf(!chromiumAvailable())('record', () => {
  it('turns a ref-driven session into a flow with no refs left in it', async () => {
    const { sessionId, sessionKey } = await driveDiscoverySession();
    await closeBrowserSession(ctx, sessionKey);

    const flow = await recordBrowserFlow(ctx, {
      sessionId,
      name: 'Submit expense',
      createdBy: ACTOR,
    });

    expect(flow.status).toBe('draft');
    expect(flow.recordedFromSessionId).toBe(sessionId);
    // goto + 2 types + select + check + click. The opening navigation is
    // part of the flow: a replay starts from a blank page, not from wherever
    // the recorded session happened to be.
    expect(flow.steps.length).toBe(6);
    expect(flow.steps[0].action.type).toBe('goto');

    // THE assertion: a persisted ref is a step that will resolve to nothing on
    // the next run and then spend its whole timeout finding that out.
    const serialized = JSON.stringify(flow.steps);
    expect(serialized).not.toMatch(/"ref"\s*:/);
    expect(serialized).toContain('"role":"button"');
    expect(serialized).toContain('Submit expense');

    // Typed values become parameters, never literals — the recorder cannot
    // tell a reference number from a password.
    expect(flow.inputs?.length).toBe(2);
    expect(serialized).toContain('{{input.');
    expect(serialized).not.toContain('EXP-1001');
  }, 120_000);

  it('refuses a hand-written step that still carries a ref', async () => {
    await expect(createBrowserFlow(ctx, {
      name: 'Bad flow',
      browserId,
      createdBy: ACTOR,
      steps: [{ action: { type: 'click', ref: 'e4' } }],
    })).resolves.toBeDefined();
    // The service layer takes typed input; the guard lives in the schema the
    // API parses, so assert there.
    const { createBrowserFlowInputSchema } = await import('@/lib/services/browser/validation');
    const parsed = createBrowserFlowInputSchema.safeParse({
      name: 'Bad flow',
      browserId,
      steps: [{ action: { type: 'click', ref: 'e4' } }],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain('cannot store `ref`');
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('replay', () => {
  it('runs a recorded flow in a fresh session and binds its inputs', async () => {
    const { sessionId, sessionKey } = await driveDiscoverySession();
    await closeBrowserSession(ctx, sessionKey);

    const recorded = await recordBrowserFlow(ctx, {
      sessionId,
      name: 'Replayable expense',
      status: 'active',
      createdBy: ACTOR,
    });

    // Append a read of the receipt so the run proves the page actually
    // changed, rather than only that no step threw.
    const [refInput, amountInput] = recorded.inputs ?? [];
    const flow = await updateBrowserFlow(ctx, recorded.id, {
      steps: [
        ...recorded.steps,
        {
          action: { type: 'extract', selector: '#receipt' },
          captureAs: 'receipt',
        },
      ],
      updatedBy: ACTOR,
    });
    expect(flow).not.toBeNull();

    const run = await runBrowserFlow(ctx, recorded.key, {
      inputs: { [refInput.name]: 'EXP-2002', [amountInput.name]: '999' },
      trigger: 'api',
      createdBy: ACTOR,
    });

    expect(run.status).toBe('succeeded');
    expect(run.failedStepIndex).toBeUndefined();
    expect(run.stepResults?.every((step) => step.status === 'succeeded')).toBe(true);
    // The replayed values are the ones supplied at run time, in a session
    // where every ref from the recording has long since been renumbered.
    expect(run.outputs?.receipt).toBe('RECEIPT EXP-2002/999EUR/urgent');
  }, 120_000);

  it('records the run in history and can read it back', async () => {
    const runs = await listBrowserFlowRuns(ctx, { limit: 10 });
    expect(runs.length).toBeGreaterThan(0);
    const fetched = await getBrowserFlowRun(ctx, runs[0].id);
    expect(fetched?.id).toBe(runs[0].id);
    expect(fetched?.flowVersion).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('rejects a run that is missing a required input', async () => {
    const flow = await createBrowserFlow(ctx, {
      name: 'Needs input',
      browserId,
      status: 'active',
      createdBy: ACTOR,
      inputs: [{ name: 'token', type: 'secret', required: true }],
      steps: [{ action: { type: 'goto', url: baseUrl } }],
    });
    await expect(runBrowserFlow(ctx, flow.key, { createdBy: ACTOR }))
      .rejects.toThrow(/Missing required flow input/);
  }, 60_000);

  it('never persists a secret input onto the run record', async () => {
    const flow = await createBrowserFlow(ctx, {
      name: 'Secret handling',
      browserId,
      status: 'active',
      createdBy: ACTOR,
      inputs: [
        { name: 'password', type: 'secret', required: true },
        { name: 'reference', type: 'string', required: true },
      ],
      steps: [
        { action: { type: 'goto', url: baseUrl } },
        { action: { type: 'type', label: 'Reference', text: '{{input.reference}}' } },
      ],
    });

    const run = await runBrowserFlow(ctx, flow.key, {
      inputs: { password: 'hunter2', reference: 'REF-9' },
      createdBy: ACTOR,
    });

    expect(run.status).toBe('succeeded');
    expect(run.inputs).toEqual({ reference: 'REF-9' });
    expect(JSON.stringify(run)).not.toContain('hunter2');
  }, 120_000);

  it('aborts on a broken step and reports where', async () => {
    const flow = await createBrowserFlow(ctx, {
      name: 'Breaks halfway',
      browserId,
      status: 'active',
      createdBy: ACTOR,
      steps: [
        { action: { type: 'goto', url: baseUrl } },
        {
          action: { type: 'click', role: 'button', name: 'Button that moved' },
          policy: { timeoutMs: 1_500 },
        },
        { action: { type: 'extract', selector: '#receipt' }, captureAs: 'never' },
      ],
    });

    const run = await runBrowserFlow(ctx, flow.key, { createdBy: ACTOR });

    expect(run.status).toBe('failed');
    expect(run.failedStepIndex).toBe(1);
    // The third step must NOT have run — a half-finished form is worse than
    // an untouched one.
    expect(run.stepResults?.length).toBe(2);
    expect(run.outputs?.never).toBeUndefined();
    expect(run.errorMessage).toBeTruthy();
  }, 120_000);

  it('continues past a failing step marked optional', async () => {
    const flow = await createBrowserFlow(ctx, {
      name: 'Optional cookie banner',
      browserId,
      status: 'active',
      createdBy: ACTOR,
      steps: [
        { action: { type: 'goto', url: baseUrl } },
        {
          action: { type: 'click', role: 'button', name: 'Accept cookies' },
          policy: { optional: true, timeoutMs: 1_000 },
        },
        { action: { type: 'extract', role: 'heading', name: 'Expense Portal' }, captureAs: 'title' },
      ],
    });

    const run = await runBrowserFlow(ctx, flow.key, { createdBy: ACTOR });

    expect(run.status).toBe('succeeded');
    expect(run.stepResults?.[1].status).toBe('skipped');
    expect(run.outputs?.title).toBe('Expense Portal');
  }, 120_000);

  it('retries a step before giving up', async () => {
    const flow = await createBrowserFlow(ctx, {
      name: 'Retries',
      browserId,
      status: 'active',
      createdBy: ACTOR,
      steps: [
        { action: { type: 'goto', url: baseUrl } },
        {
          action: { type: 'click', role: 'button', name: 'Nope' },
          policy: { retries: 2, retryDelayMs: 10, timeoutMs: 800 },
        },
      ],
    });

    const run = await runBrowserFlow(ctx, flow.key, { createdBy: ACTOR });
    expect(run.status).toBe('failed');
    expect(run.stepResults?.[1].attempts).toBe(3);
  }, 120_000);

  it('skips a step whose `when` is falsy', async () => {
    const flow = await createBrowserFlow(ctx, {
      name: 'Conditional',
      browserId,
      status: 'active',
      createdBy: ACTOR,
      inputs: [{ name: 'doIt', type: 'string', required: false, default: 'false' }],
      steps: [
        { action: { type: 'goto', url: baseUrl } },
        { action: { type: 'click', role: 'button', name: 'Submit expense' }, when: '{{input.doIt}}' },
      ],
    });

    const run = await runBrowserFlow(ctx, flow.key, { createdBy: ACTOR });
    expect(run.status).toBe('succeeded');
    expect(run.stepResults?.[1].status).toBe('skipped');
  }, 120_000);
});

describe.skipIf(!chromiumAvailable())('browser profile', () => {
  it('stores a storageState encrypted and reports only a summary', async () => {
    const summary = await setBrowserStorageState(ctx, browserId, {
      storageState: {
        cookies: [{
          name: 'session',
          value: 'super-secret-cookie',
          domain: '127.0.0.1',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 3600,
        }],
        origins: [{ origin: baseUrl.replace(/\/$/, ''), localStorage: [{ name: 'k', value: 'v' }] }],
      },
      uploadedBy: ACTOR,
      sourceFileName: 'profile.json',
    });

    expect(summary.cookieCount).toBe(1);
    expect(summary.origins).toContain('127.0.0.1');
    expect(summary.earliestExpiry).toBeInstanceOf(Date);

    // The API view must never carry the ciphertext, let alone the cookie.
    const view = await getBrowser(ctx, browserId);
    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty('storageStateEnc');
    expect(JSON.stringify(view)).not.toContain('super-secret-cookie');
    expect(view?.storageStateMeta?.cookieCount).toBe(1);
  }, 60_000);

  it('rejects a file that is not a storageState export', async () => {
    await expect(setBrowserStorageState(ctx, browserId, {
      storageState: { hello: 'world' },
      uploadedBy: ACTOR,
    })).rejects.toThrow(/no cookies and no origin storage/);
  }, 60_000);

  it('applies the stored profile to a new session without persisting it', async () => {
    const session = await createBrowserSession(ctx, { browserId, createdBy: ACTOR });
    // The row is read by the sessions list and the UI, so the decrypted
    // profile must not be on it.
    expect(JSON.stringify(session.config)).not.toContain('super-secret-cookie');

    await runBrowserAction(ctx, session.sessionKey, { type: 'goto', url: baseUrl });
    const state = await browserManager.exportStorageState(session.sessionKey);
    const cookies = (state.cookies ?? []) as Array<{ name: string }>;
    expect(cookies.some((cookie) => cookie.name === 'session')).toBe(true);

    await closeBrowserSession(ctx, session.sessionKey);
  }, 120_000);
});
