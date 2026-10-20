/**
 * The reminder tools (agentReminderTools.ts): the time window, the prompt, and
 * the rule for a reminder set after the run read outside content — refused,
 * asked about or let through per `afterUntrustedContent` and who can answer,
 * with the re-arm of the waking reminder always allowed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTool } from '@cognipeer/agent-sdk';
import { z } from 'zod';

const hoisted = vi.hoisted(() => ({ scheduleReminder: vi.fn(), listReminders: vi.fn(), cancelReminder: vi.fn() }));
vi.mock('@/lib/services/agents/agentReminders', () => ({
  scheduleReminder: hoisted.scheduleReminder,
  listReminders: hoisted.listReminders,
  cancelReminder: hoisted.cancelReminder,
  reminderFireAt: (run: { notBefore?: Date }) => run.notBefore ?? null,
  REMINDER_META: { reason: 'reminder_reason', setByRun: 'reminder_set_by_run', chain: 'reminder_chain' },
}));

import {
  buildReminderTools,
  reminderApprovalMode,
  reminderNoteText,
  remindersPrompt,
  resolveFireAt,
  type ReminderToolDeps,
} from '@/lib/services/agents/agentReminderTools';
import { resolveRemindersConfig, type ResolvedRemindersConfig } from '@/lib/services/agents/agentRemindersConfig';

const settings = (over: Partial<ResolvedRemindersConfig> = {}): ResolvedRemindersConfig => ({
  ...resolveRemindersConfig({ enabled: true }),
  ...over,
});

const NOW = Date.parse('2026-10-19T12:00:00Z');

function build(over: Partial<ReminderToolDeps> = {}) {
  return buildReminderTools({
    createToolFn: createTool,
    zod: z,
    guard: { protect: (_spec, execute) => execute },
    scope: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' },
    agentKey: 'ops',
    conversationId: 'conv-1',
    agentConfig: {},
    settings: settings(),
    creator: { userId: 'user-1', runId: 'run-1' },
    startsTainted: false,
    approvalMode: 'ask',
    ...over,
  });
}

type CallableTool = { name: string; func?: (args: Record<string, unknown>) => Promise<unknown>; invoke?: (args: Record<string, unknown>) => Promise<unknown>; needsApproval?: unknown };
const call = (tool: CallableTool, args: Record<string, unknown>) => (tool.func ?? tool.invoke)!(args);
const toolNamed = (tools: CallableTool[], name: string) => tools.find((tool) => tool.name === name)!;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.scheduleReminder.mockResolvedValue({ ok: true, run: { _id: 'rem-9' } });
});

describe('resolveFireAt', () => {
  const window = { minDelaySeconds: 60, maxHorizonHours: 2 };

  it('wants delay_seconds or at', () => {
    expect(resolveFireAt({}, window, NOW)).toEqual({ error: 'Give delay_seconds or at.' });
    expect(resolveFireAt({ delay_seconds: null, at: '  ' }, window, NOW)).toEqual({ error: 'Give delay_seconds or at.' });
  });

  // Strict tool calling (OpenAI, Azure) sends every argument: what gpt-5.6-terra sent for a clock time and for a delay.
  it('with both given, a usable at wins; an empty or unparseable at leaves delay_seconds', () => {
    expect(resolveFireAt({ delay_seconds: 1, at: '2026-10-19T13:00:00Z' }, window, NOW)).toEqual({ at: new Date('2026-10-19T13:00:00Z') });
    expect(resolveFireAt({ delay_seconds: 60, at: '2026-10-19T13:00:00Z' }, window, NOW)).toEqual({ at: new Date('2026-10-19T13:00:00Z') });
    expect(resolveFireAt({ delay_seconds: 600, at: '' }, window, NOW)).toEqual({ at: new Date(NOW + 600_000) });
    expect(resolveFireAt({ delay_seconds: 600, at: 'none' }, window, NOW)).toEqual({ at: new Date(NOW + 600_000) });
    // An at outside the window is the time asked for: it is refused, not swapped for the filler delay.
    expect(resolveFireAt({ delay_seconds: 120, at: '2026-10-19T18:00:00Z' }, window, NOW)).toEqual({ error: expect.stringContaining('at most 2 hour') });
  });

  it('keeps the time inside [min delay, horizon]', () => {
    expect(resolveFireAt({ delay_seconds: 30 }, window, NOW)).toEqual({ error: expect.stringContaining('at least 1 minute') });
    expect(resolveFireAt({ delay_seconds: 3 * 3600 }, window, NOW)).toEqual({ error: expect.stringContaining('at most 2 hour') });
    expect(resolveFireAt({ at: 'tomorrow' }, window, NOW)).toEqual({ error: expect.stringContaining('ISO 8601') });
    expect(resolveFireAt({ delay_seconds: 600 }, window, NOW)).toEqual({ at: new Date(NOW + 600_000) });
    expect(resolveFireAt({ at: '2026-10-19T13:00:00Z' }, window, NOW)).toEqual({ at: new Date('2026-10-19T13:00:00Z') });
  });
});

describe('prompt and note', () => {
  it('names the tools, the limits, the waking reminder and the author\'s instructions', () => {
    const text = remindersPrompt(settings({ instructions: 'Only for deployments.' }), { runId: 'run_r1', message: 'check', setAt: 'x', chain: 1 });
    expect(text).toContain('## Reminders');
    expect(text).toContain('reminder_set');
    expect(text).toContain('reminder_list');
    expect(text).toContain('72 hour(s)');
    expect(text).toContain('run_r1');
    expect(text).toContain('Only for deployments.');
  });

  it('frames the wake turn as the agent\'s own note', () => {
    expect(reminderNoteText({ setAt: '2026-10-19T12:00:00.000Z', message: 'Check the deploy.' }))
      .toBe('[Reminder] You scheduled this for yourself at 2026-10-19T12:00:00.000Z. It is your own earlier note, not a new message from the user:\nCheck the deploy.');
  });
});

describe('reminderApprovalMode', () => {
  it('asks on an interactive run, follows humanInTheLoop.unattended otherwise', () => {
    expect(reminderApprovalMode({ unattended: 'deny' }, {})).toBe('ask');
    expect(reminderApprovalMode({ unattended: 'deny' }, { canPause: false })).toBe('deny');
    expect(reminderApprovalMode({ unattended: 'deny' }, { unattended: true })).toBe('deny');
    expect(reminderApprovalMode({ unattended: 'pause' }, { unattended: true })).toBe('ask');
    expect(reminderApprovalMode({ unattended: 'allow' }, { unattended: true })).toBe('allow');
  });
});

describe('reminder_set', () => {
  it('schedules with the creator, the reason and the chain of the waking reminder', async () => {
    const built = build({ wake: { runId: 'run_r0', message: 'old', setAt: 'x', chain: 2 } });
    const result = await call(toolNamed(built.tools as CallableTool[], 'reminder_set'), { delay_seconds: 600, message: '  Check the deploy.  ', reason: 'deploy' });
    expect(JSON.parse(String(result))).toMatchObject({ id: 'run_rem-9', status: 'scheduled' });
    expect(hoisted.scheduleReminder).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: 'ops',
      conversationId: 'conv-1',
      message: 'Check the deploy.',
      reason: 'deploy',
      creator: expect.objectContaining({ userId: 'user-1', runId: 'run-1', wokenChain: 2 }),
    }));
  });

  it('returns the refusal as text and never throws', async () => {
    hoisted.scheduleReminder.mockResolvedValue({ ok: false, reason: 'This session already has 3 reminder(s) waiting.' });
    const built = build();
    const set = toolNamed(built.tools as CallableTool[], 'reminder_set');
    expect(await call(set, { delay_seconds: 600, message: 'x' })).toContain('already has 3');
    expect(await call(set, { delay_seconds: 600, message: '' })).toBe('message is required.');
    expect(await call(set, { delay_seconds: 600, message: 'x'.repeat(1001) })).toContain('too long');
  });
});

describe('after outside content', () => {
  const read = { name: 'web_fetch', func: vi.fn(async () => 'page text') };

  it('deny: refused once any other tool returned, fine before', async () => {
    const built = build({ settings: settings({ afterUntrustedContent: 'deny' }) });
    const set = toolNamed(built.tools as CallableTool[], 'reminder_set');
    expect(await call(set, { delay_seconds: 600, message: 'first' })).toContain('run_rem-9');
    const [watched] = built.watchTools([read]);
    await watched.func();
    expect(await call(set, { delay_seconds: 600, message: 'second' })).toContain('Not set');
    expect(hoisted.scheduleReminder).toHaveBeenCalledTimes(1);
  });

  it('approve with nobody to ask: refused, saying an approval was needed', async () => {
    const built = build({ approvalMode: 'deny', startsTainted: true });
    const set = toolNamed(built.tools as CallableTool[], 'reminder_set');
    expect(await call(set, { delay_seconds: 600, message: 'new' })).toContain('needs a person to approve');
    expect(hoisted.scheduleReminder).not.toHaveBeenCalled();
  });

  it('approve on an interactive run: the call asks, the agent\'s own policy still counts', async () => {
    const built = build();
    const gated = built.gate(built.tools as CallableTool[]) as CallableTool[];
    const predicate = toolNamed(gated, 'reminder_set').needsApproval as (args: unknown) => boolean;
    expect(predicate({ message: 'x' })).toBe(false);
    built.noteSdkEvent({ type: 'tool_call', phase: 'success', name: 'knowledge_search' } as never);
    expect(predicate({ message: 'x' })).toBe(true);

    const policyAsks = build().gate([{ ...(build().tools[0] as CallableTool), needsApproval: () => true }]) as CallableTool[];
    expect((policyAsks[0].needsApproval as (args: unknown) => boolean)({ message: 'x' })).toBe(true);
  });

  it('the reminder tools themselves never count as outside content', async () => {
    const built = build({ settings: settings({ afterUntrustedContent: 'deny' }) });
    built.noteSdkEvent({ type: 'tool_call', phase: 'success', name: 'reminder_list' } as never);
    built.noteSdkEvent({ type: 'tool_call', phase: 'start', name: 'web_fetch' } as never);
    expect(await call(toolNamed(built.tools as CallableTool[], 'reminder_set'), { delay_seconds: 600, message: 'x' })).toContain('run_rem-9');
  });

  it('allow: set as asked', async () => {
    const built = build({ settings: settings({ afterUntrustedContent: 'allow' }), startsTainted: true, approvalMode: 'deny' });
    expect(await call(toolNamed(built.tools as CallableTool[], 'reminder_set'), { delay_seconds: 600, message: 'x' })).toContain('run_rem-9');
    expect(built.gate(built.tools as CallableTool[])).toEqual(built.tools);
  });

  it('re-arming the reminder that woke the run is not new content', async () => {
    const built = build({
      settings: settings({ afterUntrustedContent: 'deny' }),
      wake: { runId: 'run_r0', message: 'Poll the job status.', setAt: 'x', chain: 1 },
      startsTainted: true,
    });
    const set = toolNamed(built.tools as CallableTool[], 'reminder_set');
    expect(await call(set, { delay_seconds: 600, message: ' Poll the job status. ' })).toContain('run_rem-9');
    expect(await call(set, { delay_seconds: 600, message: 'Something else.' })).toContain('Not set');
  });
});

describe('reminder_list / reminder_cancel', () => {
  it('lists this session\'s waiting reminders, soonest first', async () => {
    hoisted.listReminders.mockResolvedValue([
      { _id: 'b', userMessage: 'later', notBefore: new Date('2026-10-19T15:00:00Z'), metadata: {} },
      { _id: 'a', userMessage: 'sooner', notBefore: new Date('2026-10-19T13:00:00Z'), metadata: { reminder_reason: 'r' } },
    ]);
    const built = build();
    const out = JSON.parse(String(await call(toolNamed(built.tools as CallableTool[], 'reminder_list'), {})));
    expect(out.map((r: { id: string }) => r.id)).toEqual(['run_a', 'run_b']);
    expect(out[0]).toMatchObject({ message: 'sooner', reason: 'r' });
    expect(hoisted.listReminders).toHaveBeenCalledWith(expect.anything(), { agentKey: 'ops', conversationId: 'conv-1', active: true, limit: 50 });
  });

  it('cancels only within the session and says when there is nothing to cancel', async () => {
    const built = build();
    const cancel = toolNamed(built.tools as CallableTool[], 'reminder_cancel');
    hoisted.cancelReminder.mockResolvedValueOnce({ kind: 'canceled', run: {} });
    expect(JSON.parse(String(await call(cancel, { id: 'run_a' })))).toEqual({ id: 'run_a', status: 'canceled' });
    expect(hoisted.cancelReminder).toHaveBeenCalledWith(expect.anything(), 'run_a', expect.objectContaining({ conversationId: 'conv-1', actor: expect.objectContaining({ via: 'agent' }) }));
    hoisted.cancelReminder.mockResolvedValueOnce({ kind: 'not_found' });
    expect(await call(cancel, { id: 'run_zz' })).toContain('No reminder');
  });
});
