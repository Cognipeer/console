/**
 * The plan, sub-agent and summarization components of the session view, drawn
 * to static markup: PlanCard, PlanUpdateRow, PlanDock, SubagentGroup,
 * ParallelSubagents, CompactionDivider, the live turn (built by the reducers)
 * and the stored turn (built by buildTurnFlow) in order, the request cards'
 * "Show in group" link and the inspector's Plan, Events and Context tabs.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import CompactionDivider from '@/components/agents/session/CompactionDivider';
import LiveTurnFlow from '@/components/agents/session/LiveTurnFlow';
import PendingActionList from '@/components/agents/session/PendingActionCards';
import { PlanCard, PlanDock, PlanUpdateRow } from '@/components/agents/session/PlanCard';
import SessionPlanPanel from '@/components/agents/session/SessionPlanPanel';
import SessionSidePanel, { type SessionSidePanelProps } from '@/components/agents/session/SessionSidePanel';
import StoredTurnFlow from '@/components/agents/session/StoredTurnFlow';
import { ParallelSubagents, SubagentGroup } from '@/components/agents/session/SubagentGroup';
import { showInGroupTarget, type PendingActionView } from '@/components/agents/session/pendingActions';
import {
    applyLiveCompaction,
    applyLivePlan,
    applyLiveSubagent,
    applyLiveToolEvent,
    type LiveSegment,
} from '@/components/agents/session/liveFlow';
import { currentPlanOf, planChangeParts, planHistory } from '@/components/agents/session/planUi';
import { sessionEventRows } from '@/components/agents/session/sideFlowUi';
import type { ChatMessage } from '@/components/agents/session/sessionTypes';
import {
    legacyDelegationView,
    liveRunView,
    parallelGroupView,
    storedRunView,
} from '@/components/agents/session/subagentUi';
import {
    buildTurnFlow,
    compactionDividerView,
    delegationAnchorId,
    planAnchorId,
    showInGroupExpansion,
} from '@/components/agents/session/turnFlowUi';
import type {
    IAgentConversationStep,
    IAgentMessagePendingAction,
    IAgentPlanStep,
    IAgentTurnCompaction,
    IAgentTurnPlanSnapshot,
    IAgentTurnSubagentRun,
} from '@/lib/database/provider/types.domain';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
    renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;

const T = (seconds: number) => `2026-10-23T10:00:${String(seconds).padStart(2, '0')}.000Z`;

const planStep = (id: number, title: string, status: IAgentPlanStep['status'], extra: Partial<IAgentPlanStep> = {}): IAgentPlanStep => ({ id, title, status, ...extra });

function plan(version: number, statuses: Array<IAgentPlanStep['status']>, extra: Partial<IAgentTurnPlanSnapshot> = {}): IAgentTurnPlanSnapshot {
    return {
        version,
        operation: version === 1 ? 'write' : 'update',
        steps: statuses.map((status, i) => planStep(i + 1, `Do thing ${i + 1}`, status)),
        at: T(version),
        ...extra,
    };
}

const NOT = 'not-started' as const;
const NOW = 'in-progress' as const;
const DONE = 'completed' as const;
const planV1 = plan(1, [NOW, NOT, NOT, NOT, NOT]);
const planV2 = plan(2, [DONE, DONE, NOW, NOT, NOT]);

const call = (id: string, name: string, extra: Partial<IAgentConversationStep> = {}): IAgentConversationStep => ({ id, name, status: 'success', ...extra });

function storedRun(extra: Partial<IAgentTurnSubagentRun> = {}): IAgentTurnSubagentRun {
    return { id: 'sa_1', name: 'researcher', phase: 'result', steps: [], ...extra };
}

const bigPass: IAgentTurnCompaction = {
    at: T(5),
    id: 'p2',
    index: 2,
    tokensBefore: 84200,
    tokensAfter: 11900,
    durationMs: 3100,
    summary: { facts: [{ key: 'customer', value: '#4821' }] },
    compactedTools: [1, 2, 3, 4].map((n) => ({ toolName: 'web_search', toolCallId: `c${n}` })),
};

const before = (html: string, first: string, second: string) => {
    expect(html, first).toContain(first);
    expect(html, second).toContain(second);
    expect(html.indexOf(first), `${first} before ${second}`).toBeLessThan(html.indexOf(second));
};

/**
 * The number on each tool-call card, with the tool it is on, in page order. A card's badge is a text node of only
 * digits, and the tool's name follows it (with only tags between), so with the tags turned into separators it reads
 * `|1|||web_search|`.
 */
const cardNumbers = (html: string): Array<[string, string]> => {
    const text = html.replace(/<[^>]*>/g, '|');
    return [...text.matchAll(/\|(\d+)\|+(web_search|fetch|delegate_to|spawn_subagents_parallel|manage_plan)\|/g)].map((match): [string, string] => [match[1], match[2]]);
};

describe('PlanCard', () => {
    it('shows the first version in full: header, progress, every step, the one in progress badged', () => {
        const html = render(h(PlanCard, { plan: planV1, anchorId: planAnchorId(1) }));
        expect(html).toContain('data-testid="plan-card"');
        expect(html).toContain('id="flow-plan-v1"');
        expect(html).toContain('>Plan<');
        expect(html).toContain('v1 · created');
        expect(html).toContain('0 / 5 done');
        for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`${n} · Do thing ${n}`);
        expect(html).toContain('In progress');
        expect(html).not.toContain('Blocked');
    });

    it('calls a later version by its number, and badges a blocked step', () => {
        const html = render(h(PlanCard, { plan: plan(3, [DONE, 'blocked', NOT]) }));
        expect(html).toContain('v3');
        expect(html).not.toContain('v3 · created');
        expect(html).toContain('1 / 3 done');
        expect(html).toContain('Blocked');
    });

    it('speaks Turkish', () => {
        const html = render(h(PlanCard, { plan: planV1 }), 'tr');
        expect(html).toContain('v1 · oluşturuldu');
        expect(html).toContain('0 / 5 tamamlandı');
        expect(html).toContain('Sürüyor');
    });
});

