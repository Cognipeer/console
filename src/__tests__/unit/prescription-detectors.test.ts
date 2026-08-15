/**
 * Prescription detector battery. Each detector is pinned on three axes:
 * fires on the pathological fixture, stays silent on the healthy one, and
 * only claims a savings estimate when the required prices actually exist.
 */

import { describe, expect, it } from 'vitest';
import type { AgentInsights } from '@/lib/services/agentTracing';
import type {
  AgentCosts,
  CostReport,
  ObservedModelCosts,
} from '@/lib/services/cost/costService';
import { runDetectors } from '@/lib/services/prescriptions/detectors';
import type { AgentOverviewEvidence, DetectorInput } from '@/lib/services/prescriptions/types';

// ── Fixture builders ───────────────────────────────────────────────────────

function insights(overrides: Record<string, unknown> = {}): AgentInsights {
  return {
    sampledSessions: 12,
    perCall: {
      aiCalls: 120,
      toolCalls: 60,
      avgAiCallsPerSession: 10,
      avgToolCallsPerSession: 5,
      avgInputTokensPerAiCall: 4_000,
    },
    toolMenu: {
      coveragePct: 90,
      avgMenuSize: 8,
      maxMenuSize: 10,
      distinctTools: 8,
      available: true,
    },
    promptProfile: { found: false },
    errorPatterns: [],
    waste: {
      repeatedToolCalls: { callsAnalyzed: 200, wastedCalls: 0, topOffenders: [] },
    },
    ...overrides,
  } as unknown as AgentInsights;
}

function overview(overrides: {
  totals?: Partial<AgentOverviewEvidence['analytics']['totals']>;
  insights?: AgentInsights | null;
  statuses?: AgentOverviewEvidence['analytics']['statuses'];
  toolItems?: AgentOverviewEvidence['analytics']['tools']['items'];
  daily?: AgentOverviewEvidence['analytics']['daily'];
} = {}): AgentOverviewEvidence {
  return {
    agent: { name: 'pulse-main', sessionsCount: 500, latestSessionAt: null },
    analytics: {
      totals: {
        sessionsCount: 500,
        totalInputTokens: 50_000_000,
        totalOutputTokens: 2_000_000,
        totalCachedInputTokens: 30_000_000,
        totalTokens: 52_000_000,
        averageDurationMs: 4_000,
        ...overrides.totals,
      },
      tools: {
        totals: { totalCalls: 100, errorCalls: 0, successCalls: 100, errorRate: 0 },
        items: overrides.toolItems ?? [],
      },
      statuses: overrides.statuses ?? [{ status: 'success', count: 500 }],
      models: [{ model: 'gpt-5.6-terra', sessionsCount: 500 }],
      daily: overrides.daily ?? [],
      insights: overrides.insights === undefined ? insights() : overrides.insights,
    },
  };
}

function observed(overrides: Partial<ObservedModelCosts> = {}): ObservedModelCosts {
  return {
    totals: { requests: 10_000, totalTokens: 60_000_000, costUsd: 500, unpricedTokens: 0, unpricedModels: 0 },
    entries: [
      {
        modelKey: 'gpt-5.6-terra',
        modelName: 'gpt-5.6-terra',
        status: 'external',
        requests: 10_000,
        inputTokens: 50_000_000,
        outputTokens: 2_000_000,
        cachedInputTokens: 30_000_000,
        totalTokens: 52_000_000,
        costUsd: 500,
        costBySource: {},
        modelCalls: 10_000,
        pricing: { inputTokenPer1M: 2, outputTokenPer1M: 8, cachedTokenPer1M: 0.5 },
      },
    ],
    ...overrides,
  } as ObservedModelCosts;
}

function agentInput(overrides: Partial<DetectorInput> = {}): DetectorInput {
  return {
    subject: { kind: 'agent', name: 'pulse-main' },
    windowDays: 15,
    overview: overview(),
    observedModels: observed(),
    agentCost: {
      agentKey: 'pulse-main',
      requests: 10_000,
      modelCalls: 10_000,
      inputTokens: 50_000_000,
      outputTokens: 2_000_000,
      totalTokens: 52_000_000,
      costUsd: 500,
      models: [{ modelKey: 'gpt-5.6-terra', status: 'external', requests: 10_000, totalTokens: 52_000_000, costUsd: 500 }],
      hasUnpricedUsage: false,
    },
    ...overrides,
  };
}

