/**
 * How the agent's plan reads in the session view (components/agents/session/planUi.ts):
 * step statuses, the chips of what a version changed, which plan is current and
 * the list of versions a session went through.
 */
import { describe, expect, it } from 'vitest';
import { planDiff } from '@/lib/shared/agentTurnFlow';
import {
    currentPlanOf,
    planChangeParts,
    planDiffLabel,
    planHistory,
    planPercent,
    planStatusView,
    planStepLabel,
} from '@/components/agents/session/planUi';
import type { LiveSegment } from '@/components/agents/session/liveFlow';
import type { AgentPlanStepStatus, IAgentPlanStep, IAgentTurnPlanSnapshot } from '@/lib/database/provider/types.domain';

const step = (id: number, status: AgentPlanStepStatus, title = `Step ${id}`): IAgentPlanStep => ({ id, title, status });

function plan(version: number, steps: IAgentPlanStep[], extra: Partial<IAgentTurnPlanSnapshot> = {}): IAgentTurnPlanSnapshot {
    return { version, operation: version === 1 ? 'write' : 'update', steps, at: `2026-10-23T10:00:0${version}.000Z`, ...extra };
}

describe('planStatusView', () => {
    it('gives every status its icon, color and wording', () => {
        expect(planStatusView('not-started')).toEqual({ status: 'not-started', icon: 'circle-dashed', color: 'gray', labelKey: 'planStatusNotStarted' });
        expect(planStatusView('in-progress')).toEqual({ status: 'in-progress', icon: 'player-play', color: 'blue', labelKey: 'planStatusInProgress' });
        expect(planStatusView('completed')).toEqual({ status: 'completed', icon: 'circle-check', color: 'teal', labelKey: 'planStatusCompleted' });
        expect(planStatusView('blocked')).toEqual({ status: 'blocked', icon: 'alert-triangle', color: 'orange', labelKey: 'planStatusBlocked' });
    });

    it('reads a status it does not know, or none, as not started', () => {
        expect(planStatusView('paused').status).toBe('not-started');
        expect(planStatusView(undefined).labelKey).toBe('planStatusNotStarted');
    });
});

describe('planStepLabel and planPercent', () => {
    it('writes a step as "id · title"', () => {
        expect(planStepLabel({ id: 3, title: 'Write the report' })).toBe('3 · Write the report');
        expect(planStepLabel({ id: 'a1', title: 'x' })).toBe('a1 · x');
    });

    it('rounds completed over all steps, and is 0 for no plan or no steps', () => {
        expect(planPercent(plan(1, [step(1, 'completed'), step(2, 'in-progress'), step(3, 'not-started'), step(4, 'not-started')]))).toBe(25);
        expect(planPercent(plan(1, [step(1, 'completed'), step(2, 'not-started'), step(3, 'not-started')]))).toBe(33);
        expect(planPercent(plan(1, [step(1, 'completed'), step(2, 'completed')]))).toBe(100);
        expect(planPercent(plan(1, []))).toBe(0);
        expect(planPercent(null)).toBe(0);
        expect(planPercent(undefined)).toBe(0);
    });
});

describe('planDiffLabel', () => {
    it('lists what changed in a fixed order, with the ids in plan order', () => {
        const before = plan(1, [step(1, 'in-progress'), step(2, 'not-started'), step(3, 'not-started'), step(5, 'not-started')]);
        const after = plan(2, [step(1, 'completed'), step(2, 'completed'), step(3, 'in-progress'), step(4, 'not-started')]);
        const parts = planDiffLabel(planDiff(before, after));
        expect(parts.map((part) => part.kind)).toEqual(['completed', 'started', 'added', 'removed']);
        expect(parts[0]).toEqual({ kind: 'completed', symbol: '✓', color: 'teal', labelKey: 'planDiffCompleted', ids: ['1', '2'], text: '1, 2', count: 2 });
        expect(parts[1]).toMatchObject({ symbol: '▶', labelKey: 'planDiffStarted', text: '3' });
        expect(parts[2]).toMatchObject({ symbol: '+', labelKey: 'planDiffAdded', text: '4' });
        expect(parts[3]).toMatchObject({ symbol: '−', labelKey: 'planDiffRemoved', text: '5' });
    });

    it('flags a step that became blocked', () => {
        const parts = planDiffLabel(planDiff(plan(1, [step(1, 'in-progress')]), plan(2, [step(1, 'blocked')])));
        expect(parts).toEqual([{ kind: 'blocked', symbol: '⚠', color: 'orange', labelKey: 'planDiffBlocked', ids: ['1'], text: '1', count: 1 }]);
    });

    it('has no chips when nothing changed', () => {
        const same = [step(1, 'completed'), step(2, 'not-started')];
        expect(planDiffLabel(planDiff(plan(1, same), plan(2, same)))).toEqual([]);
    });

    it('has no chips for a plan\'s first version', () => {
        expect(planChangeParts(undefined, plan(1, [step(1, 'completed')]))).toEqual([]);
        expect(planChangeParts(plan(1, [step(1, 'in-progress')]), plan(2, [step(1, 'completed')]))).toHaveLength(1);
    });
});