describe('PlanUpdateRow', () => {
    const parts = planChangeParts(planV1, planV2);

    it('says what the version changed and how far the plan is', () => {
        const html = render(h(PlanUpdateRow, { plan: planV2, parts, anchorId: planAnchorId(2) }));
        expect(html).toContain('data-testid="plan-update"');
        expect(html).toContain('id="flow-plan-v2"');
        expect(html).toContain('Plan v2');
        expect(html).toContain('✓ 1, 2 done');
        expect(html).toContain('▶ 3 started');
        expect(html).toContain('2 / 5');
        expect(html).toContain('aria-label="Show plan version 2"');
        expect(html).toContain('aria-expanded="false"');
    });

    it('opens to the version when asked to', () => {
        const html = render(h(PlanUpdateRow, { plan: planV2, parts, defaultOpen: true }));
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain('aria-label="Hide plan version 2"');
    });

    it('has no chips for a version that changed nothing', () => {
        const html = render(h(PlanUpdateRow, { plan: planV1, parts: planChangeParts(planV1, planV1) }));
        expect(html).not.toContain('✓');
        expect(html).not.toContain('▶');
    });
});

describe('PlanDock', () => {
    it('draws nothing for a session without a plan', () => {
        expect(render(h(PlanDock, { plan: null }))).not.toContain('plan-dock');
        expect(render(h(PlanDock, { plan: undefined }))).not.toContain('plan-dock');
        expect(render(h(PlanDock, { plan: plan(1, []) }))).not.toContain('plan-dock');
    });

    it('is one line: progress and what the agent is on now', () => {
        const html = render(h(PlanDock, { plan: planV2 }));
        expect(html).toContain('data-testid="plan-dock"');
        expect(html).toContain('2 / 5 done');
        expect(html).toContain('Now:');
        expect(html).toContain('Do thing 3');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('aria-label="Expand plan"');
    });

    it('says so when every step is done', () => {
        const html = render(h(PlanDock, { plan: plan(4, [DONE, DONE]) }));
        expect(html).toContain('2 / 2 done');
        expect(html).toContain('All steps done');
        expect(html).not.toContain('Now:');
    });
});

describe('CompactionDivider', () => {
    it('reads as one line at the point it happened: pass, shrink, time, replaced tool results', () => {
        const html = render(h(CompactionDivider, {
            compaction: bigPass,
            view: compactionDividerView(bigPass, { index: 2 }),
            anchorId: 'flow-pass-1-p2',
        }));
        expect(html).toContain('data-testid="compaction-divider"');
        expect(html).toContain('id="flow-pass-1-p2"');
        expect(html).toContain('Context summarized');
        expect(html).toContain('pass 2');
        expect(html).toContain('84.2k → 11.9k tokens (−86%)');
        expect(html).toContain('3.1s');
        expect(html).toContain('4 tool results replaced');
        expect(html).toContain('aria-label="Show summary details"');
        // what it opens to: the facts the agent kept and the tools replaced
        expect(html).toContain('#4821');
        expect(html).toContain('web_search');
    });

    it('has no pass number inside a sub-agent group', () => {
        const html = render(h(CompactionDivider, { compaction: bigPass, view: compactionDividerView(bigPass) }));
        expect(html).not.toContain('pass 2');
        expect(html).toContain('84.2k → 11.9k tokens (−86%)');
    });

    it('says a pass that grew the context grew it', () => {
        const grew: IAgentTurnCompaction = { at: T(1), tokensBefore: 1000, tokensAfter: 1040 };
        expect(render(h(CompactionDivider, { compaction: grew, view: compactionDividerView(grew, { index: 1 }) }))).toContain('(+4%)');
    });

    it('shows a pass in the making with a spinner and no detail to open', () => {
        const pending: IAgentTurnCompaction & { phase: 'start' } = { at: T(1), id: 'p1', phase: 'start' };
        const html = render(h(CompactionDivider, { compaction: pending, view: compactionDividerView(pending) }));
        expect(html).toContain('Summarizing context…');
        expect(html).toContain('data-pending="true"');
        expect(html).not.toContain('Show summary details');
    });

    it('uses the fallback wording for a failed summarizer, and has nothing to open without a summary', () => {
        const failed: IAgentTurnCompaction = { at: T(1), failed: true, tokensBefore: 10, tokensAfter: 5 };
        const html = render(h(CompactionDivider, { compaction: failed, view: compactionDividerView(failed, { index: 1 }) }));
        expect(html).toContain('Context summarized (fallback)');
        expect(html).not.toContain('Show summary details');
    });

    it('lists the tool results it is given over its own, and speaks Turkish', () => {
        const html = render(h(CompactionDivider, {
            compaction: { ...bigPass, compactedTools: undefined },
            view: compactionDividerView(bigPass, { index: 2 }),
            compactedTools: [{ toolName: 'legacy_tool', toolCallId: 'x' }],
        }), 'tr');
        expect(html).toContain('legacy_tool');
        expect(html).toContain('Bağlam özetlendi');
        expect(html).toContain('2. geçiş');
    });
});