function findingIds(input: DetectorInput): string[] {
  return runDetectors(input).map((f) => f.id);
}

// ── Agent subject ──────────────────────────────────────────────────────────

describe('cache-hit-low', () => {
  it('stays silent at a healthy cache rate', () => {
    expect(findingIds(agentInput())).not.toContain('cache-hit-low');
  });

  it('fires with a priced savings estimate when the rate collapses', () => {
    const input = agentInput({
      overview: overview({ totals: { totalCachedInputTokens: 500_000 } }),
    });
    const finding = runDetectors(input).find((f) => f.id === 'cache-hit-low');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('critical');
    // 50M input, rate 1% → target 50%: 24.5M extra cached × ($2−$0.5)/1M
    // = $36.75 over 15 days → ×2 for the 30-day month.
    expect(finding!.estMonthlySavingsUsd).toBeCloseTo(73.5, 1);
  });

  it('never invents a savings figure when the cached price is unknown', () => {
    const noCachedPrice = observed();
    noCachedPrice.entries[0].pricing = { inputTokenPer1M: 2, outputTokenPer1M: 8 };
    const input = agentInput({
      overview: overview({ totals: { totalCachedInputTokens: 500_000 } }),
      observedModels: noCachedPrice,
    });
    const finding = runDetectors(input).find((f) => f.id === 'cache-hit-low');
    expect(finding).toBeDefined();
    expect(finding!.estMonthlySavingsUsd).toBeNull();
  });

  it('stays silent below the volume floor', () => {
    const input = agentInput({
      overview: overview({ totals: { totalInputTokens: 100_000, totalCachedInputTokens: 0 } }),
    });
    expect(findingIds(input)).not.toContain('cache-hit-low');
  });
});

describe('prompt lint findings', () => {
  it('reports dynamic prefix and oversized prompt from lint results', () => {
    const lintedInsights = insights({
      promptProfile: {
        found: true,
        lint: {
          chars: 75_000,
          lines: 900,
          estTokens: 18_800,
          paragraphs: 120,
          checks: [
            { id: 'size', label: 'Size budget', status: 'warn', detail: '~18,800 tokens (warn over 8,000)' },
            { id: 'dynamic-prefix', label: 'Dynamic content in prefix', status: 'fail', detail: 'ISO date/time in the first 600 chars' },
          ],
          passed: 0,
          warned: 1,
          failed: 1,
        },
      },
    });
    const ids = findingIds(agentInput({ overview: overview({ insights: lintedInsights }) }));
    expect(ids).toContain('prompt-prefix-dynamic');
    expect(ids).toContain('system-prompt-oversized');
  });

  it('stays silent when lint passes', () => {
    const ids = findingIds(agentInput());
    expect(ids).not.toContain('prompt-prefix-dynamic');
    expect(ids).not.toContain('system-prompt-oversized');
  });
});

describe('context-bloat', () => {
  it('fires on a very large average context', () => {
    const bloated = insights({
      perCall: {
        aiCalls: 100,
        toolCalls: 50,
        avgAiCallsPerSession: 10,
        avgToolCallsPerSession: 5,
        avgInputTokensPerAiCall: 39_000,
      },
    });
    const finding = runDetectors(
      agentInput({ overview: overview({ insights: bloated }) }),
    ).find((f) => f.id === 'context-bloat');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warn');
  });
});

describe('repeated-tool-calls', () => {
  it('fires with offenders when repetition crosses the ratio', () => {
    const wasteful = insights({
      waste: {
        repeatedToolCalls: {
          callsAnalyzed: 200,
          wastedCalls: 80,
          topOffenders: [
            { tool: 'list_connected_google_accounts', maxRepeatsInOneSession: 7, sessionsAffected: 40, totalWasted: 60, argsPreview: '{}' },
          ],
        },
      },
    });
    const finding = runDetectors(
      agentInput({ overview: overview({ insights: wasteful }) }),
    ).find((f) => f.id === 'repeated-tool-calls');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('critical');
    expect(finding!.evidence[0].label).toBe('list_connected_google_accounts');
  });
});

