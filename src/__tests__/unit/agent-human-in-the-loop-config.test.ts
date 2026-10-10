import { describe, expect, it, vi } from 'vitest';
import type { IAgentConfig } from '@/lib/database';
import {
  DASHBOARD_AGENT_HITL_DEFAULTS,
  HITL_DEFAULTS,
  HITL_READ_ONLY_TOOLS,
  UNATTENDED_DENIED_MESSAGE,
  applyToolApprovals,
  denyUnattendedTools,
  hitlCanPause,
  isReadOnlyTool,
  resolveHitlConfig,
  resolveHitlRunMode,
  sessionAllowedTools,
  toolApprovalPolicy,
  validateHitlConfig,
} from '@/lib/services/agents/agentHumanInTheLoop';
import { validateAgentConfigShape } from '@/lib/services/agents/agentConfigValidation';
import { CONFIG_SECTION_KEYS, CONFIG_SECTION_TITLES, changedConfigSections } from '@/components/agents/studio/configSections';

describe('resolveHitlConfig', () => {
  it('an agent without the setting never pauses and carries the documented defaults', () => {
    const resolved = resolveHitlConfig(undefined);
    expect(hitlCanPause(resolved)).toBe(false);
    expect(resolved).toMatchObject({
      toolApprovalEnabled: false,
      askUserEnabled: false,
      timeoutMinutes: 1440,
      onTimeout: 'deny',
      approvers: 'owner_or_admin',
      onUserMessageWhilePending: 'reject',
      defaultPolicy: 'always',
      allowFreeText: true,
      unattended: 'deny',
    });
    expect(HITL_DEFAULTS.timeoutMinutes).toBe(1440);
    expect(HITL_DEFAULTS.unattended).toBe('deny');
  });

  it('reads every setting from the stored config', () => {
    const resolved = resolveHitlConfig({
      askUser: { enabled: true, allowFreeText: false },
      toolApproval: { enabled: true, defaultPolicy: 'never', tools: { sandbox_exec: 'always' } },
      timeoutMinutes: 0,
      onTimeout: 'cancel',
      approvers: 'project_members',
      onUserMessageWhilePending: 'cancel_pending',
      unattended: 'pause',
    });
    expect(resolved).toEqual({
      toolApprovalEnabled: true,
      defaultPolicy: 'never',
      toolPolicies: { sandbox_exec: 'always' },
      askUserEnabled: true,
      allowFreeText: false,
      timeoutMinutes: 0,
      onTimeout: 'cancel',
      approvers: 'project_members',
      onUserMessageWhilePending: 'cancel_pending',
      unattended: 'pause',
    });
    expect(hitlCanPause(resolved)).toBe(true);
  });

  it('falls back to the defaults for values it does not know', () => {
    const resolved = resolveHitlConfig({
      timeoutMinutes: -5,
      onTimeout: 'explode',
      approvers: 'everyone',
      onUserMessageWhilePending: 'queue',
      unattended: 'whatever',
    } as never);
    expect(resolved).toMatchObject({
      timeoutMinutes: 1440, onTimeout: 'deny', approvers: 'owner_or_admin', onUserMessageWhilePending: 'reject', unattended: 'deny',
    });
  });

  it('reads the policy for runs nobody can answer; an unset or unknown value is deny', () => {
    expect(resolveHitlConfig({ toolApproval: { enabled: true } }).unattended).toBe('deny');
    expect(resolveHitlConfig({ unattended: 'deny' }).unattended).toBe('deny');
    expect(resolveHitlConfig({ unattended: 'pause' }).unattended).toBe('pause');
    expect(resolveHitlConfig({ unattended: 'allow' }).unattended).toBe('allow');
  });
});