describe('SubagentGroup', () => {
    const finished = storedRun({
        mode: 'registry',
        target: { kind: 'ref', agentName: 'KB Researcher', version: 3 },
        parentToolCallId: 'call_1',
        input: 'Find the refund policy',
        result: 'Policy 4.2 applies\nsecond line',
        durationMs: 6100,
        usage: { totalTokens: 2100 },
        steps: [
            { id: 's1', name: 'kb_search', status: 'success', args: { query: 'refund policy' }, output: { hits: 3 }, durationMs: 400 },
            { id: 's2', name: 'kb_open', status: 'error', error: 'not found', _truncated: true },
        ],
        compactions: [{ at: T(3), id: 'cp1', afterToolCallId: 's1', tokensBefore: 31000, tokensAfter: 6200 }],
    });

    it('is a collapsed header with the result line once it is done', () => {
        const html = render(h(SubagentGroup, {
            view: storedRunView(finished),
            toolName: 'delegate_to',
            anchorId: delegationAnchorId('call_1'),
        }));
        expect(html).toContain('data-testid="subagent-group"');
        expect(html).toContain('id="flow-delegation-call_1"');
        expect(html).toContain('>researcher<');
        expect(html).toContain('Registry · KB Researcher v3');
        expect(html).toContain('delegate_to');
        expect(html).toContain('Done');
        expect(html).toContain('2 steps · 6.1s · 2.1k tok');
        expect(html).toContain('Result: Policy 4.2 applies');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('aria-label="Expand researcher"');
    });

    it('draws the task, the steps, its own summarization divider and the answer', () => {
        const html = render(h(SubagentGroup, { view: storedRunView(finished), expanded: true }));
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain('Task: ');
        expect(html).toContain('Find the refund policy');
        expect(html).toContain('kb_search');
        expect(html).toContain('refund policy');
        expect(html).toContain('cut when stored');
        expect(html).toContain('data-testid="compaction-divider"');
        // the pass is the sub-agent's own: no pass number
        expect(html).not.toContain('pass 1');
        // steps and pass in the order they happened
        before(html, 'kb_search', 'data-testid="compaction-divider"');
        before(html, 'data-testid="compaction-divider"', 'kb_open');
        expect(html).toContain('Policy 4.2 applies');
    });

    it('starts open while it runs, and says "waiting for approval" when it waits for a person', () => {
        const running = render(h(SubagentGroup, { view: liveRunView({ id: 'sa_2', name: 'billing', phase: 'start', steps: [], compactions: [] }) }));
        expect(running).toContain('Running');
        expect(running).toContain('aria-expanded="true"');
        expect(running).toContain('No steps yet');
        // A request of its own is open: the run waits for the person.
        const open: IAgentMessagePendingAction = { id: 'act_3', kind: 'tool_approval', status: 'pending', delegationToolCallId: 'call_3', subagent: 'billing' };
        const paused = storedRun({ id: 'sa_3', name: 'billing', phase: 'paused', status: 'needs_input', parentToolCallId: 'call_3' });
        const waiting = render(h(SubagentGroup, { view: storedRunView(paused, [open]) }));
        expect(waiting).toContain('Waiting for approval');
        expect(waiting).toContain('data-status="paused"');
        expect(waiting).toContain('aria-expanded="true"');
    });

    it('says "continued below", closed, for a run that paused and went on in the next message - not "waiting for approval"', () => {
        const answered: IAgentMessagePendingAction = { id: 'act_3', kind: 'tool_approval', status: 'resolved', delegationToolCallId: 'call_3', subagent: 'billing' };
        const paused = storedRun({ id: 'sa_3', name: 'billing', phase: 'paused', status: 'needs_input', parentToolCallId: 'call_3' });
        for (const pending of [[answered], undefined]) {
            const html = render(h(SubagentGroup, { view: storedRunView(paused, pending) }));
            expect(html).toContain('Continued below');
            expect(html).toContain('data-status="continued"');
            expect(html).not.toContain('Waiting for approval');
            expect(html).toContain('aria-expanded="false"');
        }
        const turkish = render(h(SubagentGroup, { view: storedRunView(paused) }), 'tr');
        expect(turkish).toContain('Aşağıda devam etti');
        expect(turkish).not.toContain('Onay bekliyor');
        // A run that is working or waiting right now keeps saying so.
        const live = render(h(SubagentGroup, { view: liveRunView({ id: 'sa_4', name: 'billing', phase: 'paused', steps: [], compactions: [] }) }));
        expect(live).toContain('Waiting for approval');
        expect(live).not.toContain('Continued below');
    });

    it('words the labels of a step\'s payload in the reader\'s language', () => {
        const english = render(h(SubagentGroup, { view: storedRunView(finished), expanded: true }));
        for (const label of ['args', 'result', 'error']) expect(english, label).toContain(`>${label}<`);
        const turkish = render(h(SubagentGroup, { view: storedRunView(finished), expanded: true }), 'tr');
        for (const label of ['argümanlar', 'sonuç', 'hata']) expect(turkish, label).toContain(`>${label}<`);
        for (const label of ['args', 'result', 'error']) expect(turkish, label).not.toContain(`>${label}<`);
    });

    it('opens failed and shows why', () => {
        const html = render(h(SubagentGroup, { view: storedRunView(storedRun({ phase: 'error', error: 'model refused' })) }));
        expect(html).toContain('Failed');
        expect(html).toContain('model refused');
        expect(html).toContain('aria-expanded="true"');
    });

    it('marks a run that continues an earlier leg, and the steps past the stored cap', () => {
        const html = render(h(SubagentGroup, { view: storedRunView(storedRun({ resumed: true, stepsDropped: 7 })), expanded: true }));
        expect(html).toContain('continued');
        expect(html).toContain('7 more steps were not kept');
        expect(html).toContain('7 steps');
    });

    it('says "steps not recorded" for a delegation stored before runs were, with its call in full', () => {
        const step = call('call_9', 'delegate_to', { args: { agent: 'researcher', task: 'Look it up' }, output: 'the answer' });
        const html = render(h(SubagentGroup, { view: legacyDelegationView(step), toolName: 'delegate_to', legacyStep: step, expanded: true }));
        expect(html).toContain('steps not recorded');
        expect(html).toContain('Look it up');
        expect(html).toContain('the answer');
        expect(html).toContain('stored before sub-agent steps were recorded');
    });

    it('lets the caller hold the open state', () => {
        const view = storedRunView(finished);
        expect(render(h(SubagentGroup, { view, expanded: false }))).toContain('aria-expanded="false"');
        expect(render(h(SubagentGroup, { view: storedRunView(storedRun({ phase: 'error', error: 'x' })), expanded: false }))).toContain('aria-expanded="false"');
    });
});

