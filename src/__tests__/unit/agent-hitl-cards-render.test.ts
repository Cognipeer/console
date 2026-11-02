/**
 * Smoke render of the approval / question cards and the settings panel on the
 * server renderer: they mount with real Mantine, in both the open and the
 * settled state, and say what they should. Interaction is covered by the pure
 * helpers' tests; this guards against a card that throws on its first render.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import PendingActionList from '@/components/agents/session/PendingActionCards';
import AgentHumanInTheLoopPanel from '@/components/agents/studio/AgentHumanInTheLoopPanel';
import type { PendingActionView } from '@/components/agents/session/pendingActions';

// The suite compiles JSX with the classic runtime, which wants `React` in scope.
(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode) => renderToStaticMarkup(h(MantineProvider, null, node));
const noop = () => undefined;
const list = (actions: PendingActionView[]) => h(PendingActionList, { actions, busy: false, onResolve: noop });

const approval: PendingActionView = {
  id: 'a1', kind: 'tool_approval', toolName: 'sandbox_exec', args: { command: 'rm -rf build' }, status: 'pending',
};
const question: PendingActionView = {
  id: 'q1',
  kind: 'user_question',
  status: 'pending',
  questions: [
    { header: 'Env', question: 'Which environment?', options: [{ label: 'Staging', description: 'safe' }, { label: 'Prod' }] },
    { question: 'Which checks?', multiSelect: true, required: false, options: [{ label: 'Lint' }, { label: 'Tests' }] },
  ],
};

describe('PendingActionList', () => {
  it('renders an open approval with its tool, arguments and both buttons', () => {
    const html = render(list([approval]));
    expect(html).toContain('Approval needed');
    expect(html).toContain('sandbox_exec');
    expect(html).toContain('rm -rf build');
    expect(html).toContain('Approve');
    expect(html).toContain('Deny');
    expect(html).toContain('Edit arguments');
    expect(html).toContain('Don’t ask again for this tool in this session');
  });

  it('renders an open question with headers, options, required markers and Skip / Send', () => {
    const html = render(list([question]));
    expect(html).toContain('Which environment?');
    expect(html).toContain('Env');
    expect(html).toContain('Staging');
    expect(html).toContain('safe');
    expect(html).toContain('Lint');
    expect(html).toContain('Skip');
    expect(html).toContain('Send');
    // Only the first question is required.
    expect(html.match(/aria-label="required"/g)).toHaveLength(1);
  });

  it('says why an approval waits and links to the rule', () => {
    const byException: PendingActionView = {
      ...approval,
      reason: { source: 'exception', exception: { field: 'command', pattern: '*rm -rf*' } },
    };
    const html = renderToStaticMarkup(h(MantineProvider, null, h(PendingActionList, {
      actions: [byException], busy: false, onResolve: noop, ruleHref: '/dashboard/agents/a1?tab=approvals',
    })));
    expect(html).toContain('Asked because command matches “*rm -rf*”.');
    expect(html).toContain('View rule');
    expect(html).toContain('/dashboard/agents/a1?tab=approvals');
    // An exception asks every time it matches: "don't ask again" is not offered.
    expect(html).not.toContain('Don’t ask again for this tool in this session');
    expect(html).toContain('so it is asked again whenever a call matches it');

    const byTool = render(list([{ ...approval, reason: { source: 'tool_policy' } }]));
    expect(byTool).toContain('Asked because this tool is set to always ask.');
    expect(byTool).toContain('Don’t ask again for this tool in this session');
    expect(render(list([{ ...approval, reason: { source: 'exception', exception: { pattern: 'x' } } }]))).toContain('an argument matches “x”');
    expect(render(list([{ ...approval, reason: { source: 'other', text: 'A skill asked' } }]))).toContain('Asked: A skill asked');
  });

  it('collapses settled actions to one line each', () => {
    const html = render(list([
      { ...approval, status: 'resolved', resolution: { decision: 'deny', comment: 'too risky' } },
      { ...question, status: 'resolved', resolution: { answers: { 'Which environment?': 'Staging' } } },
    ]));
    expect(html).toContain('Denied: too risky');
    expect(html).toContain('Answered');
    expect(html).toContain('Staging');
    // No buttons once settled (the class names contain "Approved", the button text is `>Approve<`).
    expect(html).not.toContain('>Approve<');
    expect(html).not.toContain('>Deny<');
  });
});

describe('AgentHumanInTheLoopPanel', () => {
  const toolConfig = { toolBindings: [{ source: 'mcp', sourceKey: 'jira', toolNames: ['create_issue'] }], sandbox: { enabled: true } };
  const panel = (value: Parameters<typeof AgentHumanInTheLoopPanel>[0]['value']) =>
    render(h(AgentHumanInTheLoopPanel, { value, onChange: noop, toolConfig }));

  it('shows only the switches for an agent that switched approval off', () => {
    const html = panel({ toolApproval: { enabled: false } });
    expect(html).toContain('Ask before tools run');
    expect(html).toContain('Let the agent ask the user questions');
    expect(html).not.toContain('Per-tool settings');
    expect(html).not.toContain('Open requests');
  });

  it('an agent with no stored setting shows the table: it asks by default', () => {
    const html = panel(undefined);
    expect(html).toContain('Per-tool settings');
    expect(html).toContain('create_issue');
    expect(html).toContain('Open requests');
  });

  it('lists the tools and every request setting once approvals are on', () => {
    const html = panel({ toolApproval: { enabled: true, defaultPolicy: 'always', tools: { create_issue: 'never' } } });
    expect(html).toContain('Per-tool settings');
    expect(html).toContain('create_issue');
    expect(html).toContain('sandbox_exec');
    // Type column: an MCP tool without markings, a built-in that writes, a built-in that reads.
    expect(html).toContain('no hints');
    expect(html).toContain('>writes<');
    expect(html).toContain('>reads<');
    expect(html).toContain('does not ask');
    expect(html).toContain('Ask (default)');
    expect(html).toContain('Wait for an answer (minutes)');
    expect(html).toContain('When time runs out');
    expect(html).toContain('Who can answer');
    expect(html).toContain('A new message while waiting');
    expect(html).toContain('When nobody can answer (triggers, API bridges, evaluations)');
  });

  it('shows the unattended policy as deny by default, and the stored choice otherwise', () => {
    const on = { toolApproval: { enabled: true } };
    // Mantine renders the selected option's label into the select's input.
    expect(panel(on)).toContain('value="Deny the tool call"');
    expect(panel({ ...on, unattended: 'pause' })).toContain('value="Pause and wait for approval in Studio"');
    expect(panel({ ...on, unattended: 'allow' })).toContain('value="Run without approval"');
  });

  it('shows each tool\'s exceptions, or a way to add one', () => {
    const html = panel({
      toolApproval: { enabled: true, exceptions: { create_issue: [{ field: 'project', pattern: 'SEC*', action: 'deny' }] } },
    });
    expect(html).toContain('Exceptions');
    expect(html).toContain('1 exception');
    expect(html).toContain('aria-label="Exceptions of create_issue"');
    expect(html).toContain('aria-label="Exceptions of sandbox_exec"');
    expect(html).toContain('>Add<');
  });

  it('shows each bound tool with its source and type, and "Never ask" only for tools that are not read-only', () => {
    const html = render(h(AgentHumanInTheLoopPanel, {
      value: undefined,
      onChange: noop,
      toolConfig: {
        toolBindings: [
          { source: 'tool', sourceKey: 'notion', toolNames: ['delete_page'] },
          { source: 'tool', sourceKey: 'github', toolNames: ['search_code'] },
          { source: 'mcp', sourceKey: 'web', toolNames: ['fetch'] },
        ],
      },
      toolKinds: { delete_page: 'destructive', search_code: 'reads' },
    }));
    expect(html).toContain('>destructive<');
    expect(html).toContain('>reads<');
    expect(html).toContain('>no hints<');
    expect(html).toContain('tool · notion');
    // Two rows with the control (destructive, no hints); the read-only row says it does not ask.
    expect(html.match(/aria-label="(delete_page|fetch)"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-label="search_code"');
    expect(html).toContain('does not ask');
  });

  it('does not show the unattended policy when there is nothing that can pause', () => {
    expect(panel({ toolApproval: { enabled: false } })).not.toContain('When nobody can answer');
  });
});
