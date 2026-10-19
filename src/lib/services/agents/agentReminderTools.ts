/**
 * The reminder tools an agent gets when `config.reminders` is on:
 * `reminder_set`, `reminder_list` and `reminder_cancel` (agentReminders.ts
 * holds what a reminder is).
 *
 * Untrusted content: once the run has read something from outside (any tool
 * result, external content in the message, a resumed pause), a new reminder
 * could carry an instruction planted there into a later turn that runs on its
 * own. Such a reminder follows `afterUntrustedContent`: `approve` asks a
 * person (or is refused where nobody can be asked), `deny` refuses it,
 * `allow` sets it. Re-arming the reminder that woke this run (the same
 * message) is not new content and is always allowed.
 */

import type { createTool as CreateSdkTool, SmartAgentEvent as AgentSdkEvent, ToolInterface as AgentSdkToolInterface } from '@cognipeer/agent-sdk';
import type { IAgentConfig } from '@/lib/database';
import type { RequestVia } from '@/lib/core/requestContext';
import type { TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';
import type { ResolvedHitlConfig } from './agentHumanInTheLoop';
import { REMINDER_MESSAGE_MAX_CHARS, REMINDER_REASON_MAX_CHARS, type ResolvedRemindersConfig } from './agentRemindersConfig';
import type { ReminderScope } from './agentReminders';

export const REMINDER_SET_TOOL = 'reminder_set';
export const REMINDER_LIST_TOOL = 'reminder_list';
export const REMINDER_CANCEL_TOOL = 'reminder_cancel';
export const REMINDER_TOOL_NAMES: ReadonlySet<string> = new Set([REMINDER_SET_TOOL, REMINDER_LIST_TOOL, REMINDER_CANCEL_TOOL]);

/** The reminder that woke this turn (`AgentChatRequest.reminder`). */
export interface ReminderWake {
  runId: string;
  message: string;
  /** ISO time the reminder was set. */
  setAt: string;
  chain: number;
}

/**
 * The user turn a reminder's wake turn starts with. Model-facing and kept in the
 * history; screens show `metadata.reminder.message` instead.
 */
export function reminderNoteText(wake: Pick<ReminderWake, 'setAt' | 'message'>): string {
  return `[Reminder] You scheduled this for yourself at ${wake.setAt}. It is your own earlier note, not a new message from the user:\n${wake.message}`;
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  if (seconds % 60 === 0) return `${seconds / 60} minute(s)`;
  return `${seconds} second(s)`;
}

/** The system-prompt section naming the tools and their limits. */
export function remindersPrompt(settings: ResolvedRemindersConfig, wake?: ReminderWake): string {
  const lines = [
    '## Reminders',
    `You can schedule a one-time reminder for yourself in this session with ${REMINDER_SET_TOOL}({ delay_seconds | at, message, reason? }). When it comes due, this session continues with a turn that starts with your note ("[Reminder] …"), so you can check on something that takes time (a deployment, a reply, a running job) and report back.`,
    `Write the message as an instruction to your future self, with everything you will need (ids, what to check, what to tell the user). Allowed times: ${formatDuration(settings.minDelaySeconds)} to ${settings.maxHorizonHours} hour(s) ahead. At most ${settings.maxActivePerSession} waiting reminder(s) per session.`,
    `Call ${REMINDER_LIST_TOOL} before setting a new one so you do not schedule the same check twice; ${REMINDER_CANCEL_TOOL}({ id }) removes one that is no longer needed. Nobody is waiting on a reminder turn: finish the check, say what you found, and set another reminder only if the thing is still not done.`,
  ];
  if (wake) {
    lines.push(`This turn was started by your reminder ${wake.runId}. To check again later, call ${REMINDER_SET_TOOL} with the same message.`);
  }
  if (settings.instructions) lines.push(settings.instructions);
  return lines.join('\n');
}

/** How a reminder set after untrusted content is treated in this run (from `humanInTheLoop`). */
export type ReminderApprovalMode = 'ask' | 'deny' | 'allow';

/**
 * Whether anybody can approve a reminder on this run. An interactive run with a
 * session can always pause for its owner; an unattended one follows the agent's
 * `humanInTheLoop.unattended` setting (`deny` by default).
 */
export function reminderApprovalMode(hitl: Pick<ResolvedHitlConfig, 'unattended'>, run: { unattended?: boolean; canPause?: boolean }): ReminderApprovalMode {
  const canPause = run.canPause !== false;
  if (!run.unattended) return canPause ? 'ask' : 'deny';
  if (hitl.unattended === 'allow') return 'allow';
  if (hitl.unattended === 'pause' && canPause) return 'ask';
  return 'deny';
}

export interface ReminderToolDeps {
  createToolFn: typeof CreateSdkTool;
  zod: typeof import('zod').z;
  guard: {
    protect<A extends Record<string, unknown>, R>(
      spec: { name: string; requestedName: string },
      execute: (safeArgs: A) => Promise<R>,
    ): (args: A) => Promise<R | string>;
  };
  scope: ReminderScope;
  agentKey: string;
  conversationId: string;
  agentConfig: IAgentConfig;
  settings: ResolvedRemindersConfig;
  creator: {
    userId: string;
    accountableUserId?: string;
    tokenId?: string;
    via?: RequestVia;
    runId?: string;
    version?: number;
    usePublished?: boolean;
  };
  licenseType?: string;
  /** The reminder that woke this run, if one did. */
  wake?: ReminderWake;
  /** The run starts having read outside content (external message, resumed pause). */
  startsTainted: boolean;
  approvalMode: ReminderApprovalMode;
}

export interface ReminderTools {
  tools: AgentSdkToolInterface[];
  definitions: TraceToolDefinition[];
  /** The run's other tools, each marking the run as having read outside content once it returns. */
  watchTools<T extends { name?: string }>(tools: T[]): T[];
  /** Feed every SDK event: a call to a tool this module did not wrap (delegation, skills…) counts too. */
  noteSdkEvent(event: AgentSdkEvent): void;
  /** After the approval pass: `reminder_set` also asks when a reminder would follow outside content. */
  gate<T extends { name?: string; needsApproval?: unknown }>(tools: T[]): T[];
}

const TOOL_CALLABLE_KEYS = ['func', 'invoke', 'call', '_call', 'run'] as const;

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The fire time asked for, or why it cannot be used. */
export function resolveFireAt(
  args: { delay_seconds?: unknown; at?: unknown },
  settings: Pick<ResolvedRemindersConfig, 'minDelaySeconds' | 'maxHorizonHours'>,
  now = Date.now(),
): { at: Date } | { error: string } {
  const hasDelay = args.delay_seconds !== undefined && args.delay_seconds !== null;
  const hasAt = typeof args.at === 'string' && args.at.trim() !== '';
  if (hasDelay === hasAt) return { error: 'Give exactly one of delay_seconds or at.' };
  let at: number;
  if (hasDelay) {
    const delay = Number(args.delay_seconds);
    if (!Number.isFinite(delay)) return { error: 'delay_seconds must be a number of seconds.' };
    at = now + Math.round(delay) * 1000;
  } else {
    at = Date.parse(String(args.at));
    if (!Number.isFinite(at)) return { error: 'at must be an ISO 8601 date-time, e.g. 2026-10-19T15:30:00Z.' };
  }
  const earliest = now + settings.minDelaySeconds * 1000;
  const latest = now + settings.maxHorizonHours * 3_600_000;
  if (at < earliest) return { error: `A reminder must be at least ${formatDuration(settings.minDelaySeconds)} ahead.` };
  if (at > latest) return { error: `A reminder can be at most ${settings.maxHorizonHours} hour(s) ahead.` };
  return { at: new Date(at) };
}

export function buildReminderTools(deps: ReminderToolDeps): ReminderTools {
  const { createToolFn, zod, guard, scope, settings } = deps;
  const taint = { tainted: deps.startsTainted };
  const wakeMessage = deps.wake?.message.trim();

  // Calls of one turn can arrive together: one at a time keeps the session caps true.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  /** A reminder that may carry outside content into a later turn (and is not the re-arm of this one). */
  const followsOutsideContent = (message: string) => taint.tainted && !(wakeMessage && message === wakeMessage);

  const set = createToolFn({
    name: REMINDER_SET_TOOL,
    description: [
      'Schedule a one-time reminder for yourself in this session. When it comes due, the session continues with a turn that starts with your message.',
      `Give exactly one of delay_seconds (${settings.minDelaySeconds} to ${settings.maxHorizonHours * 3600}) or at (ISO 8601).`,
      'Returns { id, fire_at, status } or a sentence saying why it was not set.',
    ].join(' '),
    schema: zod.object({
      delay_seconds: zod.number().int().optional().describe('Seconds from now.'),
      at: zod.string().optional().describe('An ISO 8601 date-time with a time zone, e.g. 2026-10-19T15:30:00Z.'),
      message: zod.string().describe(`Your note to your future self: what to check and what to do (at most ${REMINDER_MESSAGE_MAX_CHARS} characters).`),
      reason: zod.string().optional().describe(`A short label shown to people looking at the session (at most ${REMINDER_REASON_MAX_CHARS} characters).`),
    }),
    func: guard.protect(
      { name: 'agent.reminders.set', requestedName: REMINDER_SET_TOOL },
      (args: { delay_seconds?: unknown; at?: unknown; message?: unknown; reason?: unknown }) => serial(async () => {
        const message = trimmed(args.message);
        if (!message) return 'message is required.';
        if (message.length > REMINDER_MESSAGE_MAX_CHARS) return `message is too long (at most ${REMINDER_MESSAGE_MAX_CHARS} characters).`;
        const reason = trimmed(args.reason).slice(0, REMINDER_REASON_MAX_CHARS);
        const when = resolveFireAt(args, settings);
        if ('error' in when) return when.error;
        if (followsOutsideContent(message)) {
          // `ask` was decided by the approval predicate before this ran: a person approved it.
          if (settings.afterUntrustedContent === 'deny') {
            return 'Not set: this agent does not set reminders after reading tool results or outside content in the same turn.';
          }
          if (settings.afterUntrustedContent === 'approve' && deps.approvalMode === 'deny') {
            return 'Not set: a reminder after reading tool results or outside content needs a person to approve it, and nobody can approve in this run.';
          }
        }
        const { scheduleReminder } = await import('./agentReminders');
        const outcome = await scheduleReminder({
          scope,
          agentKey: deps.agentKey,
          conversationId: deps.conversationId,
          agentConfig: deps.agentConfig,
          settings,
          fireAt: when.at,
          message,
          ...(reason ? { reason } : {}),
          creator: { ...deps.creator, ...(deps.wake ? { wokenChain: deps.wake.chain } : {}) },
          ...(deps.licenseType ? { licenseType: deps.licenseType } : {}),
        });
        if (!outcome.ok) return outcome.reason;
        return JSON.stringify({ id: `run_${String(outcome.run._id)}`, fire_at: when.at.toISOString(), status: 'scheduled' });
      }),
    ),
  }) as AgentSdkToolInterface;

  const list = createToolFn({
    name: REMINDER_LIST_TOOL,
    description: 'List the reminders of this session that have not fired yet. Returns [{ id, fire_at, message, reason }].',
    schema: zod.object({}),
    func: guard.protect(
      { name: 'agent.reminders.list', requestedName: REMINDER_LIST_TOOL },
      async () => {
        const { listReminders, reminderFireAt, REMINDER_META } = await import('./agentReminders');
        const runs = await listReminders(scope, { agentKey: deps.agentKey, conversationId: deps.conversationId, active: true, limit: 50 });
        return JSON.stringify(runs
          .map((run) => ({
            id: `run_${String(run._id)}`,
            fire_at: reminderFireAt(run)?.toISOString() ?? null,
            message: run.userMessage,
            reason: run.metadata?.[REMINDER_META.reason] ?? null,
          }))
          .sort((a, b) => String(a.fire_at).localeCompare(String(b.fire_at))));
      },
    ),
  }) as AgentSdkToolInterface;

  const cancel = createToolFn({
    name: REMINDER_CANCEL_TOOL,
    description: 'Cancel a reminder of this session that has not fired yet, by the id reminder_set or reminder_list returned.',
    schema: zod.object({ id: zod.string().describe('The reminder id (run_…).') }),
    func: guard.protect(
      { name: 'agent.reminders.cancel', requestedName: REMINDER_CANCEL_TOOL },
      (args: { id?: unknown }) => serial(async () => {
        const id = trimmed(args.id);
        if (!id) return 'id is required.';
        const { cancelReminder } = await import('./agentReminders');
        const outcome = await cancelReminder(scope, id, {
          agentKey: deps.agentKey,
          conversationId: deps.conversationId,
          actor: { userId: deps.creator.userId, ...(deps.creator.tokenId ? { tokenId: deps.creator.tokenId } : {}), via: 'agent' },
        });
        if (outcome.kind === 'not_found') return `No reminder ${id} in this session.`;
        if (outcome.kind === 'not_scheduled') return `Reminder ${id} is no longer waiting (${outcome.run.status}).`;
        return JSON.stringify({ id, status: 'canceled' });
      }),
    ),
  }) as AgentSdkToolInterface;

  const tools = [set, list, cancel];
  const definitions: TraceToolDefinition[] = [
    {
      name: REMINDER_SET_TOOL,
      description: 'Schedule a one-time reminder for this agent in this session.',
      parameters: {
        type: 'object',
        properties: {
          delay_seconds: { type: 'integer', description: 'Seconds from now.' },
          at: { type: 'string', description: 'ISO 8601 date-time.' },
          message: { type: 'string', description: 'The note the wake turn starts with.' },
          reason: { type: 'string', description: 'A short label for people.' },
        },
        required: ['message'],
      },
    },
    { name: REMINDER_LIST_TOOL, description: 'List the waiting reminders of this session.', parameters: { type: 'object', properties: {} } },
    {
      name: REMINDER_CANCEL_TOOL,
      description: 'Cancel a waiting reminder of this session.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'The reminder id.' } }, required: ['id'] },
    },
  ];

  const markAfter = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    try {
      const result = fn(...args);
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        return (result as unknown as Promise<unknown>).finally(() => { taint.tainted = true; }) as R;
      }
      taint.tainted = true;
      return result;
    } catch (error) {
      taint.tainted = true;
      throw error;
    }
  };

  return {
    tools,
    definitions,
    watchTools(others) {
      return others.map((tool) => {
        if (!tool || REMINDER_TOOL_NAMES.has(String(tool.name))) return tool;
        const watched: Record<string, unknown> = { ...tool };
        for (const key of TOOL_CALLABLE_KEYS) {
          const fn = watched[key];
          if (typeof fn === 'function') watched[key] = markAfter((fn as (...a: unknown[]) => unknown).bind(tool));
        }
        return watched as typeof tool;
      });
    },
    noteSdkEvent(event) {
      const e = event as { type?: string; phase?: string; name?: unknown };
      if (e.type !== 'tool_call' || (e.phase !== 'success' && e.phase !== 'error')) return;
      if (typeof e.name === 'string' && REMINDER_TOOL_NAMES.has(e.name)) return;
      taint.tainted = true;
    },
    gate(gated) {
      if (settings.afterUntrustedContent !== 'approve' || deps.approvalMode !== 'ask') return gated;
      return gated.map((tool) => {
        if (tool.name !== REMINDER_SET_TOOL) return tool;
        const policy = tool.needsApproval;
        const asks = (args: { message?: unknown }) => followsOutsideContent(trimmed(args?.message));
        return {
          ...tool,
          needsApproval: (args: { message?: unknown }) => {
            if (policy === true) return true;
            if (typeof policy === 'function' && (policy as (a: unknown) => unknown)(args) === true) return true;
            return asks(args);
          },
        };
      });
    },
  };
}