describe('ParallelSubagents', () => {
    const approval = { id: 'act_1', kind: 'tool_approval', status: 'pending', delegationToolCallId: 'call_2', subagent: 'billing-checker' } as IAgentMessagePendingAction;
    const runs = [
        storedRunView(storedRun({ id: 'sa_a', name: 'billing-checker', phase: 'start', parentToolCallId: 'call_2', parallel: true, steps: [{ id: 'x', name: 'get_invoice', status: 'success' }] }), [approval]),
        storedRunView(storedRun({ id: 'sa_b', name: 'payments-log', parentToolCallId: 'call_2', parallel: true, mode: 'adhoc', durationMs: 5100 })),
    ];

    it('is one container: how many, which call, how far, how long, what waits for a person', () => {
        const html = render(h(ParallelSubagents, { runs, toolName: 'spawn_subagents_parallel', anchorId: delegationAnchorId('call_2') }));
        expect(html).toContain('data-testid="parallel-subagents"');
        expect(html).toContain('id="flow-delegation-call_2"');
        expect(html).toContain('2 sub-agents');
        expect(html).toContain('spawn_subagents_parallel');
        expect(html).toContain('1 / 2 done');
        expect(html).toContain('5.1s');
        expect(html).toContain('1 approval');
        // one group per run, the one waiting open
        expect(html.match(/data-testid="subagent-group"/g)).toHaveLength(2);
        expect(html).toContain('billing-checker');
        expect(html).toContain('payments-log');
        expect(html).toContain('Waiting for approval');
    });

    it('counts a run that went on in the next message as done, and does not say the container waits', () => {
        const continued = [
            storedRunView(storedRun({ id: 'sa_a', name: 'a', phase: 'paused', parentToolCallId: 'call_2#0', parallel: true })),
            storedRunView(storedRun({ id: 'sa_b', name: 'b', parentToolCallId: 'call_2#1', parallel: true })),
        ];
        const html = render(h(ParallelSubagents, { runs: continued }));
        expect(html).toContain('2 / 2 done');
        expect(html).toContain('Continued below');
        expect(html).not.toContain('Waiting for approval');
    });

    it('takes the header figures it is given', () => {
        const group = parallelGroupView(runs);
        expect(render(h(ParallelSubagents, { runs, group }))).toContain('1 / 2 done');
        expect(render(h(ParallelSubagents, { runs, expanded: false }))).toContain('aria-label="Expand the sub-agents"');
    });

    it('opens the run a request belongs to when the caller says so', () => {
        const html = render(h(ParallelSubagents, { runs, runExpanded: { sa_b: true } }));
        expect(html.match(/aria-expanded="true"/g)!.length).toBeGreaterThanOrEqual(3);
    });
});