describe('resolveHitlRunMode', () => {
  const settings = (unattended?: 'deny' | 'pause' | 'allow') => resolveHitlConfig({
    toolApproval: { enabled: true },
    askUser: { enabled: true },
    ...(unattended ? { unattended } : {}),
  });

  it('an agent that can never pause is never gated, attended or not', () => {
    const none = resolveHitlConfig(undefined);
    expect(resolveHitlRunMode(none, {})).toBe('allow');
    expect(resolveHitlRunMode(none, { unattended: true })).toBe('allow');
  });

  it('an attended run asks, whatever the unattended setting says', () => {
    for (const policy of ['deny', 'pause', 'allow'] as const) {
      expect(resolveHitlRunMode(settings(policy), {})).toBe('ask');
    }
  });

  it('an unattended run follows the setting, and the default is deny', () => {
    expect(resolveHitlRunMode(settings(), { unattended: true })).toBe('deny');
    expect(resolveHitlRunMode(settings('deny'), { unattended: true })).toBe('deny');
    expect(resolveHitlRunMode(settings('pause'), { unattended: true })).toBe('ask');
    expect(resolveHitlRunMode(settings('allow'), { unattended: true })).toBe('allow');
  });

  it('a run with nowhere to park a pause cannot honour pause: it denies, it never allows', () => {
    expect(resolveHitlRunMode(settings(), { canPause: false })).toBe('deny');
    expect(resolveHitlRunMode(settings('pause'), { canPause: false })).toBe('deny');
    expect(resolveHitlRunMode(settings('pause'), { unattended: true, canPause: false })).toBe('deny');
    expect(resolveHitlRunMode(settings('allow'), { canPause: false })).toBe('allow');
  });
});

describe('denyUnattendedTools', () => {
  const makeTool = (name: string, extra: Record<string, unknown> = {}) => {
    const run = vi.fn(async () => ({ ran: name }));
    return { name, func: run, invoke: run, call: run, run, ...extra, spy: run };
  };
  const asking = resolveHitlConfig({ toolApproval: { enabled: true } });

  it('returns the very same tools when tool approval is off', () => {
    const tools = [makeTool('sandbox_exec')];
    expect(denyUnattendedTools(tools, resolveHitlConfig(undefined), new Set())).toBe(tools);
  });

  it('replaces the execution of a gated tool with a refusal, and leaves every other tool alone', async () => {
    const exec = makeTool('sandbox_exec');
    const read = makeTool('sandbox_read_file');
    const [deniedExec, untouchedRead] = denyUnattendedTools([exec, read], asking, new Set());

    expect(untouchedRead).toBe(read);
    for (const key of ['func', 'invoke', 'call', 'run'] as const) {
      await expect((deniedExec as unknown as Record<string, () => Promise<unknown>>)[key]()).rejects.toThrow(UNATTENDED_DENIED_MESSAGE);
    }
    expect(exec.spy).not.toHaveBeenCalled();
    // The original tool object was not changed.
    expect(exec.func).toBe(exec.spy);
    expect(UNATTENDED_DENIED_MESSAGE).toMatch(/needs human approval and no approver is available/);
  });

  it('does not set needsApproval, so the SDK never pauses on the call', () => {
    const [denied] = denyUnattendedTools([makeTool('sandbox_exec', { needsApproval: true })], asking, new Set());
    expect('needsApproval' in denied).toBe(false);
  });

  it('a tool the user allowed for the session keeps running', () => {
    const exec = makeTool('sandbox_exec');
    const [kept] = denyUnattendedTools([exec], asking, new Set(['sandbox_exec']));
    expect(kept).toBe(exec);
  });

  it('follows the per-tool and default policy exactly as the approval does', () => {
    const tools = [makeTool('custom_tool'), makeTool('web_search'), makeTool('sandbox_exec')];
    const resolved = resolveHitlConfig({
      toolApproval: { enabled: true, defaultPolicy: 'never', tools: { sandbox_exec: 'always', web_search: 'always' } },
    });
    const out = denyUnattendedTools(tools, resolved, new Set());
    expect(out[0]).toBe(tools[0]);
    expect(out[1]).not.toBe(tools[1]);
    expect(out[2]).not.toBe(tools[2]);
  });

  it('never retries a refusal and never serves a cached result for it', () => {
    const [denied] = denyUnattendedTools(
      [makeTool('sandbox_exec', { retry: { maxRetries: 3, circuitBreakerThreshold: 5 }, cache: true })],
      asking,
      new Set(),
    );
    expect((denied as unknown as { retry: unknown }).retry).toEqual({ maxRetries: 0, circuitBreakerThreshold: 5 });
    expect('cache' in denied).toBe(false);
  });
});

