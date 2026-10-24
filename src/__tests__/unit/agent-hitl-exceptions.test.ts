/**
 * Approval exceptions: rules on a tool call's ARGUMENTS that ask, let it run,
 * or block it — the matcher, the decision, the gates that apply it, what is
 * recorded about why a call waited, and the settings editor's pure half.
 */

import { describe, expect, it, vi } from 'vitest';
import type { IAgentConfig, IAgentHumanInTheLoopConfig } from '@/lib/database';
import {
  HITL_EXCEPTION_LIMITS,
  HitlBlockedCallError,
  createHitlCallLog,
  decideToolCall,
  exceptionActionsFor,
  exceptionIssue,
  exceptionMatches,
  globMatches,
  normalizeToolExceptions,
  validateToolExceptions,
} from '@/lib/services/agents/agentHitlExceptions';
import {
  HitlUnattendedCallError,
  applyToolApprovals,
  applyToolBlocks,
  denyUnattendedTools,
  gateChildTools,
  resolveHitlConfig,
  toolCallDecision,
  validateHitlConfig,
} from '@/lib/services/agents/agentHumanInTheLoop';
import { openPause, toMessagePendingAction, toPublicPendingAction } from '@/lib/services/agents/agentPendingActions';
import { toClientPendingAction } from '@/lib/services/agents/clientWire';
import { extractPlaygroundSteps } from '@/lib/services/agents/agentService';
import {
  exceptionIssues,
  hitlToolRows,
  previewToolCall,
  schemaFieldPaths,
  setToolExceptions,
} from '@/components/agents/studio/hitlSettings';

const hitl = (approval: NonNullable<IAgentHumanInTheLoopConfig['toolApproval']>) => resolveHitlConfig({ toolApproval: approval });

describe('globMatches', () => {
  it('matches the whole value, with * for any run of characters', () => {
    expect(globMatches('*@rival.com', 'ceo@rival.com')).toBe(true);
    expect(globMatches('*@rival.com', 'ceo@rival.com.evil')).toBe(false);
    expect(globMatches('rm -rf *', 'rm -rf build')).toBe(true);
    expect(globMatches('rm', 'rm -rf build')).toBe(false);
    expect(globMatches('*rm -rf*', 'cd x && rm -rf /')).toBe(true);
    expect(globMatches('a*b*c', 'axxbyyc')).toBe(true);
    expect(globMatches('a*b*c', 'axxbyy')).toBe(false);
    expect(globMatches('*', '')).toBe(true);
  });

  it('ignores case, so a rule cannot silently miss', () => {
    expect(globMatches('*@Rival.com', 'X@RIVAL.COM')).toBe(true);
  });

  it('treats everything but * literally', () => {
    expect(globMatches('a.c', 'abc')).toBe(false);
    expect(globMatches('(x)+', '(x)+')).toBe(true);
    expect(globMatches('?', 'a')).toBe(false);
  });
});

describe('exceptionMatches', () => {
  const args = { to: ['a@acme.com', 'b@rival.com'], body: { subject: 'Q3', meta: { draft: true } }, count: 3 };

  it('with a field, looks at that argument and everything under it', () => {
    expect(exceptionMatches({ field: 'to', pattern: '*@rival.com' }, args)).toBe(true);
    expect(exceptionMatches({ field: 'body', pattern: 'q3' }, args)).toBe(true);
    expect(exceptionMatches({ field: 'body.meta.draft', pattern: 'true' }, args)).toBe(true);
    expect(exceptionMatches({ field: 'body.subject', pattern: '*@rival.com' }, args)).toBe(false);
    expect(exceptionMatches({ field: 'to.0', pattern: 'a@*' }, args)).toBe(true);
    expect(exceptionMatches({ field: 'count', pattern: '3' }, args)).toBe(true);
  });

  it('without one, looks at every value of the call', () => {
    expect(exceptionMatches({ pattern: '*@rival.com' }, args)).toBe(true);
    expect(exceptionMatches({ pattern: 'q3' }, args)).toBe(true);
    expect(exceptionMatches({ pattern: 'nothing' }, args)).toBe(false);
  });

  it('reads only the call\'s own fields', () => {
    expect(exceptionMatches({ field: 'constructor', pattern: '*' }, {})).toBe(false);
    expect(exceptionMatches({ field: 'to.length', pattern: '*' }, { to: 'abc' })).toBe(false);
    expect(exceptionMatches({ field: 'missing', pattern: '*' }, args)).toBe(false);
  });
});

