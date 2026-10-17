/**
 * The session view's budget: what the meter, the banner and the composer are
 * told (pure helpers), that the pieces mount and say what they should, that the
 * Configure → Execution default is editable, and that both languages carry the
 * strings. (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import { BudgetBanner, BudgetMeter } from '@/components/agents/session/SessionBudgetControls';
import AgentRunSettingsPanel from '@/components/agents/studio/AgentRunSettingsPanel';
import {
  budgetPatchBody,
  sessionBudgetView,
  shouldContinueAfterBudgetChange,
  suggestedBudget,
  validBudgetAmount,
} from '@/components/agents/session/sessionBudgetUi';
import type { ChatMessage } from '@/components/agents/session/sessionTypes';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;
const turn = (costUsd?: number): ChatMessage => ({ role: 'assistant', content: 'x', ...(costUsd !== undefined ? { usage: { costUsd } } : {}) });
const budget = { maxCostUsd: 1, onReach: 'pause' as const };

describe('sessionBudgetView', () => {
  it('is null for a session without a budget (the meter and banner stay away)', () => {
    expect(sessionBudgetView(null, [])).toBeNull();
    expect(sessionBudgetView({}, [turn(5)])).toBeNull();
    expect(sessionBudgetView({ budget: null }, [])).toBeNull();
  });

  it('reads spend from the larger of the stored total and the turns on screen, so it moves as turns land', () => {
    expect(sessionBudgetView({ budget, spentUsd: 0.2 }, [turn(0.1)])).toMatchObject({ spentUsd: 0.2, ratio: 0.2, exhausted: false });
    expect(sessionBudgetView({ budget, spentUsd: 0.2 }, [turn(0.4), turn(0.3)])?.spentUsd).toBeCloseTo(0.7, 8);
  });

  it('is exhausted at or past the budget (the composer closes), and capped at a full meter', () => {
    const view = sessionBudgetView({ budget, spentUsd: 1.04 }, [])!;
    expect(view).toMatchObject({ exhausted: true, ratio: 1 });
    expect(sessionBudgetView({ budget, spentUsd: 1 }, [])?.exhausted).toBe(true);
  });

  it('can be continued only when the last turn stopped on the budget', () => {
    expect(sessionBudgetView({ budget, spentUsd: 1.1, runtimeStatus: 'budget_paused' }, [])?.continuable).toBe(true);
    expect(sessionBudgetView({ budget, spentUsd: 1.1, stopReason: 'budget_reached' }, [])?.continuable).toBe(true);
    // Overshot on a turn that still finished: raising the budget alone is enough.
    expect(sessionBudgetView({ budget, spentUsd: 1.1, runtimeStatus: 'idle', stopReason: 'end_turn' }, [])?.continuable).toBe(false);
  });

  it('is never continuable in stop mode: the budget only refuses messages, even though the turn’s stop reason is the budget', () => {
    const stop = { maxCostUsd: 1, onReach: 'stop' as const };
    expect(sessionBudgetView({ budget: stop, spentUsd: 1.1, runtimeStatus: 'idle', stopReason: 'budget_reached' }, [])?.continuable).toBe(false);
    expect(sessionBudgetView({ budget: stop, spentUsd: 1.1, stopReason: 'budget_reached' }, [])?.continuable).toBe(false);
    // A session that really is paused (the budget was switched to stop after) can still be carried on.
    expect(sessionBudgetView({ budget: stop, spentUsd: 1.1, runtimeStatus: 'budget_paused' }, [])?.continuable).toBe(true);
  });
});

describe('after the budget changed', () => {
  it('carries the session on only when it was waiting to be and the server’s answer still says paused', () => {
    expect(shouldContinueAfterBudgetChange(true, { runtimeStatus: 'budget_paused' })).toBe(true);
    // The turn had finished when it crossed the budget: the raise left the session idle, and /continue would be refused.
    expect(shouldContinueAfterBudgetChange(true, { runtimeStatus: 'idle' })).toBe(false);
    expect(shouldContinueAfterBudgetChange(true, {})).toBe(false);
    expect(shouldContinueAfterBudgetChange(true, null)).toBe(false);
    // Not waiting to begin with (stop mode, or an ordinary edit from the meter).
    expect(shouldContinueAfterBudgetChange(false, { runtimeStatus: 'budget_paused' })).toBe(false);
  });

  it('prefers the server’s own `continuable` over reading the stored status', () => {
    expect(shouldContinueAfterBudgetChange(true, { runtimeStatus: 'idle' }, true)).toBe(true);
    expect(shouldContinueAfterBudgetChange(true, { runtimeStatus: 'budget_paused' }, false)).toBe(false);
    expect(shouldContinueAfterBudgetChange(true, null, true)).toBe(true);
    // Never when the person was not stopped on the budget to begin with.
    expect(shouldContinueAfterBudgetChange(false, { runtimeStatus: 'budget_paused' }, true)).toBe(false);
  });

  it('the session view asks that, and does not continue on its own guess', () => {
    const source = readFileSync(join(__dirname, '../../components/agents/session/AgentSessionView.tsx'), 'utf8');
    expect(source).toContain('shouldContinueAfterBudgetChange(wasContinuable, stored?.session, stored?.continuable)');
    expect(source).not.toMatch(/patchBudget\(budget\)\s*&&\s*carryOn/);
  });
});

describe('the new-budget box', () => {
  const view = sessionBudgetView({ budget, spentUsd: 1.04 }, [])!;

  it('suggests more than the session spent, rounded to a readable amount', () => {
    expect(suggestedBudget(view)).toBe(3); // spent + budget = 2.04, rounded up to whole dollars once above $1
    expect(suggestedBudget(sessionBudgetView({ budget: { maxCostUsd: 0.02, onReach: 'stop' }, spentUsd: 0.025 }, [])!)).toBe(0.05);
  });

  it('only accepts an amount above what was already spent — what the server enforces', () => {
    expect(validBudgetAmount(2, view)).toBe(true);
    expect(validBudgetAmount(1.04, view)).toBe(false);
    expect(validBudgetAmount(0, null)).toBe(false);
    expect(validBudgetAmount('3', view)).toBe(false);
    expect(validBudgetAmount(0.5, null)).toBe(true); // a session with no budget yet and no spend
  });

  it('PATCHes the budget in the shape the route reads', () => {
    expect(budgetPatchBody(5, 'stop')).toEqual({ budget: { maxCostUsd: 5, onReach: 'stop' } });
  });
});

describe('BudgetMeter / BudgetBanner', () => {
  const view = sessionBudgetView({ budget: { maxCostUsd: 2.5, onReach: 'pause' }, spentUsd: 1.25 }, [])!;
  const paused = sessionBudgetView({ budget, spentUsd: 1.04, runtimeStatus: 'budget_paused' }, [])!;

  it('the meter shows spent / budget; without a budget it offers to set one; read-only shows nothing', () => {
    const meter = render(h(BudgetMeter, { view, busy: false, onSave: noop, onRemove: noop }));
    expect(meter).toContain('$1.25 / $2.50');
    expect(render(h(BudgetMeter, { view: null, busy: false, onSave: noop, onRemove: noop }))).toContain('Set budget');
    expect(render(h(BudgetMeter, { view: null, busy: false, readOnly: true, onSave: noop, onRemove: noop }))).not.toContain('Set budget');
  });

  it('the banner of a paused session says it carries on, with a new-budget box and both actions', () => {
    const html = render(h(BudgetBanner, { view: paused, busy: false, onIncrease: noop, onRemove: noop }));
    expect(html).toContain('Session budget reached');
    expect(html).toContain('carries on from where it stopped');
    expect(html).toContain('New budget (USD)');
    expect(html).toContain('Increase and continue');
    expect(html).toContain('Remove budget and continue');
    expect(html).toContain('$1.04 / $1.00');
  });

  it('the banner of a stop-mode session that hit its budget makes no promise to carry on', () => {
    const stopped = sessionBudgetView({ budget: { maxCostUsd: 1, onReach: 'stop' }, spentUsd: 1.04, runtimeStatus: 'idle', stopReason: 'budget_reached' }, [])!;
    const html = render(h(BudgetBanner, { view: stopped, busy: false, onIncrease: noop, onRemove: noop }));
    expect(html).toContain('Session budget reached');
    expect(html).toContain('new messages are refused');
    expect(html).toContain('Increase budget');
    expect(html).toContain('Remove budget');
    expect(html).not.toContain('carries on from where it stopped');
    expect(html).not.toContain('and continue');
    expect(render(h(BudgetBanner, { view: stopped, busy: false, onIncrease: noop, onRemove: noop }), 'tr')).not.toContain('kaldığı yerden');
  });

  it('the banner of a session that only refuses messages offers just the budget change', () => {
    const stopped = sessionBudgetView({ budget: { maxCostUsd: 1, onReach: 'stop' }, spentUsd: 1.04, runtimeStatus: 'idle', stopReason: 'end_turn' }, [])!;
    const html = render(h(BudgetBanner, { view: stopped, busy: false, onIncrease: noop, onRemove: noop }));
    expect(html).toContain('Increase budget');
    expect(html).not.toContain('and continue');
  });
});

describe('Configure → Callback & budget: default session budget', () => {
  const panel = (budget: unknown) => h(AgentRunSettingsPanel, {
    callback: undefined, onCallbackChange: noop, budget: budget as never, onBudgetChange: noop,
  });
  it('shows the amount and, once set, what happens at the limit', () => {
    const empty = render(panel(undefined));
    expect(empty).toContain('Budget per session (USD)');
    expect(empty).not.toContain('When the budget is reached');

    const withBudget = render(panel({ maxCostUsd: 5, onReach: 'stop' }));
    expect(withBudget).toContain('When the budget is reached');
    expect(withBudget).toContain('Pause and wait');
    expect(withBudget).toContain('refused until the budget is raised');
  });
});

describe('strings', () => {
  const keys = Object.keys(en.agents.budget);
  it('every budget string exists in English and in Turkish', () => {
    expect(Object.keys(tr.agents.budget).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect((tr.agents.budget as Record<string, string>)[key]).toBeTruthy();
    }
  });

  it('uses the same placeholders in both languages', () => {
    const placeholders = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of keys) {
      expect(placeholders((tr.agents.budget as Record<string, string>)[key]), key)
        .toEqual(placeholders((en.agents.budget as Record<string, string>)[key]));
    }
  });
});