describe('the live turn, in the order it happens', () => {
    function liveTurn(): LiveSegment[] {
        let segments: LiveSegment[] = [];
        segments = applyLivePlan(segments, planV1, null);
        segments = applyLiveToolEvent(segments, { phase: 'start', name: 'delegate_to', id: 'd1', args: {} });
        segments = applyLiveSubagent(segments, { phase: 'start', id: 'sa_1', name: 'researcher', parentToolCallId: 'd1', input: 'Find it', at: T(1) });
        segments = applyLiveCompaction(segments, { at: T(2), id: 'p1', phase: 'start' });
        segments = applyLivePlan(segments, planV2, null);
        return segments;
    }

    it('draws the plan, the sub-agent, the pass being made and the plan update where each happened', () => {
        const html = render(h(LiveTurnFlow, { segments: liveTurn() }));
        before(html, 'data-testid="plan-card"', 'data-testid="subagent-group"');
        before(html, 'data-testid="subagent-group"', 'data-testid="compaction-divider"');
        before(html, 'data-testid="compaction-divider"', 'data-testid="plan-update"');
        expect(html).toContain('Summarizing context…');
        expect(html).toContain('researcher');
        expect(html).toContain('Running');
        expect(html).toContain('Plan v2');
        expect(html).toContain('✓ 1, 2 done');
    });

    it('says "Generating…" when the turn ends on a plan or a settled sub-agent', () => {
        expect(render(h(LiveTurnFlow, { segments: applyLivePlan([], planV1, null) }))).toContain('Generating…');
        expect(render(h(LiveTurnFlow, { segments: liveTurn() }))).toContain('Generating…');
    });

    it('is not generating while a sub-agent still works', () => {
        let segments: LiveSegment[] = [];
        segments = applyLiveToolEvent(segments, { phase: 'start', name: 'delegate_to', id: 'd1' });
        segments = applyLiveSubagent(segments, { phase: 'start', id: 'sa_1', name: 'researcher', parentToolCallId: 'd1', at: T(1) });
        expect(render(h(LiveTurnFlow, { segments }))).not.toContain('Generating…');
    });

    it('puts the children of a parallel spawn in one container', () => {
        let segments: LiveSegment[] = [];
        segments = applyLiveToolEvent(segments, { phase: 'start', name: 'spawn_subagents_parallel', id: 'p1' });
        for (const id of ['sa_a', 'sa_b']) {
            segments = applyLiveSubagent(segments, { phase: 'start', id, name: `worker-${id}`, parentToolCallId: 'p1', parallel: true, at: T(1) });
        }
        segments = applyLiveSubagent(segments, { phase: 'result', id: 'sa_a', name: 'worker-sa_a', parentToolCallId: 'p1', parallel: true, content: 'ok', at: T(2) });
        const html = render(h(LiveTurnFlow, { segments }));
        expect(html).toContain('data-testid="parallel-subagents"');
        expect(html).toContain('2 sub-agents');
        expect(html).toContain('1 / 2 done');
        expect(html).toContain('spawn_subagents_parallel');
        expect(html).toContain('id="flow-delegation-p1"');
    });

    it('puts the children of a parallel spawn keyed <call>#<n> in the one container of the call', () => {
        let segments: LiveSegment[] = [];
        segments = applyLiveToolEvent(segments, { phase: 'start', name: 'spawn_subagents_parallel', id: 'p1' });
        segments = applyLiveToolEvent(segments, { phase: 'start', name: 'delegate_to', id: 'd2' });
        segments = applyLiveSubagent(segments, { phase: 'start', id: 'sa_a', name: 'worker-a', parentToolCallId: 'p1#0', parallel: true, at: T(1) });
        segments = applyLiveSubagent(segments, { phase: 'start', id: 'sa_b', name: 'worker-b', parentToolCallId: 'p1#1', parallel: true, at: T(1) });
        const html = render(h(LiveTurnFlow, { segments }));
        expect(html.match(/data-testid="parallel-subagents"/g)).toHaveLength(1);
        expect(html.match(/data-testid="subagent-group"/g)).toHaveLength(2);
        expect(html).toContain('2 sub-agents');
        // One anchor, the call's: not one per child key.
        expect(html.match(/id="flow-delegation-p1"/g)).toHaveLength(1);
        expect(html).not.toContain('flow-delegation-p1_');
        expect(html).not.toContain('flow-delegation-p1#');
    });

    it('draws one group, with no ghost run beside it, when the rows of a delegation name its sub-agent', () => {
        let segments: LiveSegment[] = [];
        segments = applyLiveToolEvent(segments, { phase: 'start', name: 'delegate_to', id: 'd1', subagent: { name: 'researcher' } });
        segments = applyLiveSubagent(segments, { phase: 'start', id: 'sa_1', name: 'researcher', parentToolCallId: 'd1', at: T(1) });
        segments = applyLiveToolEvent(segments, { phase: 'success', name: 'delegate_to', id: 'd1', subagent: { name: 'researcher' }, durationMs: 5 });
        const html = render(h(LiveTurnFlow, { segments }));
        expect(html.match(/data-testid="subagent-group"/g)).toHaveLength(1);
        expect(html).not.toContain('parallel-subagents');
    });

    it('shows a delegation call that has not been answered by a sub-agent yet as a running row', () => {
        const segments = applyLiveToolEvent([], { phase: 'start', name: 'delegate_to', id: 'd1' });
        const html = render(h(LiveTurnFlow, { segments }));
        expect(html).toContain('delegate_to');
        expect(html).not.toContain('data-testid="subagent-group"');
    });

    it('numbers the agent\'s own passes, and a pass of a sub-agent goes into its group', () => {
        let segments: LiveSegment[] = [];
        segments = applyLiveCompaction(segments, { at: T(1), id: 'a', tokensBefore: 100, tokensAfter: 50 });
        segments = applyLiveToolEvent(segments, { phase: 'start', name: 'delegate_to', id: 'd1' });
        segments = applyLiveSubagent(segments, { phase: 'start', id: 'sa_1', name: 'researcher', parentToolCallId: 'd1', at: T(2) });
        segments = applyLiveCompaction(segments, { at: T(3), id: 'child', tokensBefore: 300, tokensAfter: 100, subagent: { id: 'sa_1', name: 'researcher' } });
        segments = applyLiveCompaction(segments, { at: T(4), id: 'b', tokensBefore: 200, tokensAfter: 40 });
        const html = render(h(LiveTurnFlow, { segments }));
        expect(html).toContain('pass 1');
        expect(html).toContain('pass 2');
        expect(html).not.toContain('pass 3');
        expect(html.match(/data-testid="compaction-divider"/g)).toHaveLength(3);
    });
});