describe('decideToolCall', () => {
  const base = { policy: 'always' as const, source: 'tool_policy' as const };

  it('falls back to the tool setting when nothing matches', () => {
    expect(decideToolCall(base, [], {})).toEqual({ action: 'ask', source: 'tool_policy' });
    expect(decideToolCall({ policy: 'never', source: 'default_policy' }, undefined, {})).toEqual({ action: 'allow', source: 'default_policy' });
  });

  it('lets the strictest matching exception win, whatever the order', () => {
    const allow = { field: 'to', pattern: '*@acme.com', action: 'allow' as const };
    const deny = { pattern: '*@rival.com', action: 'deny' as const };
    const args = { to: ['a@acme.com', 'b@rival.com'] };
    expect(decideToolCall(base, [allow, deny], args)).toMatchObject({ action: 'deny', source: 'exception', exception: deny });
    expect(decideToolCall(base, [deny, allow], args)).toMatchObject({ action: 'deny', exception: deny });
    expect(decideToolCall(base, [allow, deny], { to: 'a@acme.com' })).toMatchObject({ action: 'allow', exception: allow });
  });

  it('offers only the actions that differ from the tool setting, plus block', () => {
    expect(exceptionActionsFor('always')).toEqual(['allow', 'deny']);
    expect(exceptionActionsFor('never')).toEqual(['ask', 'deny']);
  });
});

describe('validation', () => {
  it('names what is wrong with one exception', () => {
    expect(exceptionIssue({ pattern: 'x', action: 'ask' })).toBeNull();
    expect(exceptionIssue({ field: 'body.to', pattern: 'x', action: 'deny' })).toBeNull();
    expect(exceptionIssue({ pattern: ' ', action: 'ask' })).toBe('pattern_required');
    expect(exceptionIssue({ pattern: 'x', action: 'maybe' })).toBe('action_invalid');
    expect(exceptionIssue({ pattern: 'x'.repeat(HITL_EXCEPTION_LIMITS.patternLength + 1), action: 'ask' })).toBe('pattern_too_long');
    expect(exceptionIssue({ pattern: '*'.repeat(HITL_EXCEPTION_LIMITS.wildcards + 1), action: 'ask' })).toBe('too_many_wildcards');
    expect(exceptionIssue({ field: 'a b', pattern: 'x', action: 'ask' })).toBe('field_invalid');
    expect(exceptionIssue('nope')).toBe('not_object');
  });

  it('reports stored exceptions by path, and the limits', () => {
    expect(validateToolExceptions(undefined)).toEqual([]);
    expect(validateToolExceptions({ send: [{ pattern: '', action: 'ask' }] })).toEqual([
      { field: 'humanInTheLoop.toolApproval.exceptions.send.0', message: 'pattern is required' },
    ]);
    const many = Array.from({ length: HITL_EXCEPTION_LIMITS.perTool + 1 }, () => ({ pattern: 'x', action: 'ask' }));
    expect(validateToolExceptions({ send: many })[0].message).toMatch(/at most/);
  });

  it('keeps only usable exceptions for the runtime, trimmed', () => {
    expect(normalizeToolExceptions({
      send: [{ field: ' to ', pattern: ' *@x.com ', action: 'deny' }, { pattern: '', action: 'ask' }, { field: '', pattern: 'y', action: 'allow' }],
      other: 'junk',
      none: [{ pattern: '', action: 'ask' }],
    })).toEqual({ send: [{ field: 'to', pattern: '*@x.com', action: 'deny' }, { pattern: 'y', action: 'allow' }] });
  });

  it('is part of the agent config check, with a warning while tool approval is off', () => {
    const config = (toolApproval: object) => ({ humanInTheLoop: { toolApproval } }) as unknown as IAgentConfig;
    const bad = validateHitlConfig(config({ enabled: true, exceptions: { send: [{ pattern: '', action: 'ask' }] } }));
    expect(bad.errors.map((e) => e.field)).toContain('humanInTheLoop.toolApproval.exceptions.send.0');
    const off = validateHitlConfig(config({ enabled: false, exceptions: { send: [{ pattern: 'x', action: 'ask' }] } }));
    expect(off.errors).toEqual([]);
    expect(off.warnings.map((w) => w.field)).toContain('humanInTheLoop.toolApproval.exceptions');
  });
});

