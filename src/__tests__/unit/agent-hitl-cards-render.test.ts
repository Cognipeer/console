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

  it('shows only the switches for an agent that never pauses', () => {
    const html = panel(undefined);
    expect(html).toContain('Ask before tools run');
    expect(html).toContain('Let the agent ask the user questions');
    expect(html).not.toContain('Per-tool settings');
    expect(html).not.toContain('Open requests');
  });

  it('lists the tools and every request setting once approvals are on', () => {
    const html = panel({ toolApproval: { enabled: true, defaultPolicy: 'always', tools: { create_issue: 'never' } } });
    expect(html).toContain('Per-tool settings');
    expect(html).toContain('create_issue');
    expect(html).toContain('sandbox_exec');
    expect(html).toContain('Read-only, not asked by default');
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

  it('does not show the unattended policy when there is nothing that can pause', () => {
    expect(panel(undefined)).not.toContain('When nobody can answer');
  });
});
