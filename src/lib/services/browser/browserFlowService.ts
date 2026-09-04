/**
 * BrowserFlowService — the replayable half of browser automation.
 *
 * WHY THIS EXISTS
 *
 * Driving a browser with an agent conflates two jobs that have nothing in
 * common. DISCOVERY is a model reading a page it has never seen, guessing at
 * a control, backtracking, and paying tokens for every step. EXECUTION is
 * doing again what discovery already worked out. Binding browser tools to an
 * agent makes every run a discovery run: the same nightly task costs the same
 * as the first time it was solved, takes as long, and fails in a new way each
 * night — which is the opposite of what anyone replacing an RPA tool wants.
 *
 * A Flow separates them. Discovery happens once, live, with an agent (or a
 * person) driving a session; `recordBrowserFlow` turns that session's event
 * log into an ordered step list. From then on `runBrowserFlow` walks the list
 * with no model in the loop at all: deterministic, cheap, and diffable.
 *
 * WHAT MAKES A STEP REPLAYABLE
 *
 * Only its target. A live session addresses elements by the aria `ref` from
 * its last snapshot — a marker Playwright renumbers on the very next
 * snapshot. Stored, a ref is worse than nothing: it looks valid and then
 * spends the step's whole timeout resolving to no element. So recording
 * substitutes the DURABLE descriptor the manager stamped onto each event
 * (`role` + `name`, a test-id) and `validation.ts` rejects any step that
 * still carries a ref.
 *
 * WHAT NEVER GETS RECORDED
 *
 * Typed values. Every `type` step becomes `{{input.<name>}}` with a declared
 * flow input, because the recorder cannot tell a search term from a password
 * and only one of those mistakes is recoverable. Non-secret inputs get a
 * default in the editor afterwards; secrets are supplied per run and are
 * never persisted on the run record.
 */

import { randomUUID } from 'node:crypto';
import slugify from 'slugify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type {
  IBrowserFlow,
  IBrowserFlowInput,
  IBrowserFlowRun,
  IBrowserFlowStep,
  IBrowserFlowStepResult,
  IBrowserSessionEvent,
} from '@/lib/database';
import { recordUsageEvent, resolveUsageAttribution } from '@/lib/services/usage/usageEvents';
import { resolveBrowser } from './browserProfileService';
import {
  captureScreenshot,
  closeBrowserSession,
  createBrowserSession,
  extractFromBrowser,
  runBrowserAction,
} from './browserSessionService';
import { matchesProjectScope } from './internals';
import type {
  BrowserAction,
  BrowserFlowRunView,
  BrowserFlowView,
  CreateBrowserFlowInput,
  RunBrowserFlowInput,
  RecordBrowserFlowInput,
  UpdateBrowserFlowInput,
} from './types';

const logger = createLogger('browser:flow-service');

/** Read-only actions carry no state change, so a recording drops them. */
const NON_REPLAYABLE_EVENT_TYPES = new Set([
  'create',
  'close',
  'snapshot',
  'screenshot',
  'pdf',
  'tool_call',
  'agent_event',
  'error',
]);

const KEY_OPTIONS = { lower: true, strict: true, trim: true };

interface FlowContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
}

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function serializeFlow(record: IBrowserFlow): BrowserFlowView {
  const { _id, ...rest } = record;
  return { ...rest, id: typeof _id === 'string' ? _id : _id?.toString() ?? '' };
}

function serializeRun(record: IBrowserFlowRun): BrowserFlowRunView {
  const { _id, ...rest } = record;
  return { ...rest, id: typeof _id === 'string' ? _id : _id?.toString() ?? '' };
}

function canAccess(ctx: FlowContext, record: { tenantId: string; projectId?: string } | null | undefined): boolean {
  return Boolean(
    record
    && record.tenantId === ctx.tenantId
    && matchesProjectScope(record.projectId, ctx.projectId),
  );
}

async function generateUniqueFlowKey(
  db: DatabaseProvider,
  tenantId: string,
  desired: string | undefined,
  projectId?: string,
): Promise<string> {
  const base = slugify(desired?.trim() || 'flow', KEY_OPTIONS) || 'flow';
  let candidate = base;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const existing = await db.findBrowserFlowByKey(tenantId, candidate, projectId);
    if (!existing) return candidate;
    candidate = `${base}-${attempt + 2}`;
  }
  throw new Error('Could not generate unique flow key');
}

// ── CRUD ─────────────────────────────────────────────────────────────────