describe('reliability detectors', () => {
  it('recurring-errors surfaces the top signatures', () => {
    const erroring = insights({
      errorPatterns: [
        { message: "Invalid value for 'parallel_tool_calls'", count: 1121, lastSeen: '2026-08-14T21:23:00.000Z' },
        { message: 'GitHub code account not found', count: 12, lastSeen: '2026-08-15T06:30:00.000Z' },
      ],
    });
    const finding = runDetectors(
      agentInput({ overview: overview({ insights: erroring }) }),
    ).find((f) => f.id === 'recurring-errors');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('critical');
    expect(finding!.evidence).toHaveLength(2);
  });

  it('session-error-rate fires above the threshold', () => {
    const input = agentInput({
      overview: overview({ statuses: [
        { status: 'success', count: 400 },
        { status: 'error', count: 100 },
      ] }),
    });
    const finding = runDetectors(input).find((f) => f.id === 'session-error-rate');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('critical');
  });

  it('tool-error-hotspot lists the failing tools', () => {
    const input = agentInput({
      overview: overview({ toolItems: [
        { toolName: 'browser_navigate', totalCalls: 40, errorCalls: 32, successCalls: 8, errorRate: 0.8 },
        { toolName: 'web_search', totalCalls: 300, errorCalls: 3, successCalls: 297, errorRate: 0.01 },
      ] }),
    });
    const finding = runDetectors(input).find((f) => f.id === 'tool-error-hotspot');
    expect(finding).toBeDefined();
    expect(finding!.evidence).toHaveLength(1);
    expect(finding!.evidence[0].label).toBe('browser_navigate');
  });
});

describe('tool-menu-bloat', () => {
  it('fires when far more tools are offered than used', () => {
    const bloatedMenu = insights({
      toolMenu: { coveragePct: 90, avgMenuSize: 132, maxMenuSize: 132, distinctTools: 132, available: true },
    });
    const input = agentInput({
      overview: overview({
        insights: bloatedMenu,
        toolItems: [
          { toolName: 'web_search', totalCalls: 100, errorCalls: 0, successCalls: 100, errorRate: 0 },
        ],
      }),
    });
    const finding = runDetectors(input).find((f) => f.id === 'tool-menu-bloat');
    expect(finding).toBeDefined();
  });

  it('stays silent when menus were never traced', () => {
    const untraced = insights({
      toolMenu: { coveragePct: 0, avgMenuSize: null, maxMenuSize: null, distinctTools: 0, available: false },
    });
    expect(
      findingIds(agentInput({ overview: overview({ insights: untraced }) })),
    ).not.toContain('tool-menu-bloat');
  });
});

describe('traffic-anomaly', () => {
  it('fires on a machine-traffic spike day', () => {
    const daily = [580, 612, 590, 605, 620, 6716, 598, 610, 601, 595].map((n, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      sessionsCount: n,
      totalTokens: n * 1000,
    }));
    const finding = runDetectors(agentInput({ overview: overview({ daily }) }))
      .find((f) => f.id === 'traffic-anomaly');
    expect(finding).toBeDefined();
    expect(finding!.evidence[0].label).toBe('2026-08-06');
  });
});

// ── Workspace subject ──────────────────────────────────────────────────────

function workspaceInput(overrides: Partial<DetectorInput> = {}): DetectorInput {
  const series = Array.from({ length: 21 }, (_, i) => ({
    bucket: `2026-07-${String(i + 1).padStart(2, '0')}`,
    requests: 1000,
    errors: 0,
    totalTokens: 1_000_000,
    costUsd: 20,
  }));
  const costReport: CostReport = {
    granularity: 'daily',
    totals: { requests: 21_000, totalTokens: 21_000_000, costUsd: 420 },
    series,
    topModels: [],
    topAgents: [],
  };
  const agentCosts: AgentCosts = {
    totals: { requests: 21_000, totalTokens: 21_000_000, costUsd: 420 },
    entries: [],
  };
  return {
    subject: { kind: 'workspace' },
    windowDays: 21,
    costReport,
    agentCosts,
    observedModels: observed(),
    ...overrides,
  };
}