describe('currentPlanOf', () => {
    const live: LiveSegment[] = [{ kind: 'text', text: 'x' }, { kind: 'plan', plan: plan(5, [step(1, 'in-progress')]) }];
    const messages = [{ plans: [plan(2, [step(1, 'completed')]), plan(3, [step(1, 'completed')])] }, {}];

    it('prefers the running turn\'s newest version', () => {
        expect(currentPlanOf({ live, messages, sessionPlan: { version: 1, steps: [step(1, 'not-started')] } })).toMatchObject({ source: 'live', plan: { version: 5 } });
    });

    it('then the newest a stored message recorded', () => {
        expect(currentPlanOf({ live: [{ kind: 'text', text: 'x' }], messages, sessionPlan: { version: 1, steps: [step(1, 'not-started')] } }))
            .toMatchObject({ source: 'message', plan: { version: 3 } });
    });

    it('then the session\'s own, as a snapshot', () => {
        const current = currentPlanOf({ messages: [{}], sessionPlan: { version: 4, steps: [step(1, 'blocked')], completion: 0.5, at: '2026-10-23T09:00:00.000Z' } });
        expect(current).toEqual({
            source: 'session',
            plan: { version: 4, operation: 'update', steps: [step(1, 'blocked')], completion: 0.5, at: '2026-10-23T09:00:00.000Z' },
        });
        expect(currentPlanOf({ sessionPlan: { version: 4, steps: [step(1, 'blocked')] } })?.plan.at).toBe('');
    });

    it('is null when the session has no plan, so the dock and the tab stay hidden', () => {
        expect(currentPlanOf({})).toBeNull();
        expect(currentPlanOf({ live: [], messages: [{}, {}], sessionPlan: null })).toBeNull();
        expect(currentPlanOf({ sessionPlan: { version: 1, steps: [] } })).toBeNull();
    });
});

describe('planHistory', () => {
    const p1 = plan(1, [step(1, 'in-progress'), step(2, 'not-started')]);
    const p2 = plan(2, [step(1, 'completed'), step(2, 'in-progress')]);
    const p3 = plan(3, [step(1, 'completed'), step(2, 'completed')]);
    const messages = [
        { role: 'user' },
        { role: 'assistant', plans: [p1, p2] },
        { role: 'user' },
        { role: 'assistant' },
        { role: 'user' },
        { role: 'assistant', plans: [p3] },
    ];

    it('lists every version oldest first with its turn, message and the version before it', () => {
        const history = planHistory(messages);
        expect(history.map((entry) => [entry.plan.version, entry.turnIndex, entry.messageIndex])).toEqual([[1, 1, 1], [2, 1, 1], [3, 3, 5]]);
        expect('previous' in history[0]).toBe(false);
        expect(history[1].previous).toBe(p1);
        expect(history[2].previous).toBe(p2);
    });

    it('carries what each version changed', () => {
        const history = planHistory(messages);
        expect(planDiffLabel(history[1].change).map((part) => [part.kind, part.text])).toEqual([['completed', '1'], ['started', '2']]);
        expect(planDiffLabel(history[2].change).map((part) => [part.kind, part.text])).toEqual([['completed', '2']]);
    });

    it('is empty when no message recorded a plan', () => {
        expect(planHistory([{ role: 'user' }, { role: 'assistant' }])).toEqual([]);
        expect(planHistory([])).toEqual([]);
    });

    it('counts a plan recorded before any user message as turn 1', () => {
        expect(planHistory([{ role: 'assistant', plans: [p1] }])[0].turnIndex).toBe(1);
    });
});