describe('the stored turn, in the same order', () => {
    const message = {
        steps: [
            call('c1', 'lookup_customer', { narration: 'Looking the customer up', timestamp: T(0) }),
            call('call_plan', 'manage_plan', { timestamp: T(1) }),
            call('d1', 'delegate_to', { timestamp: T(2) }),
        ],
        plans: [{ ...planV1, toolCallId: 'call_plan' }],
        subagentRuns: [storedRun({ parentToolCallId: 'd1', steps: [{ id: 's1', name: 'kb_search', status: 'success' }] })],
        compactions: [{ at: T(9), id: 'p1', index: 1, afterToolCallId: 'd1', tokensBefore: 800, tokensAfter: 200 }],
    };
    const noExpansion = { state: {}, set: noop };

    it('draws narration, the call, the plan, the group and the pass in the order they happened', () => {
        const blocks = buildTurnFlow(message, { messageIndex: 1 });
        const html = render(h(StoredTurnFlow, { blocks, message, expansion: noExpansion }));
        const marks = ['Looking the customer up', 'lookup_customer', 'data-testid="plan-card"', 'data-testid="subagent-group"', 'data-testid="compaction-divider"'];
        for (let i = 1; i < marks.length; i += 1) before(html, marks[i - 1], marks[i]);
        // a plan call that wrote a plan is its plan row, not a tool call
        expect(html).not.toContain('manage_plan');
        expect(html).toContain('id="flow-pass-1-p1"');
        expect(html).toContain('id="flow-delegation-d1"');
    });

    it('draws the first plan of the turn in full and the next ones as updates', () => {
        const twoPlans = {
            ...message,
            steps: [...message.steps, call('call_plan2', 'manage_plan', { timestamp: T(3) })],
            plans: [{ ...planV1, toolCallId: 'call_plan' }, { ...planV2, toolCallId: 'call_plan2' }],
        };
        const html = render(h(StoredTurnFlow, { blocks: buildTurnFlow(twoPlans), message: twoPlans, expansion: noExpansion }));
        expect(html.match(/data-testid="plan-card"/g)).toHaveLength(1);
        expect(html.match(/data-testid="plan-update"/g)).toHaveLength(1);
        expect(html).toContain('✓ 1, 2 done');
    });

    it('compares the first plan with the one an earlier turn left', () => {
        const turn = { steps: [call('call_plan', 'manage_plan')], plans: [{ ...planV2, toolCallId: 'call_plan' }] };
        const html = render(h(StoredTurnFlow, { blocks: buildTurnFlow(turn, { previousPlan: planV1 }), message: {}, expansion: noExpansion }));
        expect(html).toContain('data-testid="plan-card"');
        expect(html).toContain('v2');
    });

    it('names the replaced tool results once, on the last pass, for a turn stored before passes kept their own', () => {
        const old = {
            steps: [call('c1', 'web_search', { timestamp: T(0) })],
            compactions: [{ at: T(1), tokensBefore: 10, tokensAfter: 5 }, { at: T(2), tokensBefore: 5, tokensAfter: 3 }],
            compactedTools: [{ toolName: 'legacy_tool', toolCallId: 'c1' }],
        };
        const html = render(h(StoredTurnFlow, { blocks: buildTurnFlow(old), message: old, expansion: noExpansion }));
        expect(html.match(/legacy_tool/g)).toHaveLength(1);
        // a pass with its own list shows that list, not the turn's
        const own = {
            ...old,
            compactions: [{ at: T(1), tokensBefore: 10, tokensAfter: 5, compactedTools: [{ toolName: 'own_tool', toolCallId: 'c1' }] }, old.compactions[1]],
        };
        const ownHtml = render(h(StoredTurnFlow, { blocks: buildTurnFlow(own), message: own, expansion: noExpansion }));
        expect(ownHtml).toContain('own_tool');
        expect(ownHtml.match(/legacy_tool/g)).toHaveLength(1);
    });

    it('shows a delegation stored before runs were as a group that says its steps were not recorded', () => {
        const old = { steps: [call('d1', 'delegate_to', { args: { agent: 'researcher', task: 'Look it up' }, output: 'done' })] };
        const html = render(h(StoredTurnFlow, { blocks: buildTurnFlow(old), message: {}, expansion: noExpansion }));
        expect(html).toContain('steps not recorded');
        expect(html).toContain('id="flow-delegation-d1"');
    });

    describe('numbers its tool-call cards the way the Events tab numbers the calls', () => {
        const turn = (extra: Partial<ChatMessage>): ChatMessage => ({ role: 'assistant', content: 'a', ...extra });
        const cardsOf = (stored: ChatMessage) => cardNumbers(render(h(StoredTurnFlow, { blocks: buildTurnFlow(stored), message: stored, expansion: noExpansion })));
        const asked: ChatMessage = { role: 'user', content: 'hi' };
        const eventsOf = (stored: ChatMessage) => sessionEventRows([asked, stored])
            .flatMap((row): Array<[string, string]> => (row.kind === 'step' ? [[String(row.number), row.step.name]] : []));

        it('counts a delegation that ran as a call, so the call after it is the third', () => {
            const stored = turn({
                steps: [call('a', 'web_search'), call('d1', 'delegate_to'), call('b', 'fetch')],
                subagentRuns: [storedRun({ parentToolCallId: 'd1' })],
            });
            // A delegation that ran is its group, not a card; the calls around it keep the numbers the tab gives them.
            expect(cardsOf(stored)).toEqual([['1', 'web_search'], ['3', 'fetch']]);
            expect(eventsOf(stored)).toEqual([['1', 'web_search'], ['2', 'delegate_to'], ['3', 'fetch']]);
        });

        it('gives a delegation stored without runs, on its card inside the group, the number the tab gives it', () => {
            const stored = turn({
                steps: [call('a', 'web_search'), call('d1', 'delegate_to', { args: { agent: 'researcher', task: 'Look it up' } }), call('b', 'fetch')],
            });
            expect(cardsOf(stored)).toEqual([['1', 'web_search'], ['2', 'delegate_to'], ['3', 'fetch']]);
            expect(cardsOf(stored)).toEqual(eventsOf(stored));
        });

        it('does not count a plan call, whether it wrote a version or only read the plan', () => {
            const stored = turn({
                steps: [call('a', 'web_search'), call('call_plan', 'manage_plan'), call('b', 'fetch'), call('read', 'manage_plan'), call('c', 'web_search')],
                plans: [{ ...planV1, toolCallId: 'call_plan' }],
            });
            expect(cardsOf(stored)).toEqual([['1', 'web_search'], ['2', 'fetch'], ['3', 'web_search']]);
            expect(eventsOf(stored)).toEqual(cardsOf(stored));
        });

        it('counts a plan call as a call when the turn does not record plan versions (stored before they were)', () => {
            const stored = turn({ steps: [call('p1', 'manage_plan'), call('a', 'web_search')] });
            expect(cardsOf(stored)).toEqual([['1', 'manage_plan'], ['2', 'web_search']]);
            expect(eventsOf(stored)).toEqual(cardsOf(stored));
        });

        it('leaves out a plan call that read the plan when the turn sent an empty plan list, here as in the tab', () => {
            const stored = turn({ steps: [call('read', 'manage_plan'), call('a', 'web_search')], plans: [] });
            expect(cardsOf(stored)).toEqual([['1', 'web_search']]);
            expect(eventsOf(stored)).toEqual(cardsOf(stored));
        });
    });

    it('anchors the groups of a parallel call at the call, however the runs\' keys read (<call>#<n>)', () => {
        const children = {
            subagentRuns: [
                storedRun({ id: 'sa_a', name: 'a', parentToolCallId: 'p1#0', parallel: true }),
                storedRun({ id: 'sa_b', name: 'b', parentToolCallId: 'p1#1', parallel: true }),
            ],
        };
        const groups = buildTurnFlow(children).filter((block) => block.kind === 'subagents');
        expect(groups.length).toBeGreaterThan(0);
        for (const group of groups) expect(group.kind === 'subagents' ? group.anchorId : undefined).toBe('flow-delegation-p1');
    });

    it('opens the container of a parallel call, and the run it names, for a request one of its children raised', () => {
        const parallel = {
            steps: [call('p1', 'spawn_subagents_parallel')],
            subagentRuns: [
                storedRun({ id: 'sa_a', name: 'a', parentToolCallId: 'p1', parallel: true }),
                storedRun({ id: 'sa_b', name: 'b', parentToolCallId: 'p1', parallel: true }),
            ],
        };
        const blocks = buildTurnFlow(parallel);
        const target = showInGroupTarget({ delegationToolCallId: 'p1#1', subagent: 'a' });
        expect(target).toEqual({ delegationToolCallId: 'p1', subagent: 'a' });
        const state = showInGroupExpansion(blocks, 'p1#1', 'a');
        expect(state).toEqual({ 'call:p1': true, 'run:sa_a': true });
        const closed = render(h(StoredTurnFlow, { blocks, message: {}, expansion: { state: { 'call:p1': false }, set: noop } }));
        expect(closed).toContain('aria-label="Expand the sub-agents"');
        const opened = render(h(StoredTurnFlow, { blocks, message: {}, expansion: { state, set: noop } }));
        expect(opened).toContain('aria-label="Collapse the sub-agents"');
        expect(opened).toContain('aria-label="Collapse a"');
        expect(opened).toContain('aria-label="Expand b"');
    });

    it('opens the groups the caller holds open', () => {
        const blocks = buildTurnFlow(message, { messageIndex: 1 });
        const closed = render(h(StoredTurnFlow, { blocks, message, expansion: { state: { 'run:sa_1': false }, set: noop } }));
        expect(closed).toContain('aria-expanded="false"');
        const open = render(h(StoredTurnFlow, { blocks, message, expansion: { state: { 'run:sa_1': true }, set: noop } }));
        expect(open).toContain('aria-expanded="true"');
    });
});