export async function createBrowserFlow(
  ctx: FlowContext,
  input: CreateBrowserFlowInput,
): Promise<BrowserFlowView> {
  const db = await withTenantDb(ctx.tenantDbName);
  const browser = await resolveBrowser(ctx, input.browserId);
  if (!browser) {
    throw new Error(`Browser not found: ${input.browserId}`);
  }

  const key = await generateUniqueFlowKey(db, ctx.tenantId, input.key ?? input.name, ctx.projectId);
  const created = await db.createBrowserFlow({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    key,
    name: input.name,
    description: input.description,
    status: input.status ?? 'draft',
    browserId: String(browser._id ?? ''),
    inputs: input.inputs,
    steps: normalizeSteps(input.steps ?? []),
    sessionConfig: input.sessionConfig,
    recordedFromSessionId: input.recordedFromSessionId,
    version: 1,
    metadata: input.metadata,
    createdBy: input.createdBy,
  });
  logger.info('Browser flow created', { flowId: created._id, key, steps: created.steps.length });
  return serializeFlow(created);
}

export async function updateBrowserFlow(
  ctx: FlowContext,
  idOrKey: string,
  input: UpdateBrowserFlowInput,
): Promise<BrowserFlowView | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const existing = await resolveFlowRecord(ctx, idOrKey);
  if (!existing) return null;

  const patch: Partial<IBrowserFlow> = {
    name: input.name,
    description: input.description,
    status: input.status,
    inputs: input.inputs,
    sessionConfig: input.sessionConfig,
    metadata: input.metadata,
    updatedBy: input.updatedBy,
  };

  if (input.browserId) {
    const browser = await resolveBrowser(ctx, input.browserId);
    if (!browser) throw new Error(`Browser not found: ${input.browserId}`);
    patch.browserId = String(browser._id ?? '');
  }

  // The version pins what a run executed, so it moves only when the STEPS
  // move — renaming a flow must not invalidate the history of what ran.
  if (input.steps) {
    patch.steps = normalizeSteps(input.steps);
    patch.version = (existing.version ?? 1) + 1;
  }

  const updated = await db.updateBrowserFlow(String(existing._id ?? ''), patch);
  return updated ? serializeFlow(updated) : null;
}

export async function deleteBrowserFlow(ctx: FlowContext, idOrKey: string): Promise<boolean> {
  const db = await withTenantDb(ctx.tenantDbName);
  const existing = await resolveFlowRecord(ctx, idOrKey);
  if (!existing) return false;
  return db.deleteBrowserFlow(String(existing._id ?? ''));
}

export async function getBrowserFlow(
  ctx: FlowContext,
  idOrKey: string,
): Promise<BrowserFlowView | null> {
  const record = await resolveFlowRecord(ctx, idOrKey);
  return record ? serializeFlow(record) : null;
}

export async function listBrowserFlows(
  ctx: FlowContext,
  filters?: { status?: string; browserId?: string; search?: string },
): Promise<BrowserFlowView[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  const records = await db.listBrowserFlows(ctx.tenantId, {
    projectId: ctx.projectId,
    ...filters,
  });
  return records.map(serializeFlow);
}

export async function listBrowserFlowRuns(
  ctx: FlowContext,
  filters?: { flowId?: string; status?: string; limit?: number; skip?: number },
): Promise<BrowserFlowRunView[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  const records = await db.listBrowserFlowRuns(ctx.tenantId, {
    projectId: ctx.projectId,
    ...filters,
  });
  return records.map(serializeRun);
}

export async function getBrowserFlowRun(
  ctx: FlowContext,
  runId: string,
): Promise<BrowserFlowRunView | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const record = await db.findBrowserFlowRunById(runId);
  if (!canAccess(ctx, record)) return null;
  return record ? serializeRun(record) : null;
}

async function resolveFlowRecord(
  ctx: FlowContext,
  idOrKey: string,
): Promise<IBrowserFlow | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const record =
    (await db.findBrowserFlowById(idOrKey).catch(() => null))
    ?? (await db.findBrowserFlowByKey(ctx.tenantId, idOrKey, ctx.projectId));
  return canAccess(ctx, record) ? record : null;
}

/** Give every step an id, so run results stay attributable across edits. */
function normalizeSteps(steps: Array<Partial<IBrowserFlowStep>>): IBrowserFlowStep[] {
  return steps.map((step, index) => ({
    id: step.id?.trim() || `s${index + 1}_${randomUUID().slice(0, 8)}`,
    label: step.label ?? describeAction(step.action ?? {}),
    action: step.action ?? {},
    captureAs: step.captureAs,
    policy: step.policy,
    when: step.when,
  }));
}

