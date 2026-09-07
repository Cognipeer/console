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
import { disconnectDatabase, getDatabase, runWithTenantScope } from '@/lib/database';
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
  runBrowserFlowSteps,
  startBrowserFlowRun,
  updateBrowserFlow,
} from '@/lib/services/browser/browserFlowService';

const TENANT_DB_NAME = 'browser_flow_tenant';
const TENANT_ID = 'tenant-browser-flow';
const ACTOR = 'tester@example.com';
const ctx = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: 'proj-1' };

// A second tenant, used only to prove a backgrounded run (`startBrowserFlowRun`)
// survives concurrent activity from another tenant instead of racing the
// process-global `switchToTenant` fallback (the exact bug `runWithTenantScope`
// exists to prevent).
const TENANT2_DB_NAME = 'browser_flow_tenant_2';
const TENANT2_ID = 'tenant-browser-flow-2';
const ctx2 = { tenantDbName: TENANT2_DB_NAME, tenantId: TENANT2_ID, projectId: 'proj-1' };

/** Poll a flow run until it leaves `running`, or throw once `deadlineMs` passes. */
async function awaitRunTerminal(
  runCtx: typeof ctx,
  runId: string,
  deadlineMs = 30_000,
): Promise<NonNullable<Awaited<ReturnType<typeof getBrowserFlowRun>>>> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const polled = await getBrowserFlowRun(runCtx, runId);
    if (!polled) throw new Error(`Run ${runId} disappeared while polling`);
    if (polled.status !== 'running') return polled;
    if (Date.now() > deadline) throw new Error(`Run ${runId} did not finish within ${deadlineMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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

/**
 * What a run RETURNS, as opposed to what it did.
 *
 * A flow is called by something that wants a value back — an agent, an API
 * client — and "whatever `captureAs` happened to collect" is not a contract:
 * it changes when someone renames a capture. These cover the declared shape:
 * that it is honoured, that it survives the steps being rearranged, and that
 * a promise the run cannot keep is a failure rather than a quietly missing
 * key.
 */
describe.skipIf(!chromiumAvailable())('declared outputs', () => {
  /** A flow that fills the form and reads back both the receipt and the amount. */
  async function expenseFlow(outputs?: Parameters<typeof createBrowserFlow>[1]['outputs']) {
    return createBrowserFlow(ctx, {
      name: `Declared outputs ${Math.random().toString(36).slice(2, 8)}`,
      browserId,
      status: 'active',
      createdBy: ACTOR,
      inputs: [{ name: 'reference', type: 'string', required: true }],
      outputs,
      steps: [
        { action: { type: 'goto', url: baseUrl } },
        { action: { type: 'type', label: 'Reference', text: '{{input.reference}}' } },
        { action: { type: 'type', label: 'Amount', text: '4200' } },
        { action: { type: 'click', role: 'button', name: 'Submit expense' } },
        { action: { type: 'extract', selector: '#receipt' }, captureAs: 'receipt' },
        { action: { type: 'extract', selector: '#amount', mode: 'value' }, captureAs: 'amountText' },
      ],
    });
  }

  it('returns the raw captures when a flow declares nothing', async () => {
    const flow = await expenseFlow();
    const run = await runBrowserFlow(ctx, flow.key, {
      inputs: { reference: 'EXP-3003' },
      createdBy: ACTOR,
    });

    expect(run.status).toBe('succeeded');
    expect(run.outputs).toEqual({ receipt: 'RECEIPT EXP-3003/4200TRY/normal', amountText: '4200' });
    // The captures are recorded either way — they are what an output reads
    // from, so a flow being written needs them visible before it declares one.
    expect(run.captures?.receipt).toBe('RECEIPT EXP-3003/4200TRY/normal');
  }, 120_000);

  it('shapes the return value, casts it, and keeps the captures alongside', async () => {
    const flow = await expenseFlow([
      { name: 'receiptCode', source: '{{step.receipt}}' },
      { name: 'amount', source: '{{step.amountText}}', type: 'number' },
      { name: 'summary', source: '{{input.reference}} → {{step.amountText}}' },
    ]);

    const run = await runBrowserFlow(ctx, flow.key, {
      inputs: { reference: 'EXP-4004' },
      createdBy: ACTOR,
    });

    expect(run.status).toBe('succeeded');
    expect(run.outputs).toEqual({
      receiptCode: 'RECEIPT EXP-4004/4200TRY/normal',
      // Cast, not the string the page rendered.
      amount: 4200,
      // A template assembled from two sources, which is why `source` is not
      // just a capture name.
      summary: 'EXP-4004 → 4200',
    });
    // Declaring a shape must not throw the raw material away — it is the
    // debugging view when an output resolves to nothing.
    expect(run.captures?.amountText).toBe('4200');
  }, 120_000);

  it('fails a run that cannot produce a required output, even when every step passed', async () => {
    const flow = await expenseFlow([
      { name: 'vatNumber', source: '{{step.vat}}', required: true },
    ]);

    const run = await runBrowserFlow(ctx, flow.key, {
      inputs: { reference: 'EXP-5005' },
      createdBy: ACTOR,
    });

    expect(run.stepResults?.every((step) => step.status === 'succeeded')).toBe(true);
    expect(run.status).toBe('failed');
    expect(run.errorMessage).toContain('vatNumber');
    // Nothing broke on the page, so there is no failing step to point at.
    expect(run.failedStepIndex).toBeUndefined();
  }, 120_000);

  it('drops a value that does not fit its declared type instead of returning NaN', async () => {
    const flow = await expenseFlow([
      // The receipt is text like `RECEIPT EXP-6006/...`, which is not a number.
      { name: 'total', source: '{{step.receipt}}', type: 'number' },
      { name: 'receiptCode', source: '{{step.receipt}}' },
    ]);

    const run = await runBrowserFlow(ctx, flow.key, {
      inputs: { reference: 'EXP-6006' },
      createdBy: ACTOR,
    });

    expect(run.status).toBe('succeeded');
    expect(run.outputs).not.toHaveProperty('total');
    expect(run.outputs?.receiptCode).toContain('EXP-6006');
  }, 120_000);

  it('moves the flow version when the declared outputs change', async () => {
    const flow = await expenseFlow();
    const before = flow.version;

    const updated = await updateBrowserFlow(ctx, flow.id, {
      outputs: [{ name: 'receiptCode', source: '{{step.receipt}}' }],
      updatedBy: ACTOR,
    });

    // A run pins the version it executed, and the version has to mean one
    // return shape — not whichever was declared last.
    expect(updated?.version).toBe(before + 1);

    const renamed = await updateBrowserFlow(ctx, flow.id, { name: 'Renamed', updatedBy: ACTOR });
    expect(renamed?.version).toBe(before + 1);
  }, 60_000);
});

/**
 * The authoring loop: replay part of a flow into a session the caller holds.
 *
 * A run cannot serve this — it opens its own session and closes it, leaving
 * nothing on screen to build the next step against. These cover what the
 * editor depends on: the page really moves, a second slice continues from
 * where the first stopped (captures included), and a half-built flow with an
 * unanswered required input still replays instead of refusing.
 */
describe.skipIf(!chromiumAvailable())('step-by-step authoring', () => {
  async function authoringFlow() {
    return createBrowserFlow(ctx, {
      name: `Authoring ${Math.random().toString(36).slice(2, 8)}`,
      browserId,
      status: 'draft',
      createdBy: ACTOR,
      inputs: [
        { name: 'reference', type: 'string', required: true },
        { name: 'amount', type: 'string', required: true, default: '77' },
      ],
      steps: [
        { action: { type: 'goto', url: baseUrl } },
        { action: { type: 'type', label: 'Reference', text: '{{input.reference}}' } },
        { action: { type: 'type', label: 'Amount', text: '{{input.amount}}' } },
        { action: { type: 'click', role: 'button', name: 'Submit expense' } },
        { action: { type: 'extract', selector: '#receipt' }, captureAs: 'receipt' },
      ],
    });
  }

  it('replays a slice into an open session and leaves the page there', async () => {
    const flow = await authoringFlow();
    const session = await createBrowserSession(ctx, { browserId, name: 'authoring', createdBy: ACTOR });

    // Steps 1–2 only: fill the reference, and stop.
    const first = await runBrowserFlowSteps(ctx, flow.key, {
      sessionKey: session.sessionKey,
      to: 2,
      inputs: { reference: 'EXP-7007' },
      createdBy: ACTOR,
    });

    expect(first.results.map((step) => step.status)).toEqual(['succeeded', 'succeeded']);
    expect(first.failedStepIndex).toBeUndefined();

    // The session is still open AND the typed value is on the page — this is
    // the whole point: the next step is built against this state.
    const snapshot = await captureSnapshot(ctx, session.sessionKey);
    expect(snapshot.ariaSnapshot).toContain('EXP-7007');

    // Continuing runs only the remaining steps, carrying the captures.
    const rest = await runBrowserFlowSteps(ctx, flow.key, {
      sessionKey: session.sessionKey,
      from: 2,
      inputs: { reference: 'EXP-7007' },
      captures: first.captures,
      createdBy: ACTOR,
    });

    expect(rest.results.map((step) => step.index)).toEqual([2, 3, 4]);
    // `amount` was never supplied, so its declared default applied.
    expect(rest.captures.receipt).toBe('RECEIPT EXP-7007/77TRY/normal');

    await closeBrowserSession(ctx, session.sessionKey).catch(() => undefined);
  }, 120_000);

  it('replays a half-built flow whose required input has no value yet', async () => {
    const flow = await authoringFlow();
    const session = await createBrowserSession(ctx, { browserId, name: 'authoring', createdBy: ACTOR });

    // No `reference` at all. A run would refuse; authoring must not.
    const outcome = await runBrowserFlowSteps(ctx, flow.key, {
      sessionKey: session.sessionKey,
      to: 2,
      createdBy: ACTOR,
    });

    expect(outcome.results.every((step) => step.status === 'succeeded')).toBe(true);
    // The unresolved placeholder is typed literally rather than blanked — the
    // same rule a run follows, so what you see here is what a run would do.
    const snapshot = await captureSnapshot(ctx, session.sessionKey);
    expect(snapshot.ariaSnapshot).toContain('{{input.reference}}');

    await closeBrowserSession(ctx, session.sessionKey).catch(() => undefined);
  }, 120_000);

  it('stops at the first failing step and says which one', async () => {
    const flow = await createBrowserFlow(ctx, {
      name: `Authoring break ${Math.random().toString(36).slice(2, 8)}`,
      browserId,
      status: 'draft',
      createdBy: ACTOR,
      steps: [
        { action: { type: 'goto', url: baseUrl } },
        {
          action: { type: 'click', role: 'button', name: 'Not on this page' },
          policy: { timeoutMs: 1_000 },
        },
        { action: { type: 'extract', selector: '#receipt' }, captureAs: 'never' },
      ],
    });
    const session = await createBrowserSession(ctx, { browserId, name: 'authoring', createdBy: ACTOR });

    const outcome = await runBrowserFlowSteps(ctx, flow.key, {
      sessionKey: session.sessionKey,
      createdBy: ACTOR,
    });

    expect(outcome.failedStepIndex).toBe(1);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.captures.never).toBeUndefined();

    await closeBrowserSession(ctx, session.sessionKey).catch(() => undefined);
  }, 120_000);

  it('records no run — authoring is not history', async () => {
    const flow = await authoringFlow();
    const session = await createBrowserSession(ctx, { browserId, name: 'authoring', createdBy: ACTOR });

    await runBrowserFlowSteps(ctx, flow.key, {
      sessionKey: session.sessionKey,
      to: 1,
      createdBy: ACTOR,
    });

    const runs = await listBrowserFlowRuns(ctx, { flowId: flow.id, limit: 5 });
    expect(runs).toHaveLength(0);

    await closeBrowserSession(ctx, session.sessionKey).catch(() => undefined);
  }, 120_000);
});

describe.skipIf(!chromiumAvailable())('background run', () => {
  it('returns immediately and lets a caller watch step results land one at a time', async () => {
    const flow = await createBrowserFlow(ctx, {
      name: 'Background watch',
      browserId,
      status: 'active',
      createdBy: ACTOR,
      steps: [
        { action: { type: 'goto', url: baseUrl } },
        { action: { type: 'wait', ms: 150 } },
        { action: { type: 'extract', role: 'heading', name: 'Expense Portal' }, captureAs: 'title' },
      ],
    });

    const started = await startBrowserFlowRun(ctx, flow.key, { createdBy: ACTOR });
    expect(started.status).toBe('running');
    expect(started.stepResults ?? []).toHaveLength(0);

    let sawPartialProgress = false;
    let polled = started;
    const deadline = Date.now() + 30_000;
    while (polled.status === 'running') {
      if ((polled.stepResults?.length ?? 0) > 0) sawPartialProgress = true;
      if (Date.now() > deadline) throw new Error('Run did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const next = await getBrowserFlowRun(ctx, started.id);
      if (!next) throw new Error('Run disappeared while polling');
      polled = next;
    }

    expect(polled.status).toBe('succeeded');
    expect(polled.stepResults?.length).toBe(3);
    expect(polled.outputs?.title).toBe('Expense Portal');
    // The 150ms wait step gives the 20ms poll loop room to observe the run
    // mid-flight — this is what actually distinguishes background execution
    // from a run that merely reports `running` and then finishes atomically.
    expect(sawPartialProgress).toBe(true);
  }, 60_000);

  it('keeps a backgrounded run correctly tenant-scoped despite concurrent activity from another tenant', async () => {
    const flow = await createBrowserFlow(ctx, {
      name: 'Tenant isolation under background run',
      browserId,
      status: 'active',
      createdBy: ACTOR,
      steps: [
        { action: { type: 'goto', url: baseUrl } },
        { action: { type: 'wait', ms: 200 } },
        { action: { type: 'extract', role: 'heading', name: 'Expense Portal' }, captureAs: 'title' },
      ],
    });

    // Set up tenant 2 up front — a bare (unscoped) `switchToTenant` call is
    // racy against ANY concurrent tenant regardless of this test, so this
    // step happens before either tenant has anything running concurrently.
    const browser2 = await createBrowser(ctx2, {
      name: 'Tenant 2 browser',
      createdBy: ACTOR,
      defaultSessionConfig: { headless: true },
    });
    const flow2 = await createBrowserFlow(ctx2, {
      name: 'Tenant 2 flow',
      browserId: browser2.id,
      status: 'active',
      createdBy: ACTOR,
      steps: [{ action: { type: 'goto', url: baseUrl } }],
    });

    const started = await startBrowserFlowRun(ctx, flow.key, { createdBy: ACTOR });
    expect(started.status).toBe('running');

    // While tenant 1's run continues in the background, drive tenant 2 through
    // the same `runWithTenantScope` binding a real dashboard request gets from
    // `withApiRequestContext` — this is the concurrency `startBrowserFlowRun`
    // has to survive: two ALS-scoped tenants racing the same process-global
    // `switchToTenant` fallback underneath.
    await runWithTenantScope(ctx2.tenantDbName, () => runBrowserFlow(ctx2, flow2.key, { createdBy: ACTOR }));
    await runWithTenantScope(ctx2.tenantDbName, () => runBrowserFlow(ctx2, flow2.key, { createdBy: ACTOR }));

    const finalRun = await awaitRunTerminal(ctx, started.id);
    expect(finalRun.status).toBe('succeeded');
    expect(finalRun.tenantId).toBe(TENANT_ID);
    expect(finalRun.outputs?.title).toBe('Expense Portal');

    // And it must be invisible from tenant 2 — proof it never landed there.
    const crossTenantLookup = await getBrowserFlowRun(ctx2, started.id);
    expect(crossTenantLookup).toBeNull();
  }, 60_000);
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