describe('requests raised inside a sub-agent', () => {
    const approval: PendingActionView = {
        id: 'act_1', kind: 'tool_approval', status: 'pending', toolName: 'issue_refund', args: { amount: 49 },
        subagent: 'billing-checker', delegationToolCallId: 'call_2',
    };
    const question: PendingActionView = {
        id: 'q_1', kind: 'user_question', status: 'pending', subagent: 'billing-checker', delegationToolCallId: 'call_2',
        questions: [{ question: 'Which invoice?', options: [{ label: 'INV-311' }, { label: 'INV-312' }] }],
    };

    it('name the sub-agent on both cards - a question had no badge before', () => {
        const html = render(h(PendingActionList, { actions: [approval, question], busy: false, onResolve: noop }));
        expect(html.match(/Asked by sub-agent billing-checker/g)).toHaveLength(2);
    });

    it('link back to the group when the page can open it', () => {
        const html = render(h(PendingActionList, { actions: [approval, question], busy: false, onResolve: noop, onShowInGroup: noop }));
        expect(html.match(/Show in group ›/g)).toHaveLength(2);
        expect(render(h(PendingActionList, { actions: [approval], busy: false, onResolve: noop }))).not.toContain('Show in group');
    });

    it('link to the group of the call when a child of a parallel spawn raised them, which keys them <call>#<n>', () => {
        const child: PendingActionView = { ...approval, delegationToolCallId: 'call_2#1' };
        const html = render(h(PendingActionList, { actions: [child], busy: false, onResolve: noop, onShowInGroup: noop }));
        expect(html.match(/Show in group ›/g)).toHaveLength(1);
        // What the link hands over is the call the group is anchored at.
        expect(showInGroupTarget(child)).toEqual({ delegationToolCallId: 'call_2', subagent: 'billing-checker' });
        expect(delegationAnchorId(showInGroupTarget(child)!.delegationToolCallId)).toBe(delegationAnchorId('call_2#1'));
        expect(showInGroupTarget(approval)).toEqual({ delegationToolCallId: 'call_2', subagent: 'billing-checker' });
        // A request that names no sub-agent hands over the call alone.
        expect(showInGroupTarget({ ...child, subagent: undefined })).toEqual({ delegationToolCallId: 'call_2' });
        // A '#' that is not a child's index is part of the call's id.
        expect(showInGroupTarget({ delegationToolCallId: 'call_2#x' })).toEqual({ delegationToolCallId: 'call_2#x' });
    });

    it('have no link when the request did not come from a delegation', () => {
        expect(showInGroupTarget({ delegationToolCallId: undefined, subagent: 'billing-checker' })).toBeNull();
        expect(showInGroupTarget({ delegationToolCallId: '' })).toBeNull();
        const plain: PendingActionView = { id: 'act_2', kind: 'tool_approval', status: 'pending', toolName: 'sandbox_exec', args: {} };
        const html = render(h(PendingActionList, { actions: [plain], busy: false, onResolve: noop, onShowInGroup: noop }));
        expect(html).not.toContain('Show in group');
        expect(html).not.toContain('Asked by sub-agent');
    });
});