// ── Recording ────────────────────────────────────────────────────────────

/**
 * Turn a session's event log into a replayable flow.
 *
 * The session does not have to have been driven by an agent — a person
 * clicking through the live preview produces the same events. What matters
 * is that each event carries the `resolvedTarget` the manager stamped on it;
 * events without one came from a selector the caller supplied directly, which
 * is already durable.
 */
export async function recordBrowserFlow(
  ctx: FlowContext,
  input: RecordBrowserFlowInput,
): Promise<BrowserFlowView> {
  const db = await withTenantDb(ctx.tenantDbName);
  const session = await db.findBrowserSessionById(input.sessionId);
  if (!canAccess(ctx, session) || !session) {
    throw new Error(`Browser session not found: ${input.sessionId}`);
  }

  const events = await db.listBrowserSessionEvents(input.sessionId, { limit: 5000 });
  const excluded = new Set([...NON_REPLAYABLE_EVENT_TYPES, ...(input.excludeTypes ?? [])]);

  const steps: IBrowserFlowStep[] = [];
  const inputs: IBrowserFlowInput[] = [];
  let skipped = 0;

  for (const event of events) {
    if (excluded.has(event.type)) continue;
    // A failed step is not evidence of how the task is done — replaying it
    // would only reproduce the failure.
    if (event.status === 'error') {
      skipped += 1;
      continue;
    }

    const step = stepFromEvent(event, inputs);
    if (!step) {
      skipped += 1;
      continue;
    }
    steps.push(step);
  }

  if (steps.length === 0) {
    throw new Error(
      'Nothing replayable in this session. Drive the browser first (navigate, click, type), then record.',
    );
  }

  logger.info('Recorded browser flow from session', {
    sessionId: input.sessionId,
    steps: steps.length,
    skipped,
    inputs: inputs.length,
  });

  return createBrowserFlow(ctx, {
    key: input.key,
    name: input.name,
    description: input.description,
    // A recording lands as a draft: it was derived from one observed run and
    // deserves a read before anything schedules it.
    status: input.status ?? 'draft',
    browserId: session.browserId,
    inputs,
    steps,
    recordedFromSessionId: input.sessionId,
    createdBy: input.createdBy,
  });
}

/**
 * One event -> one step, or `null` when the event cannot stand on its own.
 *
 * `inputs` is appended to in place: every typed value becomes a declared flow
 * parameter rather than a literal, because the recorder has no way to know
 * whether it just watched someone type a search term or a password.
 */
function stepFromEvent(
  event: IBrowserSessionEvent,
  inputs: IBrowserFlowInput[],
): IBrowserFlowStep | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const resolved = data.resolvedTarget as Record<string, unknown> | undefined;

  const action: Record<string, unknown> = { type: event.type };

  switch (event.type) {
    case 'goto': {
      const url = typeof data.url === 'string' ? data.url : event.url;
      if (!url) return null;
      action.url = url;
      if (typeof data.waitUntil === 'string') action.waitUntil = data.waitUntil;
      break;
    }
    case 'back':
    case 'forward':
    case 'reload':
      break;
    case 'wait': {
      if (typeof data.ms === 'number') action.ms = data.ms;
      else if (typeof data.selector === 'string') action.selector = data.selector;
      else if (typeof data.text === 'string') action.text = data.text;
      else if (typeof data.loadState === 'string') action.loadState = data.loadState;
      else return null;
      if (typeof data.state === 'string') action.state = data.state;
      break;
    }
    case 'tab': {
      if (typeof data.op !== 'string') return null;
      action.op = data.op;
      if (typeof data.index === 'number') action.index = data.index;
      if (typeof data.url === 'string') action.url = data.url;
      break;
    }
    case 'click':
    case 'hover':
    case 'press':
    case 'check':
    case 'select':
    case 'scroll':
    case 'type': {
      const target = durableTargetFromEvent(resolved, event);
      if (!target) return null;
      Object.assign(action, target);

      if (event.type === 'press' && typeof data.key === 'string') action.key = data.key;
      if (event.type === 'click' && typeof data.button === 'string') action.button = data.button;
      if (event.type === 'check' && typeof data.checked === 'boolean') action.checked = data.checked;
      if (event.type === 'select') {
        if (Array.isArray(data.values)) action.values = data.values;
        else if (Array.isArray(data.labels)) action.labels = data.labels;
        else return null;
      }
      if (event.type === 'scroll') {
        if (typeof data.x === 'number') action.x = data.x;
        if (typeof data.y === 'number') action.y = data.y;
      }
      if (event.type === 'type') {
        // The event only holds `[redacted:N chars]`, and that is the point:
        // the value never reached storage. Promote it to a parameter.
        const name = uniqueInputName(inputs, target);
        inputs.push({
          name,
          label: describeTarget(target),
          type: 'string',
          required: true,
          description: `Value typed into ${describeTarget(target)} while recording.`,
        });
        action.text = `{{input.${name}}}`;
        if (data.clear === true) action.clear = true;
        if (data.submit === true) action.submit = true;
      }
      break;
    }
    case 'extract': {
      const target = durableTargetFromEvent(resolved, event);
      if (!target) return null;
      Object.assign(action, target);
      if (typeof data.mode === 'string') action.mode = data.mode;
      if (typeof data.attribute === 'string') action.attribute = data.attribute;
      if (data.multiple === true) action.multiple = true;
      break;
    }
    // `upload` and `drag` reference per-run files and two targets; recording
    // them from the log alone would produce a step that cannot be replayed
    // honestly, so they are added in the editor instead.
    default:
      return null;
  }

  return {
    id: `s${event.sequence}_${randomUUID().slice(0, 8)}`,
    label: describeAction(action),
    action,
  };
}