describe('the call log', () => {
  it('keeps why a call waits, keyed by the call however its keys are ordered', () => {
    const log = createHitlCallLog();
    const exception = { field: 'to', pattern: '*@rival.com', action: 'ask' as const };
    log.note('send', { to: 'x@rival.com', cc: [] }, { action: 'ask', source: 'exception', exception });
    expect(log.reasonFor('send', { cc: [], to: 'x@rival.com' })).toMatchObject({
      source: 'exception',
      exception: { field: 'to', pattern: '*@rival.com' },
    });
    expect(log.reasonFor('send', { to: 'other' })).toBeUndefined();
    expect(log.reasonFor(undefined, {})).toBeUndefined();
    // An "ask" is not a rule that let the call through or refused it.
    expect(log.ruleFor('send', { to: 'x@rival.com', cc: [] })).toBeUndefined();
  });

  it('keeps which exception let a call run or refused it, and never invents a reason for those', () => {
    const log = createHitlCallLog();
    log.note('send', { to: 'a' }, { action: 'allow', source: 'exception', exception: { pattern: 'a', action: 'allow' } });
    log.note('send', { to: 'b' }, { action: 'deny', source: 'exception', exception: { field: 'to', pattern: 'b', action: 'deny' } });
    expect(log.ruleFor('send', { to: 'a' })).toEqual({ action: 'allow', pattern: 'a' });
    expect(log.ruleFor('send', { to: 'b' })).toEqual({ action: 'deny', field: 'to', pattern: 'b' });
    expect(log.reasonFor('send', { to: 'a' })).toBeUndefined();
  });

  it('words the tool-setting reasons too', () => {
    const log = createHitlCallLog();
    log.note('send', {}, { action: 'ask', source: 'tool_policy' });
    log.note('other', {}, { action: 'ask', source: 'default_policy' });
    expect(log.reasonFor('send', {})).toMatchObject({ source: 'tool_policy' });
    expect(log.reasonFor('other', {})).toMatchObject({ source: 'default_policy' });
  });
});

type TestTool = {
  name: string;
  func: (args: unknown) => Promise<unknown>;
  needsApproval?: unknown;
  approvalPrompt?: unknown;
  retry?: { maxRetries: number; shouldRetry?: (error: unknown, attempt: number) => boolean };
  cache?: unknown;
};
const tool = (name: string, extra: Partial<TestTool> = {}): TestTool => ({ name, func: vi.fn(async () => 'ran'), ...extra });
const asks = (t: TestTool, args: unknown) => (t.needsApproval as (a: unknown) => boolean)(args);