describe('which tools are asked about', () => {
  const asking = resolveHitlConfig({ toolApproval: { enabled: true } });

  it('keeps the read-only list in one exported constant', () => {
    expect(HITL_READ_ONLY_TOOLS).toEqual(expect.arrayContaining([
      'memory_search', 'sandbox_read_file', 'sandbox_list_files', 'sandbox_preview_link', 'web_search', 'ask_user_question',
    ]));
    expect(isReadOnlyTool('knowledge_search')).toBe(true);
    expect(isReadOnlyTool('knowledge_read_document_lines')).toBe(true);
    expect(isReadOnlyTool('sandbox_exec')).toBe(false);
    expect(isReadOnlyTool('memory_write')).toBe(false);
  });

  it('read-only tools are never asked about by default; everything else follows the default policy', () => {
    for (const name of ['knowledge_search', 'memory_search', 'sandbox_read_file', 'sandbox_list_files', 'sandbox_preview_link', 'web_search', 'ask_user_question']) {
      expect(toolApprovalPolicy(asking, name)).toBe('never');
    }
    for (const name of ['sandbox_exec', 'sandbox_run_code', 'sandbox_write_file', 'memory_write', 'memory_forget', 'jira/create_issue', 'my_http_tool']) {
      expect(toolApprovalPolicy(asking, name)).toBe('always');
    }
    expect(toolApprovalPolicy(resolveHitlConfig({ toolApproval: { enabled: true, defaultPolicy: 'never' } }), 'sandbox_exec')).toBe('never');
  });

  it('an explicit per-tool setting beats both the exemption and the default', () => {
    const resolved = resolveHitlConfig({
      toolApproval: { enabled: true, defaultPolicy: 'always', tools: { web_search: 'always', sandbox_exec: 'never' } },
    });
    expect(toolApprovalPolicy(resolved, 'web_search')).toBe('always');
    expect(toolApprovalPolicy(resolved, 'sandbox_exec')).toBe('never');
  });
});

describe('applyToolApprovals', () => {
  const tools = [{ name: 'sandbox_exec' }, { name: 'sandbox_read_file' }, { name: 'knowledge_search' }];

  it('returns the very same tools when tool approval is off', () => {
    expect(applyToolApprovals(tools, resolveHitlConfig(undefined), new Set())).toBe(tools);
    expect(applyToolApprovals(tools, resolveHitlConfig({ toolApproval: { enabled: false } }), new Set())).toBe(tools);
  });

  it('sets a predicate on the gated tools only, without touching the originals', () => {
    const gated = applyToolApprovals(tools, resolveHitlConfig({ toolApproval: { enabled: true } }), new Set());
    expect(typeof (gated[0] as { needsApproval?: unknown }).needsApproval).toBe('function');
    expect((gated[0] as unknown as { needsApproval: (args: unknown) => boolean }).needsApproval({})).toBe(true);
    expect(gated[1]).toBe(tools[1]);
    expect(gated[2]).toBe(tools[2]);
    expect((tools[0] as { needsApproval?: unknown }).needsApproval).toBeUndefined();
  });

  it('the predicate stops asking for a tool on the session allow-list', () => {
    const allowed = new Set<string>();
    const gated = applyToolApprovals(tools, resolveHitlConfig({ toolApproval: { enabled: true } }), allowed);
    const predicate = (gated[0] as unknown as { needsApproval: () => boolean }).needsApproval;
    expect(predicate()).toBe(true);
    allowed.add('sandbox_exec');
    expect(predicate()).toBe(false);
  });

  it('reads the allow-list from the conversation metadata', () => {
    expect([...sessionAllowedTools({ hitlAllowedTools: ['a', 'b', 3] })]).toEqual(['a', 'b']);
    expect(sessionAllowedTools(undefined).size).toBe(0);
    expect(sessionAllowedTools({ hitlAllowedTools: 'a' }).size).toBe(0);
  });
});