function durableTargetFromEvent(
  resolved: Record<string, unknown> | undefined,
  event: IBrowserSessionEvent,
): Record<string, unknown> | null {
  if (resolved && Object.keys(resolved).length > 0) return { ...resolved };
  // No resolved descriptor means the caller addressed the element directly.
  // A selector is durable enough to keep; a bare ref is not.
  if (event.selector) return { selector: event.selector };
  return null;
}

function uniqueInputName(inputs: IBrowserFlowInput[], target: Record<string, unknown>): string {
  const base = slugify(
    String(target.name ?? target.label ?? target.placeholder ?? target.testId ?? 'field'),
    { lower: true, strict: true, trim: true },
  ).replace(/-/g, '_') || 'field';
  const safe = /^[A-Za-z_]/.test(base) ? base : `f_${base}`;
  let candidate = safe;
  let n = 2;
  while (inputs.some((item) => item.name === candidate)) {
    candidate = `${safe}_${n}`;
    n += 1;
  }
  return candidate;
}

function describeTarget(target: Record<string, unknown>): string {
  if (target.name) return `${target.role ?? 'element'} "${target.name}"`;
  if (target.testId) return `testId=${target.testId}`;
  if (target.label) return `label "${target.label}"`;
  if (target.placeholder) return `placeholder "${target.placeholder}"`;
  if (target.text) return `text "${target.text}"`;
  if (target.selector) return String(target.selector);
  return String(target.role ?? 'element');
}

function describeAction(action: Record<string, unknown>): string {
  const type = String(action.type ?? 'step');
  if (type === 'goto') return `Go to ${action.url}`;
  if (type === 'wait') return action.ms ? `Wait ${action.ms}ms` : 'Wait';
  if (type === 'back' || type === 'forward' || type === 'reload') return `Navigate ${type}`;
  if (type === 'tab') return `Tab ${action.op}`;
  const target = describeTarget(action);
  if (type === 'type') return `Type into ${target}`;
  if (type === 'click') return `Click ${target}`;
  if (type === 'select') return `Select in ${target}`;
  if (type === 'check') return `${action.checked === false ? 'Uncheck' : 'Check'} ${target}`;
  if (type === 'extract') return `Read ${target}`;
  return `${type} ${target}`;
}

// ── Replay ───────────────────────────────────────────────────────────────

/**
 * Execute a flow's steps in order against a fresh session.
 *
 * No model is involved. Each step is resolved, retried per its own policy,
 * and recorded; the run aborts at the first non-optional failure with the
 * failing index, a message and a screenshot, because a half-finished form is
 * usually worse than an untouched one.
 */