describe('applyToolApprovals with exceptions', () => {
  it('lets a call an allow exception matches run without asking, and records the rule', () => {
    const resolved = hitl({ enabled: true, tools: { send: 'always' }, exceptions: { send: [{ field: 'to', pattern: '*@acme.com', action: 'allow' }] } });
    const log = createHitlCallLog();
    const [gated] = applyToolApprovals([tool('send')], resolved, new Set(), log);
    expect(asks(gated, { to: 'a@acme.com' })).toBe(false);
    expect(asks(gated, { to: 'a@rival.com' })).toBe(true);
    expect(log.ruleFor('send', { to: 'a@acme.com' })).toEqual({ action: 'allow', field: 'to', pattern: '*@acme.com' });
  });

  it('asks for a call an ask exception matches on a tool that otherwise runs freely, and says why', () => {
    const resolved = hitl({ enabled: true, defaultPolicy: 'never', exceptions: { sandbox_exec: [{ field: 'command', pattern: '*rm -rf*', action: 'ask' }] } });
    const log = createHitlCallLog();
    const [gated] = applyToolApprovals([tool('sandbox_exec')], resolved, new Set(), log);
    expect(asks(gated, { command: 'ls' })).toBe(false);
    const risky = { command: 'rm -rf build' };
    expect(asks(gated, risky)).toBe(true);
    const prompt = (gated.approvalPrompt as (a: unknown) => string)(risky);
    expect(prompt).toContain('`command` matches "*rm -rf*"');
    expect(log.reasonFor('sandbox_exec', risky)).toMatchObject({ source: 'exception', exception: { field: 'command', pattern: '*rm -rf*' } });
  });

  it('does not let "don\'t ask again for this tool" skip an exception that asks', () => {
    const resolved = hitl({ enabled: true, tools: { send: 'always' }, exceptions: { send: [{ pattern: '*@rival.com', action: 'ask' }] } });
    const [gated] = applyToolApprovals([tool('send')], resolved, new Set(['send']), createHitlCallLog());
    expect(asks(gated, { to: 'x@acme.com' })).toBe(false);
    expect(asks(gated, { to: 'x@rival.com' })).toBe(true);
  });

  it('blocks a call a deny exception matches: it never runs, never asks, is never retried and is not served from cache', async () => {
    const resolved = hitl({ enabled: true, exceptions: { send: [{ field: 'to', pattern: '*@rival.com', action: 'deny' }] } });
    const log = createHitlCallLog();
    const ownRetry = vi.fn(() => true);
    const original = tool('send', { retry: { maxRetries: 3, shouldRetry: ownRetry }, cache: { ttl: 60 } });
    const [gated] = applyToolApprovals([original], resolved, new Set(), log);
    const blocked = { to: 'ceo@rival.com' };

    expect(asks(gated, blocked)).toBe(false);
    const error = await gated.func(blocked).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HitlBlockedCallError);
    expect((error as Error).message).toContain('not a temporary failure');
    expect(original.func).not.toHaveBeenCalled();
    expect(log.ruleFor('send', blocked)).toEqual({ action: 'deny', field: 'to', pattern: '*@rival.com' });

    expect(gated.retry?.shouldRetry?.(error, 1)).toBe(false);
    expect(gated.retry?.shouldRetry?.(new Error('timeout'), 1)).toBe(true);
    expect(ownRetry).toHaveBeenCalledTimes(1);
    expect('cache' in gated).toBe(false);

    await expect(gated.func({ to: 'x@acme.com' })).resolves.toBe('ran');
  });

  it('keeps a gate already on the tool: the call asks when either side asks', () => {
    const resolved = hitl({ enabled: true, defaultPolicy: 'never', exceptions: { send: [{ pattern: 'x', action: 'ask' }] } });
    const prior = vi.fn((args: unknown) => (args as { y?: boolean }).y === true);
    const [gated] = applyToolApprovals([tool('send', { needsApproval: prior, approvalPrompt: 'theirs' })], resolved, new Set());
    expect(asks(gated, { v: 'x' })).toBe(true);
    expect(asks(gated, { y: true })).toBe(true);
    expect(asks(gated, { v: 'z' })).toBe(false);
    // The other side's wording stays when it is the one asking.
    expect((gated.approvalPrompt as (a: unknown) => string)({ y: true })).toBe('theirs');
  });

  it('changes nothing while tool approval is off', () => {
    const resolved = hitl({ enabled: false, exceptions: { send: [{ pattern: '*', action: 'deny' }] } });
    const tools = [tool('send')];
    expect(applyToolApprovals(tools, resolved, new Set())).toBe(tools);
    expect(applyToolBlocks(tools, resolved)).toBe(tools);
    expect(denyUnattendedTools(tools, resolved, new Set())).toBe(tools);
  });

  it('agrees with toolCallDecision, the function the editor previews with', () => {
    const resolved = hitl({ enabled: true, exceptions: { send: [{ pattern: '*@acme.com', action: 'allow' }] } });
    expect(toolCallDecision(resolved, 'send', { to: 'a@acme.com' })).toMatchObject({ action: 'allow', source: 'exception' });
    expect(toolCallDecision(resolved, 'send', { to: 'a@b.com' })).toEqual({ action: 'ask', source: 'default_policy' });
  });
});