describe('the inspector', () => {
    const assistant: ChatMessage = {
        role: 'assistant',
        content: 'done',
        steps: [
            call('c1', 'web_search', { timestamp: T(0) }),
            call('call_plan', 'manage_plan', { timestamp: T(1) }),
            call('d1', 'delegate_to', { timestamp: T(2) }),
        ],
        plans: [
            { ...planV1, toolCallId: 'call_plan', at: '2026-10-23T14:02:11.000Z' },
        ],
        subagentRuns: [storedRun({
            parentToolCallId: 'd1',
            steps: [{ id: 's1', name: 'kb_search', status: 'success' }],
            compactions: [{ at: T(3), id: 'cp', tokensBefore: 300, tokensAfter: 100 }],
        })],
        compactions: [{ at: T(9), id: 'p1', index: 1, afterToolCallId: 'c1', tokensBefore: 800, tokensAfter: 200 }],
    };
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }, assistant];
    const panel = (extra: Partial<SessionSidePanelProps> = {}, locale: 'en' | 'tr' = 'en') => render(h(SessionSidePanel, {
        agentId: 'a1', sessionId: 's1', status: 'idle', activityKey: '0', agentName: 'Agent', agentKey: 'agent',
        pinnedVersion: '', messages, onGoToTurn: noop, ...extra,
    }), locale);

    it('has a Plan tab only when the session has a plan', () => {
        expect(panel()).not.toContain('Current plan');
        const current = currentPlanOf({ messages });
        expect(current).not.toBeNull();
        const html = panel({ plan: current });
        expect(html).toContain('Current plan');
        expect(html).toContain('data-testid="plan-panel"');
        expect(panel({ plan: current }, 'tr')).toContain('Güncel plan');
    });

    it('lists each turn in order: plan version, sub-agent with its steps indented under it, summaries', () => {
        const html = panel();
        before(html, 'web_search', 'Context summarized · pass 1');
        before(html, 'Context summarized · pass 1', 'manage_plan v1');
        before(html, 'manage_plan v1', 'Sub-agent researcher');
        before(html, 'Sub-agent researcher', 'kb_search');
    });

    it('labels each pass of the Context tab with its turn, number and place - a sub-agent pass with its name', () => {
        const html = panel();
        expect(html).toContain('Turn 1 · pass 1 · after web_search');
        expect(html).toContain('Turn 1 · researcher');
    });

    it('falls back to the turn for a pass stored without a position', () => {
        const old: ChatMessage[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok', compactions: [{ at: T(1), tokensBefore: 10, tokensAfter: 5 }] }];
        expect(panel({ messages: old })).toContain('>Turn 1<');
    });

    it('says a pass was made at the start of the turn', () => {
        const start: ChatMessage[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok', compactions: [{ at: T(1), afterToolCallId: null }] }];
        expect(panel({ messages: start })).toContain('Turn 1 · pass 1 · at turn start');
    });
});

describe('SessionPlanPanel', () => {
    const messages = [
        { role: 'user', plans: undefined },
        { role: 'assistant', plans: [{ ...planV1, at: '2026-10-23T14:02:11.000Z' }, { ...planV2, at: '2026-10-23T14:02:40.000Z' }] },
    ];
    const current = currentPlanOf({ messages });

    it('shows the current plan with owner, exit criteria and evidence, and the versions it went through', () => {
        const detailed: IAgentTurnPlanSnapshot = {
            ...planV2,
            steps: [
                planStep(1, 'Look up the customer', DONE, { owner: 'agent', exitCriteria: 'both invoices found', evidence: 'INV-311 and INV-312' }),
                planStep(2, 'Find the refund policy', NOW),
            ],
        };
        const html = render(h(SessionPlanPanel, {
            current: { plan: detailed, source: 'message' },
            history: planHistory(messages),
            onGoTo: noop,
        }));
        expect(html).toContain('Current plan');
        expect(html).toContain('>v2<');
        expect(html).toContain('50%');
        expect(html).toContain('owner agent · exit: both invoices found');
        expect(html).toContain('Evidence: INV-311 and INV-312');
        expect(html).toContain('History');
        expect(html).toContain('created · 5 steps');
        expect(html).toContain('✓ 1, 2 · ▶ 3');
    });

    it('says so when no version was recorded (the plan came from the session)', () => {
        const html = render(h(SessionPlanPanel, { current: current!, history: [], onGoTo: noop }));
        expect(html).toContain('No plan versions were recorded in this session yet.');
    });
});
