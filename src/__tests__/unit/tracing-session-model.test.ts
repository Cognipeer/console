/**
 * Unit tests — integration-agnostic session reading (grouping, timestamp
 * semantics, time breakdown) behind the Agent Observability grouped list
 * and timeline.
 *
 * Each fixture mirrors the event shape a real integration sends (read from
 * agent-sdk, @cognipeer/observability and the OTLP mapper), because the
 * point of `sessionModel` is that none of those shapes needs special-casing
 * in the UI.
 */

import { describe, expect, it } from 'vitest';

import {
  buildSessionModel,
  cleanLabel,
  flattenTree,
  outcomeText,
  resolveTimings,
  type TraceEventInput,
  type TraceNode,
} from '@/components/tracing/sessionModel';
import { classifySections, createToolTurnKeys, eventResponse, sectionToolArgs, sectionToolResult } from '@/lib/shared/tracingSections';
import { stepBadge } from '@/components/tracing/stepDisplay';

const T0 = Date.parse('2026-10-15T12:03:06.301Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

function labels(nodes: TraceNode[]): unknown[] {
  return nodes.map((node) => (node.children.length > 0
    ? { group: [...node.foldedLabels, node.label].join(' › '), inferred: node.inferred, children: labels(node.children) }
    : node.label));
}

// ─── agent-sdk: empty iteration spans, timestamp = END of the step ─────────
// The real session from the bug report (Pulse Main Agent, 11 events).
const agentSdk: TraceEventInput[] = [
  { id: 'e1', sequence: 1, type: 'agent_iteration', label: 'Iteration 1 #1', timestamp: at(0), spanId: 'it1', parentSpanId: 'root', sections: [] },
  {
    id: 'e2', sequence: 2, type: 'ai_call', label: 'Assistant Response #2', model: 'gpt-6-luna', timestamp: at(4002), durationMs: 4001,
    spanId: 's2', parentSpanId: 'it1', toolName: 'search_topics', finishReason: 'tool_calls', totalTokens: 44011,
    sections: [
      { kind: 'message', role: 'developer' },
      { kind: 'message', role: 'user' },
      { kind: 'tool_call', tool: 'search_topics' },
      { kind: 'tool_definitions' },
    ],
  },
  { id: 'e3', sequence: 3, type: 'tool_call', label: 'Tool Execution - search Topics #3', toolName: 'search_topics', timestamp: at(4053), durationMs: 8, spanId: 's3', parentSpanId: 'it1', sections: [{ kind: 'tool_call', tool: 'search_topics' }, { kind: 'tool_result', tool: 'search_topics' }] },
  { id: 'e4', sequence: 4, type: 'agent_iteration', label: 'Iteration 2 #4', timestamp: at(4054), spanId: 'it2', parentSpanId: 'root', sections: [] },
  {
    id: 'e5', sequence: 5, type: 'ai_call', label: 'Assistant Response #5', model: 'gpt-6-luna', timestamp: at(17540), durationMs: 13480,
    spanId: 's5', parentSpanId: 'it2', toolName: 'search_topics', finishReason: 'tool_calls', totalTokens: 44032,
    sections: [
      { kind: 'message', role: 'developer' },
      { kind: 'message', role: 'user' },
      { kind: 'tool_call', tool: 'search_topics' },
      { kind: 'tool_result', tool: 'search_topics' },
      { kind: 'tool_call', tool: 'search_in_files' },
      { kind: 'tool_definitions' },
    ],
  },
  { id: 'e6', sequence: 6, type: 'tool_call', label: 'Tool Execution - search In Files #6', toolName: 'search_in_files', timestamp: at(18240), durationMs: 656, spanId: 's6', parentSpanId: 'it2' },
  { id: 'e7', sequence: 7, type: 'agent_iteration', label: 'Iteration 3 #7', timestamp: at(18241), spanId: 'it3', parentSpanId: 'root', sections: [] },
  { id: 'e8', sequence: 8, type: 'ai_call', model: 'gpt-6-luna', timestamp: at(21387), durationMs: 3100, spanId: 's8', parentSpanId: 'it3', toolName: 'search_topics', responseToolNames: ['read_text_file'], responseAnswered: false },
  { id: 'e9', sequence: 9, type: 'tool_call', toolName: 'read_text_file', timestamp: at(21658), durationMs: 227, spanId: 's9', parentSpanId: 'it3' },
  { id: 'e10', sequence: 10, type: 'agent_iteration', label: 'Iteration 4 #10', timestamp: at(21659), spanId: 'it4', parentSpanId: 'root', sections: [] },
  {
    id: 'e11', sequence: 11, type: 'ai_call', model: 'gpt-6-luna', timestamp: at(30035), durationMs: 8376, spanId: 's11', parentSpanId: 'it4', toolName: 'search_topics', finishReason: 'stop',
    sections: [{ kind: 'message', role: 'user' }, { kind: 'tool_result', tool: 'read_text_file' }, { kind: 'message', role: 'assistant' }],
  },
];

// ─── @cognipeer/observability LangGraph: node spans, timestamp = START, ───
// sequence = close order (children before their parent), parallel tools.
const langGraph: TraceEventInput[] = [
  { id: 'llm1', sequence: 1, type: 'ai_call', model: 'gpt-4.1', timestamp: at(100), durationMs: 2000, spanId: 'l1', parentSpanId: 'agent1', sections: [{ kind: 'message', role: 'user' }, { kind: 'message', role: 'assistant' }, { kind: 'tool_call', tool: 'get_weather' }, { kind: 'tool_call', tool: 'search_docs' }] },
  { id: 'agent1', sequence: 2, type: 'span', label: 'agent', timestamp: at(50), durationMs: 2100, spanId: 'agent1', parentSpanId: 'graph', sections: [{ kind: 'metadata', label: 'Input' }, { kind: 'metadata', label: 'Output' }] },
  { id: 'tw', sequence: 3, type: 'tool_call', label: 'get_weather', toolName: 'get_weather', timestamp: at(2200), durationMs: 420, spanId: 'tw', parentSpanId: 'tools1' },
  { id: 'td', sequence: 4, type: 'tool_call', label: 'search_docs', toolName: 'search_docs', timestamp: at(2210), durationMs: 610, spanId: 'td', parentSpanId: 'tools1' },
  { id: 'tools1', sequence: 5, type: 'span', label: 'tools', timestamp: at(2180), durationMs: 660, spanId: 'tools1', parentSpanId: 'graph', sections: [{ kind: 'metadata', label: 'Input' }] },
  { id: 'llm2', sequence: 6, type: 'ai_call', model: 'gpt-4.1', timestamp: at(2900), durationMs: 1500, spanId: 'l2', parentSpanId: 'agent2', sections: [{ kind: 'message', role: 'tool' }, { kind: 'message', role: 'assistant', label: 'Assistant message' }] },
  { id: 'agent2', sequence: 7, type: 'span', label: 'agent', timestamp: at(2880), durationMs: 1550, spanId: 'agent2', parentSpanId: 'graph', sections: [{ kind: 'metadata', label: 'Input' }] },
  { id: 'graph', sequence: 8, type: 'span', label: 'LangGraph', timestamp: at(0), durationMs: 4500, spanId: 'graph', parentSpanId: 'root' },
];

// ─── Claude Agent SDK: flat, no durations, arrival timestamps, a subagent ──
// nested under the Task tool call that launched it.
const claudeSdk: TraceEventInput[] = [
  { id: 'init', sequence: 1, type: 'span', label: 'Session init', timestamp: at(0), spanId: 'init', parentSpanId: 'root' },
  { id: 'a1', sequence: 2, type: 'ai_call', model: 'claude-sonnet', timestamp: at(3200), spanId: 'a1', parentSpanId: 'root', sections: [{ kind: 'message', role: 'assistant' }, { kind: 'tool_call', tool: 'Task' }] },
  { id: 'task', sequence: 3, type: 'tool_call', label: 'Task', toolName: 'Task', timestamp: at(9000), spanId: 'task', parentSpanId: 'root' },
  { id: 'sub1', sequence: 4, type: 'ai_call', model: 'claude-haiku', timestamp: at(5000), spanId: 'sub1', parentSpanId: 'task', sections: [{ kind: 'tool_call', tool: 'Read' }] },
  { id: 'sub2', sequence: 5, type: 'tool_call', toolName: 'Read', timestamp: at(5400), spanId: 'sub2', parentSpanId: 'task' },
  { id: 'a2', sequence: 6, type: 'ai_call', model: 'claude-sonnet', timestamp: at(10100), spanId: 'a2', parentSpanId: 'root', sections: [{ kind: 'message', role: 'assistant' }] },
];

// ─── LangChain AgentExecutor (obs SDK): one chain, flat model/tool calls ───
const langChainAgent: TraceEventInput[] = [
  { id: 'c1', sequence: 1, type: 'ai_call', model: 'gpt-4.1-mini', timestamp: at(10), durationMs: 900, spanId: 'c1', parentSpanId: 'exec' },
  { id: 'c2', sequence: 2, type: 'tool_call', toolName: 'search', timestamp: at(920), durationMs: 300, spanId: 'c2', parentSpanId: 'exec' },
  { id: 'c3', sequence: 3, type: 'ai_call', model: 'gpt-4.1-mini', timestamp: at(1230), durationMs: 700, spanId: 'c3', parentSpanId: 'exec', finishReason: 'stop' },
  { id: 'exec', sequence: 4, type: 'span', label: 'AgentExecutor', timestamp: at(0), durationMs: 1950, spanId: 'exec', parentSpanId: 'root', sections: [{ kind: 'metadata', label: 'Input' }, { kind: 'metadata', label: 'Output' }] },
];

// ─── Retired console-sdk handler: start/end as separate events ─────────────
const legacyHandler: TraceEventInput[] = [
  { id: 'r1', type: 'chain_start', label: 'agent', timestamp: at(0) },
  { id: 'r2', type: 'llm_start', label: 'model', timestamp: at(10) },
  { id: 'r2', type: 'llm_end', timestamp: at(900) },
  { id: 'r1', type: 'chain_end', timestamp: at(950) },
];

// ─── OTLP: the root span lives in another service (orphan parent) ──────────
const otlpOrphan: TraceEventInput[] = [
  { id: 'o1', type: 'span', label: 'invoke_agent support', timestamp: at(0), durationMs: 2000, spanId: 'o1', parentSpanId: 'upstream-http-span' },
  { id: 'o2', type: 'ai_call', model: 'gpt-4o', timestamp: at(100), durationMs: 1500, spanId: 'o2', parentSpanId: 'o1' },
  { id: 'o3', type: 'retrieval', label: 'vector search', timestamp: at(1650), durationMs: 200, spanId: 'o3', parentSpanId: 'o1' },
];

describe('timestamp semantics', () => {
  it('reads agent-sdk timestamps as the end of the step', () => {
    const { mode, timings } = resolveTimings(agentSdk);
    expect(mode).toBe('end');
    expect(timings.get('e2')!.start).toBe(T0 + 1);
    expect(timings.get('e3')!.start).toBeGreaterThanOrEqual(timings.get('e2')!.end);
  });

  it('reads the observability SDK and OTLP as start timestamps (the contract)', () => {
    expect(resolveTimings(langGraph).mode).toBe('start');
    expect(resolveTimings(langChainAgent).mode).toBe('start');
    expect(resolveTimings(otlpOrphan).mode).toBe('start');
  });

  it('estimates durations from gaps when the SDK reports none, and marks them', () => {
    const { timings } = resolveTimings(claudeSdk, at(0));
    const a1 = timings.get('a1')!;
    expect(a1.estimated).toBe(true);
    expect(a1.end - a1.start).toBe(3200);
    expect(timings.get('init')!.hasDuration).toBe(false);
  });
});

describe('grouping follows structure, not event type', () => {
  it('agent-sdk: one group per iteration, steps inside', () => {
    const { tree } = buildSessionModel(agentSdk);
    expect(labels(tree)).toEqual([
      { group: 'Iteration 1', inferred: false, children: ['gpt-6-luna', 'search_topics'] },
      { group: 'Iteration 2', inferred: false, children: ['gpt-6-luna', 'search_in_files'] },
      { group: 'Iteration 3', inferred: false, children: ['gpt-6-luna', 'read_text_file'] },
      { group: 'Iteration 4', inferred: false, children: ['gpt-6-luna'] },
    ]);
  });

  it('LangGraph: graph and node spans group, children ordered by start not close order', () => {
    const { tree } = buildSessionModel(langGraph);
    expect(labels(tree)).toEqual([
      {
        group: 'LangGraph',
        inferred: false,
        children: [
          { group: 'agent', inferred: false, children: ['gpt-4.1'] },
          { group: 'tools', inferred: false, children: ['get_weather', 'search_docs'] },
          { group: 'agent', inferred: false, children: ['gpt-4.1'] },
        ],
      },
    ]);
    const toolsNode = tree[0].children[1];
    expect(toolsNode.parallel).toBe(2);
  });

  it('Claude Agent SDK: infers steps from a flat list and keeps the subagent nested', () => {
    const { tree } = buildSessionModel(claudeSdk, { startedAt: at(0) });
    expect(labels(tree)).toEqual([
      'Session init',
      { group: 'Step 1', inferred: true, children: ['claude-sonnet', { group: 'Task', inferred: false, children: ['claude-haiku', 'Read'] }] },
      { group: 'Step 2', inferred: true, children: ['claude-sonnet'] },
    ]);
  });

  it('LangChain AgentExecutor: a flat run under one chain is split into steps', () => {
    const { tree } = buildSessionModel(langChainAgent);
    expect(labels(tree)).toEqual([
      {
        group: 'AgentExecutor',
        inferred: false,
        children: [
          { group: 'Step 1', inferred: true, children: ['gpt-4.1-mini', 'search'] },
          { group: 'Step 2', inferred: true, children: ['gpt-4.1-mini'] },
        ],
      },
    ]);
  });

  it('OTLP: a span whose parent lives in another service becomes a root', () => {
    const { tree } = buildSessionModel(otlpOrphan);
    expect(labels(tree)).toEqual([{ group: 'invoke_agent support', inferred: false, children: ['gpt-4o', 'vector search'] }]);
  });

  it('folds a content-less wrapper span around a single group', () => {
    const wrapped: TraceEventInput[] = [
      { id: 'w', type: 'span', label: 'RunnableWrapper', timestamp: at(0), durationMs: 100, spanId: 'w' },
      { id: 'n', type: 'span', label: 'agent', timestamp: at(0), durationMs: 90, spanId: 'n', parentSpanId: 'w', sections: [{ kind: 'metadata', label: 'Input' }] },
      { id: 'm', type: 'ai_call', model: 'm', timestamp: at(5), durationMs: 80, spanId: 'm', parentSpanId: 'n' },
    ];
    const { tree } = buildSessionModel(wrapped);
    expect(labels(tree)).toEqual([{ group: 'RunnableWrapper › agent', inferred: false, children: ['m'] }]);
  });

  it('flags the retired console-sdk handler and offers no timeline', () => {
    const model = buildSessionModel(legacyHandler);
    expect(model.legacyHandler).toBe(true);
    expect(model.hasTiming).toBe(false);
  });
});

describe('time breakdown', () => {
  it('agent-sdk: model vs tool split adds up to the wall clock', () => {
    const { breakdown } = buildSessionModel(agentSdk, { startedAt: at(0), durationMs: 30300 });
    expect(breakdown).toBeDefined();
    const b = breakdown!;
    expect(b.wallMs).toBe(30300);
    expect(b.byCategory.model).toBe(4001 + 13480 + 3100 + 8376);
    expect(b.byCategory.tool).toBe(8 + 656 + 227);
    expect(b.byCategory.model + b.byCategory.tool + b.overheadMs).toBe(b.wallMs);
    expect(b.slowest?.node.event?.id).toBe('e5');
  });

  it('parallel tools are counted once on the clock but fully in the per-tool table', () => {
    const { breakdown } = buildSessionModel(langGraph);
    const b = breakdown!;
    // get_weather [2200,2620] ∪ search_docs [2210,2820] = 620ms, sum 1030ms
    expect(b.byCategory.tool).toBe(620);
    expect(b.sumMs - b.busyMs).toBe(410);
    expect(b.byCategory.model + b.byCategory.tool + b.overheadMs).toBeLessThanOrEqual(b.wallMs);
    expect(b.rows.find((r) => r.name === 'search_docs')?.totalMs).toBe(610);
  });

  it('container spans never count toward a category (no double counting)', () => {
    const { breakdown } = buildSessionModel(langChainAgent);
    const b = breakdown!;
    expect(b.byCategory.other).toBe(0);
    expect(b.byCategory.model).toBe(1600);
  });

  it('marks estimated durations for SDKs that report none', () => {
    const { breakdown } = buildSessionModel(claudeSdk, { startedAt: at(0) });
    expect(breakdown!.estimatedCount).toBeGreaterThan(0);
  });
});

describe('what a model call did', () => {
  it('reads the answer, not the first tool replayed from history', () => {
    const tree = buildSessionModel(agentSdk).tree;
    const steps = flattenTree(tree).map(({ node }) => node).filter((node) => node.category === 'model');
    expect(steps.map((node) => outcomeText(node.event!))).toEqual([
      '→ search_topics',
      '→ search_in_files',
      '→ read_text_file',
      '→ answer',
    ]);
  });

  it('classifies config, history and answer sections', () => {
    const sections = agentSdk[4].sections!;
    expect(classifySections('ai_call', sections)).toEqual(['input', 'input', 'input', 'input', 'output', 'config']);
    expect(eventResponse('ai_call', sections)).toEqual({ toolNames: ['search_in_files'], answered: false });
  });

  it('an answer-only recording (Claude Agent SDK) is all output', () => {
    expect(eventResponse('ai_call', claudeSdk[1].sections)).toEqual({ toolNames: ['Task'], answered: true });
  });

  it('explicit direction wins over the heuristics', () => {
    expect(classifySections('ai_call', [{ kind: 'message', role: 'user', direction: 'output' }])).toEqual(['output']);
  });

  it('tool events: arguments in, result out', () => {
    expect(classifySections('tool_call', [{ kind: 'tool_call', label: 'Arguments' }, { kind: 'tool_result', label: 'Result' }])).toEqual(['input', 'output']);
  });
});

// ─── agent-sdk: a turn resumed after a tool approval ────────────────────────
// sess_8vB9… in shape: the approval pause splits the turn into a new invoke
// (and trace session) whose first iteration runs the approved tools only.
const resumedAfterApproval: TraceEventInput[] = [
  { id: 'r1', sequence: 1, type: 'agent_iteration', label: 'Iteration 1 #1', timestamp: at(0), spanId: 'it1', parentSpanId: 'root', sections: [] },
  { id: 'r2', sequence: 2, type: 'tool_call', label: 'Tool Execution - web_search #2', toolName: 'web_search', timestamp: at(1217), durationMs: 1215, spanId: 'r2s', parentSpanId: 'it1', sections: [] },
  { id: 'r3', sequence: 3, type: 'tool_call', label: 'Tool Execution - web_search #3', toolName: 'web_search', timestamp: at(1351), durationMs: 133, spanId: 'r3s', parentSpanId: 'it1', sections: [] },
  { id: 'r4', sequence: 4, type: 'agent_iteration', label: 'Iteration 2 #4', timestamp: at(1351), spanId: 'it2', parentSpanId: 'root', sections: [] },
  { id: 'r5', sequence: 5, type: 'ai_call', label: 'Assistant Response #5', model: 'gpt-5.6-luna', timestamp: at(4803), durationMs: 3452, spanId: 'r5s', parentSpanId: 'it2', finishReason: 'stop', sections: [{ kind: 'message', role: 'assistant' }] },
];

describe('turns resumed after a pause', () => {
  it('flags a session whose first iteration runs tools without a model call', () => {
    const model = buildSessionModel(resumedAfterApproval, { startedAt: at(0), durationMs: 4803 });
    expect(model.resumed).toBe(true);
    expect(model.tree[0].resumed).toBe(true);
    expect(model.tree[1].resumed).toBeUndefined();
    // Timing still reads end-timestamps: the first tool starts with the session.
    expect(model.timings.mode).toBe('end');
  });

  it('does not flag an ordinary agent-sdk session', () => {
    expect(buildSessionModel(agentSdk).resumed).toBe(false);
  });

  it('does not flag other integrations', () => {
    expect(buildSessionModel(langGraph).resumed).toBe(false);
    expect(buildSessionModel(claudeSdk).resumed).toBe(false);
    expect(buildSessionModel(langChainAgent).resumed).toBe(false);
  });
});

describe('labels', () => {
  it('drops a sequence suffix baked into the label', () => {
    expect(cleanLabel({ id: 'x', label: 'Iteration 2 #4', sequence: 4 })).toBe('Iteration 2');
    expect(cleanLabel({ id: 'x', label: 'Iteration 2 #4', sequence: 5 })).toBe('Iteration 2 #4');
  });
});

describe('tool call data, whatever field the integration used', () => {
  it('agent-sdk: arguments and output', () => {
    expect(sectionToolArgs({ kind: 'tool_call', tool: 'web_search', arguments: { query: 'cognipeer' } })).toEqual({ query: 'cognipeer' });
    expect(sectionToolResult({ kind: 'tool_result', tool: 'web_search', summary: '{"ok":true}', output: { ok: true } })).toEqual({ ok: true });
  });

  it('agent-sdk: falls back to the summary when the output was not kept', () => {
    expect(sectionToolResult({ kind: 'tool_result', summary: '3 results' })).toBe('3 results');
  });

  it('observability SDK / OTLP: content, parsed when it is JSON', () => {
    expect(sectionToolArgs({ kind: 'tool_call', content: '{"order":1042}' })).toEqual({ order: 1042 });
    expect(sectionToolArgs({ kind: 'tool_call', content: 'plain text' })).toBe('plain text');
    expect(sectionToolResult({ kind: 'tool_result', content: 'shipped' })).toBe('shipped');
  });

  it('pairs the n-th result of a tool with its n-th call', () => {
    const keys = createToolTurnKeys();
    const calls = [keys.call('web_search', 0), keys.call('web_search', 1), keys.call('fetch', 2)];
    const results = [keys.result('web_search', 3), keys.result('web_search', 4), keys.result('fetch', 5)];
    expect(results).toEqual(calls);
    expect(new Set(calls).size).toBe(3);
    keys.reset();
    expect(keys.call('web_search', 6)).toBe(calls[0]);
  });
});

// ─── Context summarization (agent-sdk ≥ 0.15 traces it) ────────────────────
describe('context summarization steps', () => {
  const summarization: TraceEventInput = {
    id: 'sum', sequence: 4, type: 'summarization', label: 'Context Summarization #4', model: 'gpt-6-luna',
    timestamp: at(4100), durationMs: 1800, spanId: 'sum', parentSpanId: 'root', inputTokens: 9000, outputTokens: 300,
    sections: [{ kind: 'message', role: 'system' }, { kind: 'summary', label: 'Summary injected into context' }, { kind: 'metadata', label: 'Compaction' }],
  };

  it('is a model step named for what it did, between the iterations it sits between', () => {
    const events = [...agentSdk.slice(0, 3), summarization, ...agentSdk.slice(3).map((event) => {
      const sequence = (event.sequence ?? 0) + 1;
      return { ...event, sequence, label: event.label?.replace(/ #\d+$/, ` #${sequence}`) };
    })];
    const { tree } = buildSessionModel(events);
    expect(labels(tree)).toEqual([
      { group: 'Iteration 1', inferred: false, children: ['gpt-6-luna', 'search_topics'] },
      'Context Summarization',
      { group: 'Iteration 2', inferred: false, children: ['gpt-6-luna', 'search_in_files'] },
      { group: 'Iteration 3', inferred: false, children: ['gpt-6-luna', 'read_text_file'] },
      { group: 'Iteration 4', inferred: false, children: ['gpt-6-luna'] },
    ]);
    const node = flattenTree(tree).map((entry) => entry.node).find((entry) => entry.event?.type === 'summarization')!;
    expect(node.category).toBe('model');
    expect(stepBadge(node)).toBe('Summary');
  });

  it('does not open an inferred step of its own in a flat run', () => {
    const flat: TraceEventInput[] = [
      ...langChainAgent.slice(0, 2),
      { ...summarization, parentSpanId: 'exec', timestamp: at(1225), durationMs: 5 },
      ...langChainAgent.slice(2),
    ];
    const { tree } = buildSessionModel(flat);
    expect(labels(tree)).toEqual([
      {
        group: 'AgentExecutor',
        inferred: false,
        children: [
          { group: 'Step 1', inferred: true, children: ['gpt-4.1-mini', 'search', 'Context Summarization'] },
          { group: 'Step 2', inferred: true, children: ['gpt-4.1-mini'] },
        ],
      },
    ]);
  });
});

// ─── agent-sdk ≥ 0.18: a sub-agent paused for approval is ONE span ──────────
// Written `pending` at each pause and again, same spanId, when it ends. The
// Console feed (?includeEventContent=false) carries no `sections`, only the
// precomputed `human` summary, so these fixtures have none either.
describe('a sub-agent that paused and resumed', () => {
  const sub = (sequence: number, status: string, parentSpanId: string, ts: number, durationMs?: number): TraceEventInput => ({
    id: `sa${sequence}`, sequence, type: 'span', label: 'Sub-agent helper', status, spanId: 'sa', parentSpanId, timestamp: at(ts), durationMs,
  });
  const iter = (id: string, sequence: number, n: number, ts: number): TraceEventInput => ({
    id, sequence, type: 'agent_iteration', label: `Iteration ${n} #${sequence}`, spanId: id, parentSpanId: 'sa', timestamp: at(ts),
  });
  const request: TraceEventInput = { id: 'rq', sequence: 5, type: 'tool_approval', label: 'Approval lookup', status: 'pending', spanId: 'rq', parentSpanId: 'ci1', timestamp: at(300), human: { kind: 'approval', key: 'ap1', state: 'pending' } };
  const decision: TraceEventInput = { id: 'dc', sequence: 8, type: 'tool_approval', label: 'Approval lookup', status: 'success', spanId: 'dc', parentSpanId: 'ci1', timestamp: at(5300), durationMs: 5000, human: { kind: 'approval', key: 'ap1', state: 'approved' } };
  const head: TraceEventInput[] = [
    { id: 'pi1', sequence: 1, type: 'agent_iteration', label: 'Iteration 1 #1', spanId: 'pi1', parentSpanId: 'root', timestamp: at(0) },
    iter('ci1', 4, 1, 100),
    { id: 'm1', sequence: 3, type: 'ai_call', label: 'Assistant Response #3', model: 'gpt-6-luna', spanId: 'm1', parentSpanId: 'ci1', timestamp: at(280), durationMs: 180, finishReason: 'tool_calls' },
    request,
  ];
  const paused: TraceEventInput[] = [...head, sub(6, 'pending', 'pi1', 310, 310)];
  const resumed: TraceEventInput[] = [
    ...paused,
    decision,
    iter('ci2', 9, 2, 5400),
    { id: 'm2', sequence: 10, type: 'ai_call', label: 'Assistant Response #10', model: 'gpt-6-luna', spanId: 'm2', parentSpanId: 'ci2', timestamp: at(5700), durationMs: 280, finishReason: 'stop' },
    { id: 'dt', sequence: 11, type: 'tool_call', label: 'Tool Execution - delegate_to #11', toolName: 'delegate_to', spanId: 'dt', parentSpanId: 'pi1', timestamp: at(5710), durationMs: 5700 },
    sub(12, 'success', 'dt', 5710, 5710),
  ];

  const trails = (nodes: TraceNode[], trail: string[] = []): Array<{ node: TraceNode; trail: string[] }> =>
    nodes.flatMap((node) => {
      const here = [...trail, ...node.foldedLabels, node.label];
      return [{ node, trail: here }, ...trails(node.children, here)];
    });
  const groups = (model: ReturnType<typeof buildSessionModel>) =>
    trails(model.tree).filter(({ node }) => node.label === 'Sub-agent helper' || node.foldedLabels.includes('Sub-agent helper'));

  it('is drawn as one Sub-agent group once finished, with the approval request and decision folded to one step in order', () => {
    const model = buildSessionModel(resumed, { startedAt: at(0), durationMs: 5710 });
    const found = groups(model);
    expect(found).toHaveLength(1);
    expect(found[0].node.event?.status).toBe('success');
    const inside = trails(found[0].node.children).map(({ node }) => node);
    expect(inside.filter((node) => node.event?.type === 'agent_iteration').map((node) => node.label)).toEqual(['Iteration 1', 'Iteration 2']);
    const humans = inside.filter((node) => node.human);
    expect(humans).toHaveLength(1);
    expect(humans[0].human?.state).toBe('approved');
    const all = trails(model.tree).map(({ node }) => node);
    expect(all.some((node) => node.waiting)).toBe(false);
    expect(all.some((node) => node.event?.type === 'span' && node.event.status === 'pending')).toBe(false);
  });

  it('keeps the approval request and its decision in order inside the group when they are not folded', () => {
    const unkeyed = resumed.map((event) => (event.human ? { ...event, human: { ...event.human, key: undefined } } : event));
    const model = buildSessionModel(unkeyed, { startedAt: at(0), durationMs: 5710 });
    const found = groups(model);
    expect(found).toHaveLength(1);
    const humans = trails(found[0].node.children).map(({ node }) => node).filter((node) => node.human);
    expect(humans.map((node) => node.human?.state)).toEqual(['pending', 'approved']);
  });

  it('shows one group and one waiting row while it is still paused', () => {
    const model = buildSessionModel(paused, { startedAt: at(0), durationMs: 310 });
    expect(groups(model)).toHaveLength(1);
    const waiting = trails(model.tree).filter(({ node }) => node.waiting);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].trail.join(' › ')).toContain('Sub-agent helper');
  });

  it('shows one group after a second pause, however many pending records were written', () => {
    const twice = [...paused, { ...sub(7, 'pending', 'pi1', 5000, 5000) }];
    const model = buildSessionModel(twice, { startedAt: at(0), durationMs: 5000 });
    expect(groups(model)).toHaveLength(1);
    expect(trails(model.tree).filter(({ node }) => node.event?.type === 'span' && node.event.status === 'pending').length).toBeLessThanOrEqual(1);
  });

  it('does not change a session without a repeated span id', () => {
    const before = JSON.stringify(labels(buildSessionModel(agentSdk).tree));
    expect(JSON.stringify(labels(buildSessionModel([...agentSdk]).tree))).toBe(before);
  });
});