describe('runs nobody can answer', () => {
  const resolved = hitl({
    enabled: true,
    tools: { send: 'always' },
    exceptions: { send: [{ field: 'to', pattern: '*@acme.com', action: 'allow' }, { field: 'to', pattern: '*@rival.com', action: 'deny' }] },
  });

  it('decides per call: an allowed call runs, one that would ask is refused, a blocked one is blocked', async () => {
    const original = tool('send');
    const [gated] = denyUnattendedTools([original], resolved, new Set());
    await expect(gated.func({ to: 'a@acme.com' })).resolves.toBe('ran');
    await expect(gated.func({ to: 'a@other.com' })).rejects.toBeInstanceOf(HitlUnattendedCallError);
    await expect(gated.func({ to: 'a@rival.com' })).rejects.toBeInstanceOf(HitlBlockedCallError);
    expect(original.func).toHaveBeenCalledTimes(1);
  });

  it('still blocks on a run that lets everything else through (unattended: allow)', async () => {
    const plain = tool('lookup');
    const [gated, untouched] = applyToolBlocks([tool('send'), plain], resolved);
    expect(untouched).toBe(plain);
    await expect(gated.func({ to: 'a@other.com' })).resolves.toBe('ran');
    await expect(gated.func({ to: 'a@rival.com' })).rejects.toBeInstanceOf(HitlBlockedCallError);
  });

  it('applies every side of a sub-agent\'s tools, a side that allows everything included', async () => {
    const open = hitl({ enabled: false });
    const [gated] = gateChildTools([tool('send')], [{ hitl: open, mode: 'ask' }, { hitl: resolved, mode: 'allow' }], new Set());
    await expect(gated.func({ to: 'a@rival.com' })).rejects.toBeInstanceOf(HitlBlockedCallError);
  });
});

describe('what is stored about a pause', () => {
  const resolved = hitl({ enabled: true, defaultPolicy: 'never', exceptions: { send: [{ field: 'to', pattern: '*@rival.com', action: 'ask' }] } });
  const pause = async (approvalLog: ReturnType<typeof createHitlCallLog> | undefined, prompt?: string) => {
    const created: unknown[] = [];
    const db = {
      createAgentPendingActions: vi.fn(async (rows: unknown[]) => {
        created.push(...rows);
        return rows.map((row, index) => ({ ...(row as object), _id: `act_${index}` }));
      }),
    };
    await openPause(db as never, {
      state: {
        messages: [],
        pendingApprovals: [{
          id: 'ap1', status: 'pending', toolCallId: 'c1', toolName: 'send', args: { to: 'ceo@rival.com' },
          ...(prompt ? { metadata: { prompt } } : {}),
        }],
      } as never,
      source: 'agent',
      tenantId: 't', projectId: 'p', agentKey: 'a', conversationId: 'conv',
      hitl: resolved, approvalLog, agentVersion: null, usePublished: false, createdBy: 'u1',
    });
    return created[0] as { reason?: unknown };
  };

  it('stores the exception that asked on the pending action', async () => {
    const log = createHitlCallLog();
    const [gated] = applyToolApprovals([tool('send')], resolved, new Set(), log);
    const prompt = (gated.approvalPrompt as (a: unknown) => string)({ to: 'ceo@rival.com' });
    const row = await pause(log, prompt);
    expect(row.reason).toMatchObject({ source: 'exception', exception: { field: 'to', pattern: '*@rival.com' } });
  });

  it('falls back to the prompt of whatever else asked, and to nothing', async () => {
    expect((await pause(createHitlCallLog(), 'A skill wants to run this')).reason).toEqual({ source: 'other', text: 'A skill wants to run this' });
    expect('reason' in (await pause(undefined))).toBe(false);
  });

  it('carries the reason to the message copy and the client wire', () => {
    const reason = { source: 'exception' as const, exception: { field: 'to', pattern: '*@rival.com' }, text: 'why' };
    const action = { _id: 'act_1', kind: 'tool_approval', toolName: 'send', status: 'pending', requestedAt: new Date(), reason } as never;
    expect(toPublicPendingAction(action).reason).toEqual(reason);
    expect(toMessagePendingAction(action).reason).toEqual(reason);
    expect(toClientPendingAction(toPublicPendingAction(action)).reason).toEqual(reason);
    const plain = { _id: 'act_2', kind: 'tool_approval', toolName: 'x', status: 'pending', requestedAt: new Date() } as never;
    expect('reason' in toClientPendingAction(toPublicPendingAction(plain))).toBe(false);
  });
});