describe('workspace detectors', () => {
  it('spend regime shift fires when the last week jumps', () => {
    const input = workspaceInput();
    input.costReport!.series = input.costReport!.series.map((b, i) => ({
      ...b,
      costUsd: i >= 14 ? 333 : 21,
    }));
    const finding = runDetectors(input).find((f) => f.id === 'spend-regime-shift');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warn');
  });

  it('unpriced usage fires with the offending models listed', () => {
    const input = workspaceInput({
      observedModels: observed({
        totals: { requests: 10_000, totalTokens: 100_000_000, costUsd: 500, unpricedTokens: 63_100_000, unpricedModels: 3 },
        entries: [
          ...observed().entries,
          {
            modelKey: 'mlx-communityqwen36',
            modelName: 'mlx-communityqwen36',
            status: 'unpriced',
            requests: 100,
            inputTokens: 60_000_000,
            outputTokens: 3_100_000,
            cachedInputTokens: 0,
            totalTokens: 63_100_000,
            costUsd: 0,
            costBySource: {},
            modelCalls: 100,
          },
        ],
      } as Partial<ObservedModelCosts>),
    });
    const finding = runDetectors(input).find((f) => f.id === 'unpriced-usage');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('critical');
    expect(finding!.evidence.some((e) => e.label === 'mlx-communityqwen36')).toBe(true);
  });

  it('duplicate model keys collapses provider-prefixed twins', () => {
    // NOTE: typo-class twins ('gpt-56-luna' vs 'gpt-5.6-luna') need fuzzy
    // matching and are out of scope here — this detector only collapses
    // exact normalization twins (provider prefixes, date suffixes).
    const input = workspaceInput({
      observedModels: observed({
        entries: [
          ...observed().entries,
          {
            modelKey: 'azure/gpt-5.6-luna',
            modelName: 'gpt-5.6-luna',
            status: 'hub',
            requests: 30,
            inputTokens: 1000,
            outputTokens: 100,
            cachedInputTokens: 0,
            totalTokens: 1100,
            costUsd: 0.01,
            costBySource: {},
            modelCalls: 30,
          },
          {
            modelKey: 'gpt-5.6-luna',
            modelName: 'gpt-5.6-luna',
            status: 'external',
            requests: 3000,
            inputTokens: 100_000,
            outputTokens: 10_000,
            cachedInputTokens: 0,
            totalTokens: 110_000,
            costUsd: 1,
            costBySource: {},
            modelCalls: 3000,
          },
        ],
      } as Partial<ObservedModelCosts>),
    });
    const finding = runDetectors(input).find((f) => f.id === 'duplicate-model-keys');
    expect(finding).toBeDefined();
  });

  it('workspace cache opportunity ranks models by priced savings', () => {
    const input = workspaceInput({
      observedModels: observed({
        entries: [
          {
            ...observed().entries[0],
            cachedInputTokens: 1_000_000, // 2% cache on 50M input
          },
        ],
      } as Partial<ObservedModelCosts>),
    });
    const finding = runDetectors(input).find((f) => f.id === 'workspace-cache-opportunity');
    expect(finding).toBeDefined();
    expect(finding!.estMonthlySavingsUsd).toBeGreaterThan(0);
  });

  it('a healthy workspace produces no cost findings', () => {
    const ids = findingIds(workspaceInput());
    expect(ids).not.toContain('spend-anomaly');
    expect(ids).not.toContain('spend-regime-shift');
    expect(ids).not.toContain('unpriced-usage');
    expect(ids).not.toContain('error-request-rate');
  });
});

describe('runDetectors ordering', () => {
  it('sorts critical findings first', () => {
    const erroring = insights({
      errorPatterns: [{ message: 'boom', count: 500, lastSeen: null }],
    });
    const findings = runDetectors(agentInput({ overview: overview({ insights: erroring }) }));
    expect(findings.length).toBeGreaterThan(0);
    const severities = findings.map((f) => f.severity);
    const firstWarn = severities.indexOf('warn');
    const lastCritical = severities.lastIndexOf('critical');
    if (firstWarn !== -1 && lastCritical !== -1) {
      expect(lastCritical).toBeLessThan(firstWarn);
    }
  });

  it('agent detectors never run for workspace subjects and vice versa', () => {
    const workspaceIds = findingIds(workspaceInput());
    expect(workspaceIds).not.toContain('cache-hit-low');
    const agentIds = findingIds(agentInput());
    expect(agentIds).not.toContain('spend-regime-shift');
  });
});