describe('validation', () => {
  const config = (humanInTheLoop: unknown): IAgentConfig => ({ modelKey: 'gpt', humanInTheLoop } as IAgentConfig);
  const errors = (humanInTheLoop: unknown) => validateAgentConfigShape(config(humanInTheLoop)).errors.map((e) => e.field);

  it('accepts no setting and the dashboard defaults', () => {
    expect(validateAgentConfigShape(config(undefined)).errors).toEqual([]);
    expect(validateAgentConfigShape(config(DASHBOARD_AGENT_HITL_DEFAULTS)).errors).toEqual([]);
    expect(DASHBOARD_AGENT_HITL_DEFAULTS).toEqual({
      toolApproval: { enabled: true, defaultPolicy: 'always' },
      askUser: { enabled: false, allowFreeText: true },
    });
  });

  it('rejects values the runtime cannot honour, naming the field', () => {
    expect(errors({ timeoutMinutes: -1 })).toContain('humanInTheLoop.timeoutMinutes');
    expect(errors({ timeoutMinutes: 1.5 })).toContain('humanInTheLoop.timeoutMinutes');
    expect(errors({ timeoutMinutes: 'soon' })).toContain('humanInTheLoop.timeoutMinutes');
    expect(errors({ onTimeout: 'ignore' })).toContain('humanInTheLoop.onTimeout');
    expect(errors({ approvers: 'anyone' })).toContain('humanInTheLoop.approvers');
    expect(errors({ onUserMessageWhilePending: 'queue' })).toContain('humanInTheLoop.onUserMessageWhilePending');
    expect(errors({ unattended: 'ignore' })).toContain('humanInTheLoop.unattended');
    expect(errors({ toolApproval: { enabled: true, defaultPolicy: 'maybe' } })).toContain('humanInTheLoop.toolApproval.defaultPolicy');
    expect(errors({ toolApproval: { enabled: true, tools: { sandbox_exec: 'sometimes' } } })).toContain('humanInTheLoop.toolApproval.tools.sandbox_exec');
    expect(errors('yes')).toContain('humanInTheLoop');
  });

  it('0 minutes (never expires) is valid', () => {
    expect(errors({ timeoutMinutes: 0 })).toEqual([]);
  });

  it('warns, but does not refuse, when tool approval is on and sub-agents exist', () => {
    const withSubagents = {
      ...config({ toolApproval: { enabled: true } }),
      subagents: [{ kind: 'inline', name: 'helper', header: 'Helps', systemPrompt: 'x' }],
    } as IAgentConfig;
    const result = validateHitlConfig(withSubagents);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.field)).toContain('humanInTheLoop.toolApproval');
    const off = validateHitlConfig({ ...withSubagents, humanInTheLoop: { toolApproval: { enabled: false } } });
    expect(off.warnings).toEqual([]);
  });

  it('accepts every unattended policy; "allow" is a warning, not an error', () => {
    for (const policy of ['deny', 'pause', 'allow']) {
      expect(errors({ toolApproval: { enabled: true }, unattended: policy })).toEqual([]);
    }
    expect(validateHitlConfig(config({ toolApproval: { enabled: true }, unattended: 'allow' })).warnings.map((w) => w.field))
      .toContain('humanInTheLoop.unattended');
    expect(validateHitlConfig(config({ toolApproval: { enabled: true }, unattended: 'deny' })).warnings).toEqual([]);
    // Nothing is gated, so there is nothing to warn about.
    expect(validateHitlConfig(config({ unattended: 'allow' })).warnings).toEqual([]);
  });

  it('warns that free text off makes options mandatory', () => {
    expect(validateHitlConfig(config({ askUser: { enabled: true, allowFreeText: false } })).warnings.map((w) => w.field))
      .toContain('humanInTheLoop.askUser.allowFreeText');
  });
});

describe('Configure → Approvals & questions', () => {
  it('is its own section, keyed on humanInTheLoop', () => {
    expect(CONFIG_SECTION_KEYS.hitl).toEqual(['humanInTheLoop']);
    expect(CONFIG_SECTION_TITLES.hitl).toBe('Approvals & questions');
  });

  it('is flagged as changed when only the approval settings differ from the published version', () => {
    const published = { modelKey: 'gpt', humanInTheLoop: { toolApproval: { enabled: true } } };
    const draft = { modelKey: 'gpt', humanInTheLoop: { toolApproval: { enabled: false } } };
    expect([...changedConfigSections(draft, published)]).toEqual(['hitl']);
  });
});