describe('steps of calls an exception decided', () => {
  const stepsOf = (history: unknown[], log: ReturnType<typeof createHitlCallLog>) =>
    extractPlaygroundSteps({ state: { toolHistory: history, messages: [] } } as never, undefined, log);

  it('names the rule on a blocked call and reports its message, not a generic failure', () => {
    const log = createHitlCallLog();
    const exception = { field: 'to', pattern: '*@rival.com', action: 'deny' as const };
    log.note('send', { to: 'a@rival.com' }, { action: 'deny', source: 'exception', exception });
    log.note('send', { to: 'a@acme.com' }, { action: 'allow', source: 'exception', exception: { pattern: '*@acme.com', action: 'allow' } });
    const blockedMessage = new HitlBlockedCallError('send', exception).message;
    const [blocked, allowed, plain] = stepsOf([
      { executionId: 'e1', toolName: 'send', args: { to: 'a@rival.com' }, output: `Error executing tool: ${blockedMessage}`, status: 'error', tool_call_id: 'c1' },
      { executionId: 'e2', toolName: 'send', args: { to: 'a@acme.com' }, output: 'sent', status: 'success', tool_call_id: 'c2' },
      { executionId: 'e3', toolName: 'send', args: { to: 'a@x.com' }, output: 'sent', status: 'success', tool_call_id: 'c3' },
    ], log);
    expect(blocked).toMatchObject({ status: 'error', error: blockedMessage, approvalRule: { action: 'deny', field: 'to', pattern: '*@rival.com' } });
    expect(allowed.approvalRule).toEqual({ action: 'allow', pattern: '*@acme.com' });
    expect(plain.approvalRule).toBeUndefined();
  });
});

describe('the settings editor', () => {
  const value: IAgentHumanInTheLoopConfig = {
    toolApproval: {
      enabled: true,
      tools: { send: 'always' },
      exceptions: { send: [{ field: 'to', pattern: '*@acme.com', action: 'allow' }], gone_tool: [{ pattern: 'x', action: 'deny' }] },
    },
  };

  it('lists each tool\'s exceptions, and keeps a tool that only has exceptions left visible', () => {
    const rows = hitlToolRows({ toolBindings: [{ source: 'tool', sourceKey: 'mail', toolNames: ['send', 'read'] }] }, value);
    expect(rows.find((r) => r.name === 'send')?.exceptions).toHaveLength(1);
    expect(rows.find((r) => r.name === 'read')?.exceptions).toEqual([]);
    expect(rows.find((r) => r.name === 'gone_tool')).toMatchObject({ stale: true, exceptions: [{ pattern: 'x', action: 'deny' }] });
  });

  it('replaces one tool\'s list and drops empty entries', () => {
    const next = setToolExceptions(value, 'send', [{ pattern: 'y', action: 'deny' }]);
    expect(next.toolApproval?.exceptions?.send).toEqual([{ pattern: 'y', action: 'deny' }]);
    expect(next.toolApproval?.tools).toEqual({ send: 'always' });
    const cleared = setToolExceptions(setToolExceptions(value, 'send', []), 'gone_tool', []);
    expect(cleared.toolApproval && 'exceptions' in cleared.toolApproval).toBe(false);
    expect(setToolExceptions(undefined, 'send', [{ pattern: 'y', action: 'ask' }]).toolApproval).toEqual({
      enabled: false,
      exceptions: { send: [{ pattern: 'y', action: 'ask' }] },
    });
  });

  it('previews a call with the lines being edited and points at the one that decided', () => {
    const lines = [
      { field: '', pattern: '', action: 'deny' as const },
      { field: 'to', pattern: '*@acme.com', action: 'allow' as const },
      { field: ' to ', pattern: '*@rival.com', action: 'deny' as const },
    ];
    expect(previewToolCall(value, 'send', lines, { to: 'a@rival.com' })).toMatchObject({ decision: { action: 'deny' }, index: 2 });
    expect(previewToolCall(value, 'send', lines, { to: 'a@acme.com' })).toMatchObject({ decision: { action: 'allow' }, index: 1 });
    expect(previewToolCall(value, 'send', lines, { to: 'a@b.com' })).toEqual({ decision: { action: 'ask', source: 'tool_policy' }, index: null });
    expect(exceptionIssues(lines)).toEqual(['pattern_required', null, null]);
  });

  it('suggests argument names from a schema, one level of nesting deep', () => {
    expect(schemaFieldPaths({
      type: 'object',
      properties: { to: { type: 'string' }, body: { type: 'object', properties: { subject: {}, meta: { properties: { deep: {} } } } } },
    })).toEqual(['to', 'body', 'body.subject', 'body.meta']);
    expect(schemaFieldPaths(undefined)).toEqual([]);
    expect(schemaFieldPaths({ type: 'string' })).toEqual([]);
  });
});