export async function runBrowserFlow(
  ctx: FlowContext,
  idOrKey: string,
  input: RunBrowserFlowInput,
): Promise<BrowserFlowRunView> {
  const db = await withTenantDb(ctx.tenantDbName);
  const flow = await resolveFlowRecord(ctx, idOrKey);
  if (!flow) throw new Error(`Browser flow not found: ${idOrKey}`);
  if (flow.status === 'disabled') throw new Error(`Browser flow ${flow.key} is disabled`);
  if (!flow.steps.length) throw new Error(`Browser flow ${flow.key} has no steps`);

  const bindings = resolveInputBindings(flow, input.inputs ?? {});
  const attribution = resolveUsageAttribution();

  const run = await db.createBrowserFlowRun({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    flowId: String(flow._id ?? ''),
    flowKey: flow.key,
    flowVersion: flow.version ?? 1,
    status: 'running',
    trigger: input.trigger ?? 'manual',
    // Secrets are dropped here, not masked: a masked secret still tells a
    // reader how long it was and that it existed on this run.
    inputs: bindings.persistable,
    startedAt: new Date(),
    createdBy: input.createdBy,
  });
  const runId = String(run._id ?? '');

  let sessionKey: string | undefined;
  const stepResults: IBrowserFlowStepResult[] = [];
  const outputs: Record<string, unknown> = {};
  let failedStepIndex: number | undefined;
  let errorMessage: string | undefined;

  try {
    const session = await createBrowserSession(ctx, {
      browserId: flow.browserId,
      name: `flow:${flow.key}`,
      config: flow.sessionConfig,
      metadata: { source: 'browser-flow', flowKey: flow.key, runId },
      createdBy: input.createdBy,
    });
    sessionKey = session.sessionKey;
    await db.updateBrowserFlowRun(runId, { sessionId: session.id, sessionKey: session.sessionKey });

    const limit = Math.min(input.maxSteps ?? flow.steps.length, flow.steps.length);

    for (let index = 0; index < limit; index += 1) {
      const step = flow.steps[index];
      const result = await executeStep(ctx, sessionKey, step, index, bindings.all, outputs);
      stepResults.push(result);

      if (result.status === 'failed') {
        failedStepIndex = index;
        errorMessage = result.errorMessage
          ?? `Step ${index + 1} (${step.label ?? step.id}) failed`;
        break;
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    // A failed run keeps its session when asked, so the operator can open the
    // live preview and see the page the flow actually reached.
    if (sessionKey && !(input.keepSessionOpen && errorMessage)) {
      await closeBrowserSession(ctx, sessionKey).catch(() => undefined);
    }
  }

  const endedAt = new Date();
  const startedAt = run.startedAt ?? endedAt;
  const durationMs = endedAt.getTime() - startedAt.getTime();
  const status: IBrowserFlowRun['status'] = errorMessage ? 'failed' : 'succeeded';

  const updated = await db.updateBrowserFlowRun(runId, {
    status,
    stepResults,
    outputs,
    endedAt,
    durationMs,
    errorMessage,
    failedStepIndex,
  });

  await db.updateBrowserFlow(String(flow._id ?? ''), {
    lastRun: { runId, status, startedAt, durationMs },
  }).catch(() => undefined);

  recordUsageEvent({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    service: 'browser',
    refKey: flow.key,
    status: status === 'succeeded' ? 'success' : 'error',
    attribution: {
      userId: attribution.userId,
      apiTokenId: attribution.apiTokenId,
      actorType: attribution.actorType,
    },
  });

  logger.info('Browser flow run finished', {
    flowKey: flow.key,
    runId,
    status,
    steps: stepResults.length,
    durationMs,
  });

  return serializeRun(updated ?? { ...run, status, stepResults, outputs, endedAt, durationMs, errorMessage, failedStepIndex });
}

async function executeStep(
  ctx: FlowContext,
  sessionKey: string,
  step: IBrowserFlowStep,
  index: number,
  bindings: Record<string, unknown>,
  outputs: Record<string, unknown>,
): Promise<IBrowserFlowStepResult> {
  const policy = step.policy ?? {};
  const attemptsAllowed = (policy.retries ?? 0) + 1;
  const started = Date.now();

  const resolvedAction = substitute(step.action, bindings, outputs) as unknown as BrowserAction;
  const base: IBrowserFlowStepResult = {
    stepId: step.id,
    index,
    status: 'failed',
    attempts: 0,
    action: redactStepAction(step.action),
  };

  if (step.when && !truthy(substituteString(step.when, bindings, outputs))) {
    return { ...base, status: 'skipped', attempts: 0, durationMs: 0 };
  }

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    try {
      if ((resolvedAction as { type: string }).type === 'extract') {
        const extracted = await extractFromBrowser(
          ctx,
          sessionKey,
          resolvedAction as never,
        );
        if (!extracted.ok) throw new Error(extracted.errorMessage ?? 'Extraction failed');
        const captured = extracted.values.length === 1 ? extracted.values[0] : extracted.values;
        if (step.captureAs) outputs[step.captureAs] = captured;
        return {
          ...base,
          status: 'succeeded',
          attempts: attempt,
          durationMs: Date.now() - started,
          captured,
        };
      }

      const result = await runBrowserAction(ctx, sessionKey, {
        ...resolvedAction,
        ...(policy.timeoutMs ? { timeout: policy.timeoutMs } : {}),
      } as BrowserAction);

      if (!result.ok) throw new Error(result.errorMessage ?? 'Action failed');
      if (step.captureAs) outputs[step.captureAs] = result.url;

      return {
        ...base,
        status: 'succeeded',
        attempts: attempt,
        durationMs: Date.now() - started,
        url: result.url,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < attemptsAllowed) {
        // Exponential, because the usual cause of a retryable step failure is
        // a page that has not finished settling — waiting the same short
        // interval again mostly just spends the retry budget.
        const delay = (policy.retryDelayMs ?? 500) * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
      }
    }
  }

  // Failure evidence: what the page looked like when the step gave up. This
  // is the single most useful artifact when a flow that ran for months breaks
  // because a button moved.
  let artifact: IBrowserFlowStepResult['artifact'];
  try {
    const shot = await captureScreenshot(ctx, sessionKey, {
      fullPage: false,
      createdBy: 'browser-flow',
    });
    artifact = {
      bucketKey: shot.artifact.bucketKey,
      fileId: shot.artifact.fileId,
      objectKey: shot.artifact.objectKey,
      contentType: shot.artifact.contentType,
    };
  } catch {
    // Screenshot is best-effort; a session that already died cannot give one.
  }

  if (policy.optional) {
    return {
      ...base,
      status: 'skipped',
      attempts: attemptsAllowed,
      durationMs: Date.now() - started,
      errorMessage: lastError,
      artifact,
    };
  }

  return {
    ...base,
    status: 'failed',
    attempts: attemptsAllowed,
    durationMs: Date.now() - started,
    errorMessage: lastError,
    artifact,
  };
}

// ── Input binding ────────────────────────────────────────────────────────

interface InputBindings {
  /** Every value, including secrets — used only in memory during the run. */
  all: Record<string, unknown>;
  /** Non-secret values, safe to write onto the run record. */
  persistable: Record<string, unknown>;
}

function resolveInputBindings(
  flow: IBrowserFlow,
  supplied: Record<string, unknown>,
): InputBindings {
  const all: Record<string, unknown> = {};
  const persistable: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const declared of flow.inputs ?? []) {
    const value = supplied[declared.name] ?? declared.default;
    if (value === undefined || value === '') {
      if (declared.required) missing.push(declared.name);
      continue;
    }
    all[declared.name] = value;
    if (declared.type !== 'secret') persistable[declared.name] = value;
  }

  if (missing.length > 0) {
    throw new Error(`Missing required flow input(s): ${missing.join(', ')}`);
  }

  return { all, persistable };
}

/** Replace `{{input.x}}` / `{{step.y}}` inside every string of a payload. */
function substitute(
  value: unknown,
  bindings: Record<string, unknown>,
  outputs: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') return substituteString(value, bindings, outputs);
  if (Array.isArray(value)) return value.map((item) => substitute(item, bindings, outputs));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substitute(item, bindings, outputs);
    }
    return out;
  }
  return value;
}

function substituteString(
  template: string,
  bindings: Record<string, unknown>,
  outputs: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{\s*(input|step)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (whole, scope: string, name: string) => {
      const source = scope === 'input' ? bindings : outputs;
      const value = source[name];
      // An unresolved placeholder is left ALONE rather than blanked: typing
      // an empty string into a required field looks like a page problem,
      // while the literal `{{input.x}}` names the flow's actual defect.
      return value === undefined ? whole : String(value);
    },
  );
}

function truthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== 'false' && normalized !== '0' && normalized !== 'undefined';
}

/**
 * What the run record stores about a step's action.
 *
 * The step's own text is a `{{input.x}}` placeholder, not a value, so this
 * mostly passes through — but a hand-written step CAN carry a literal, and a
 * run record is read by more people than the flow definition is.
 */
function redactStepAction(action: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...action };
  if (typeof clone.text === 'string' && !clone.text.includes('{{')) {
    clone.text = `[literal:${clone.text.length} chars]`;
  }
  return clone;
}
