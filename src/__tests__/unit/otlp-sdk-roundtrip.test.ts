/**
 * Round trip: what the agent-sdk 0.18 OTLP exporter writes, read by the ingest mapper.
 *
 * The fixtures under `fixtures/otlp-sdk/` are COPIES of the SDK's golden request
 * bodies (agent-sdk `tests/fixtures/otlp/*.json`, `semconv: 'both'` unless the
 * name says `gen_ai`). They are not regenerated here: when the SDK changes its
 * export, copy the new goldens and let these tests say what the Console no
 * longer understands.
 *
 * The runs are exported in legs. A run that pauses for a person exports the
 * spans of that leg only (no root, the pending sub-agent record withheld), and
 * the leg after the answer exports the rest, root last. Each leg is mapped on
 * its own, exactly as the ingest route receives it.
 */

import { describe, expect, it } from 'vitest';

import { mapOtlpToInternalModels, type OtlpExportTraceServiceRequest, type OtlpSpan } from '@/lib/services/otlpMapper';
import { buildSessionModel, type TraceEventInput, type TraceNode } from '@/components/tracing/sessionModel';
import { foldSupersededSpans } from '@/lib/shared/foldSupersededSpans';
import { humanStep, type SectionShell } from '@/lib/shared/tracingSections';

import runSuccessBoth from '../fixtures/otlp-sdk/run-success.both.json';
import runSuccessGenAi from '../fixtures/otlp-sdk/run-success.gen_ai.json';
import runErrorBoth from '../fixtures/otlp-sdk/run-error.both.json';
import legsLeg1 from '../fixtures/otlp-sdk/legs-paused.leg1.both.json';
import legsLeg2 from '../fixtures/otlp-sdk/legs-paused.leg2.both.json';
import subagentLeg1 from '../fixtures/otlp-sdk/subagent-pending.leg1.both.json';
import subagentLeg2 from '../fixtures/otlp-sdk/subagent-pending.leg2.both.json';

const TENANT = 'tenant-1';
const PROJECT = 'project-1';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const asRequest = (fixture: unknown) => clone(fixture) as OtlpExportTraceServiceRequest;
const map = (fixture: unknown) => mapOtlpToInternalModels(asRequest(fixture), TENANT, PROJECT);
const spansOf = (request: OtlpExportTraceServiceRequest): OtlpSpan[] =>
  (request.resourceSpans ?? []).flatMap((resource) => (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []));

const attrOf = (span: OtlpSpan, key: string) => span.attributes?.find((attribute) => attribute.key === key)?.value;
const nanoToIso = (nano: string | undefined) => new Date(Math.floor(Number(nano) / 1_000_000)).toISOString();

describe('a finished run (both vocabularies)', () => {
  const request = asRequest(runSuccessBoth);
  const root = spansOf(request).find((span) => attrOf(span, 'cognipeer.session.status'))!;
  const mapped = map(runSuccessBoth);
  const [session] = mapped.sessions;

  it('is one session whose root is the SDK root, and the run is over', () => {
    expect(mapped.sessions).toHaveLength(1);
    expect(session.rootSpanId).toBe(root.spanId);
    expect(session.sessionId).toBe('sess_fixture_success');
    expect(session.threadId).toBe('thread_42');
    expect(session.status).toBe('success');
    expect(mapped.endedSessionIds).toEqual(['sess_fixture_success']);
    expect(session.totalEvents).toBe(5);
  });

  it('keeps the event types, labels, tokens and true start times', () => {
    expect(mapped.events.map((event) => event.type)).toEqual(['agent_iteration', 'ai_call', 'tool_call', 'agent_iteration', 'ai_call']);
    const sdkSpans = spansOf(request).filter((span) => span !== root);
    mapped.events.forEach((event, index) => {
      const span = sdkSpans[index];
      expect(event.label).toBe(attrOf(span, 'cognipeer.event.label')?.stringValue);
      expect(event.timestamp?.toISOString()).toBe(nanoToIso(span.startTimeUnixNano));
      expect(event.status).toBe('success');
    });
    const firstCall = mapped.events[1];
    expect(firstCall).toMatchObject({
      model: 'gpt-4o', inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 40, reasoningTokens: 5, finishReason: 'tool_calls',
    });
    expect(session).toMatchObject({ totalInputTokens: 320, totalOutputTokens: 90 });
  });

  it('numbers the events with the sequence the SDK gave them', () => {
    expect(mapped.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('a finished run exported in the gen_ai vocabulary only', () => {
  const mapped = map(runSuccessGenAi);
  const calls = mapped.events.filter((event) => event.type === 'ai_call');

  it('reads the root, the events and the usage from gen_ai.* alone', () => {
    expect(mapped.sessions).toHaveLength(1);
    expect(mapped.endedSessionIds).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(mapped.events.filter((event) => event.type === 'tool_call')).toHaveLength(1);
    expect(calls[0]).toMatchObject({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 40, reasoningTokens: 5, finishReason: 'tool_calls' });
    expect(calls[1]).toMatchObject({ inputTokens: 200, outputTokens: 60, finishReason: 'stop' });
  });

  it('names the model the caller asked for, not the dated model the provider resolved it to (pricing key)', () => {
    // gen_ai.response.model is 'gpt-4o-2024-08-06'; the Model Hub knows 'gpt-4o'.
    expect(calls.map((event) => event.model)).toEqual(['gpt-4o', 'gpt-4o']);
    expect(mapped.sessions[0].modelsUsed).toEqual(['gpt-4o']);
  });

  it('still prefers the resolved model for spans that do not come from the Cognipeer SDK', () => {
    const foreign = asRequest(runSuccessGenAi);
    for (const resource of foreign.resourceSpans ?? []) {
      resource.resource!.attributes = resource.resource!.attributes!.filter((attribute) => attribute.key !== 'telemetry.sdk.name');
    }
    const result = mapOtlpToInternalModels(foreign, TENANT, PROJECT);
    expect(result.events.filter((event) => event.type === 'ai_call').map((event) => event.model)).toEqual(['gpt-4o-2024-08-06', 'gpt-4o-2024-08-06']);
  });
});

describe('statuses UNSET cannot carry', () => {
  const mapped = map(runErrorBoth);
  const byLabel = (needle: string) => mapped.events.find((event) => event.label?.includes(needle))!;

  it('restores skipped from cognipeer.event.status', () => {
    expect(byLabel('Tool Denied').status).toBe('skipped');
    expect(byLabel('Assistant Blocked').status).toBe('skipped');
  });

  it('keeps ERROR as error, with the message and the type from the exception event', () => {
    const failedCall = mapped.events.find((event) => event.type === 'ai_call' && event.status === 'error')!;
    expect(failedCall.error).toMatchObject({ message: '429 Too Many Requests', type: 'RateLimitError' });
    const failedTool = mapped.events.find((event) => event.type === 'tool_call' && event.status === 'error')!;
    expect(failedTool.error?.message).toContain('Cannot read properties of undefined');
  });

  it('puts the session-level exception on the session, not on an event', () => {
    const [session] = mapped.sessions;
    expect(session.status).toBe('error');
    expect(session.errors?.filter((error) => error.eventId === 'session')).toHaveLength(1);
  });

  it('reads pending from the declared status (an approval that waits for a person)', () => {
    const pending = map(legsLeg1).events.find((event) => event.type === 'tool_approval')!;
    expect(pending.status).toBe('pending');
    const decided = map(legsLeg2).events.find((event) => event.type === 'tool_approval')!;
    expect(decided.status).toBe('success');
  });

  it('falls back to the OTLP status when the declared one is unknown', () => {
    const request = asRequest(runSuccessBoth);
    const span = spansOf(request).find((candidate) => attrOf(candidate, 'cognipeer.event.type')?.stringValue === 'ai_call')!;
    span.attributes!.find((attribute) => attribute.key === 'cognipeer.event.status')!.value = { stringValue: 'weird' };
    const [event] = mapOtlpToInternalModels(request, TENANT, PROJECT).events.filter((candidate) => candidate.spanId === span.spanId);
    expect(event.status).toBe('success');
    span.status = { code: 2, message: 'boom' };
    span.attributes!.find((attribute) => attribute.key === 'cognipeer.event.status')!.value = { stringValue: 'success' };
    const [failed] = mapOtlpToInternalModels(request, TENANT, PROJECT).events.filter((candidate) => candidate.spanId === span.spanId);
    expect(failed.status).toBe('error');
  });
});

describe('a run started under an upstream traceparent', () => {
  const REMOTE_PARENT = 'b7ad6b7169203331';
  const underRemoteParent = (fixture: unknown, rootMatches: (span: OtlpSpan) => boolean) => {
    const request = asRequest(fixture);
    const root = spansOf(request).find(rootMatches)!;
    root.parentSpanId = REMOTE_PARENT;
    // 0x300 = parent known + remote; 0x01 = sampled.
    root.flags = 0x301;
    return { request, root };
  };

  it('detects the root by its remote-parent flag and ends the session', () => {
    const { request, root } = underRemoteParent(runSuccessBoth, (span) => Boolean(attrOf(span, 'cognipeer.session.status')));
    const mapped = mapOtlpToInternalModels(request, TENANT, PROJECT);
    expect(mapped.sessions[0].rootSpanId).toBe(root.spanId);
    expect(mapped.endedSessionIds).toEqual(['sess_fixture_success']);
    // The root is the session, not a sixth event.
    expect(mapped.events).toHaveLength(5);
    expect(mapped.events.some((event) => event.spanId === root.spanId)).toBe(false);
  });

  it('detects it with gen_ai.* alone (no cognipeer.session.status on the span)', () => {
    const { request, root } = underRemoteParent(runSuccessGenAi, (span) => attrOf(span, 'gen_ai.operation.name')?.stringValue === 'invoke_agent');
    expect(attrOf(root, 'cognipeer.session.status')).toBeUndefined();
    const mapped = mapOtlpToInternalModels(request, TENANT, PROJECT);
    expect(mapped.sessions[0].rootSpanId).toBe(root.spanId);
    expect(mapped.endedSessionIds).toHaveLength(1);
    expect(mapped.events).toHaveLength(5);
  });

  it('does not take a remote-parent span for the root when it is one of the SDK events', () => {
    const request = asRequest(runSuccessBoth);
    const call = spansOf(request).find((span) => attrOf(span, 'cognipeer.event.type')?.stringValue === 'ai_call')!;
    call.flags = 0x301;
    const mapped = mapOtlpToInternalModels(request, TENANT, PROJECT);
    expect(mapped.events).toHaveLength(5);
    expect(mapped.sessions[0].rootSpanId).not.toBe(call.spanId);
  });

  it('keeps treating a span whose parent is merely missing as an event (no flags, no root marker)', () => {
    const request = asRequest(runSuccessGenAi);
    const root = spansOf(request).find((span) => attrOf(span, 'gen_ai.operation.name')?.stringValue === 'invoke_agent')!;
    root.parentSpanId = REMOTE_PARENT;
    const mapped = mapOtlpToInternalModels(request, TENANT, PROJECT);
    expect(mapped.endedSessionIds).toEqual([]);
    expect(mapped.events).toHaveLength(6);
  });
});

describe('a run that paused for a person and resumed (two legs)', () => {
  const first = map(legsLeg1);
  const second = map(legsLeg2);
  const realRoot = spansOf(asRequest(legsLeg2)).find((span) => attrOf(span, 'cognipeer.session.status'))!;

  it('lands in one session', () => {
    expect(first.sessions[0].sessionId).toBe(second.sessions[0].sessionId);
    expect(first.sessions[0].traceId).toBe(second.sessions[0].traceId);
  });

  it('the first leg has no root and is not over; the second leg has the root and ends the session', () => {
    expect(first.endedSessionIds).toEqual([]);
    expect(first.sessions[0].rootSpanId).not.toBe(realRoot.spanId);
    expect(second.endedSessionIds).toEqual([second.sessions[0].sessionId]);
    expect(second.sessions[0].rootSpanId).toBe(realRoot.spanId);
  });

  it('keeps the SDK sequence across the legs, so nothing collides and the order is the run order', () => {
    const all = [...first.events, ...second.events];
    const sequences = all.map((event) => event.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect([...sequences].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(all.map((event) => event.id)).size).toBe(all.length);
    expect(first.events.every((event) => (event.sequence ?? 0) <= 3)).toBe(true);
    expect(second.events.every((event) => (event.sequence ?? 0) >= 4)).toBe(true);
  });

  it('without the declared sequence the position in the payload is used, as before', () => {
    const stripped = asRequest(legsLeg1);
    for (const span of spansOf(stripped)) {
      span.attributes = span.attributes!.filter((attribute) => attribute.key !== 'cognipeer.event.sequence');
    }
    expect(mapOtlpToInternalModels(stripped, TENANT, PROJECT).events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});

describe('a paused run with a sub-agent (two legs)', () => {
  const first = map(subagentLeg1);
  const second = map(subagentLeg2);
  const rootSpan = spansOf(asRequest(subagentLeg2)).find((span) => attrOf(span, 'cognipeer.session.status'))!;
  const merged = [...first.events, ...second.events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const SUBAGENT_SPAN = '5555555555555555';

  it('is one session with one sub-agent span, written once', () => {
    expect(first.sessions[0].sessionId).toBe(second.sessions[0].sessionId);
    expect(merged.filter((event) => event.spanId === SUBAGENT_SPAN)).toHaveLength(1);
    expect(merged.find((event) => event.spanId === SUBAGENT_SPAN)).toMatchObject({ type: 'span', status: 'success' });
    // Nothing was written pending for the sub-agent, so folding changes nothing.
    expect(foldSupersededSpans(merged)).toHaveLength(merged.length);
  });

  it('resolves every parent inside the merged session (no orphan from the first leg)', () => {
    const known = new Set([rootSpan.spanId, ...merged.map((event) => event.spanId)]);
    const orphans = merged.filter((event) => event.parentSpanId && !known.has(event.parentSpanId));
    expect(orphans.map((event) => event.label)).toEqual([]);
    expect(second.sessions[0].rootSpanId).toBe(rootSpan.spanId);
  });

  it('keeps the approval request pending and the decision after it, in order', () => {
    const approvals = merged.filter((event) => event.type === 'tool_approval');
    expect(approvals.map((event) => event.status)).toEqual(['pending', 'success']);
    expect(approvals[0].sequence).toBeLessThan(approvals[1].sequence ?? 0);
  });

  it('is drawn as one sub-agent group', () => {
    const feed: TraceEventInput[] = merged.map((event) => ({
      id: String(event.id),
      sequence: event.sequence,
      type: event.type,
      label: event.label,
      status: event.status,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      timestamp: event.timestamp?.toISOString(),
      durationMs: event.durationMs,
      model: event.model,
      toolName: event.toolName,
    }));
    const walk = (nodes: TraceNode[]): TraceNode[] => nodes.flatMap((node) => [node, ...walk(node.children)]);
    const model = buildSessionModel(feed, { startedAt: second.sessions[0].startedAt?.toISOString() });
    const groups = walk(model.tree).filter((node) => node.event?.spanId === SUBAGENT_SPAN);
    expect(groups).toHaveLength(1);
    expect(groups[0].children.length).toBeGreaterThan(0);
    // The sub-agent never appears twice, nor as a second pending copy of itself.
    expect(walk(model.tree).some((node) => node.event?.type === 'span' && node.event.status === 'pending')).toBe(false);
  });
});

// ─── approval / question ids that do not depend on content logging ──────────
// The golden legs were exported with content logging off, so their approval events carry no sections at all.
// The SDK stamps the id as `cognipeer.approval.id` / `cognipeer.question.id` for exactly this case (a metadata
// section of `cognipeer.sections` is the other way it reaches Console, and keeps working).
describe('an approval or a question whose only id is an attribute', () => {
  const stamp = (fixture: unknown, key: string, value: string, type = 'tool_approval') => {
    const request = asRequest(fixture);
    const span = spansOf(request).find((candidate) => attrOf(candidate, 'cognipeer.event.type')?.stringValue === type)!;
    expect(span.attributes?.some((attribute) => attribute.key === 'cognipeer.sections')).toBe(false);
    span.attributes = [...(span.attributes ?? []), { key, value: { stringValue: value } }];
    return request;
  };
  /** The feed the UI reads: no sections, the `human` summary computed from the stored ones, as the list route does. */
  const feedOf = (...legs: OtlpExportTraceServiceRequest[]): TraceEventInput[] =>
    legs.flatMap((leg) => mapOtlpToInternalModels(leg, TENANT, PROJECT).events).map((event) => ({
      id: String(event.id),
      sequence: event.sequence,
      type: event.type,
      label: event.label,
      status: event.status,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      timestamp: event.timestamp?.toISOString(),
      human: humanStep({ type: event.type, status: event.status, sections: event.sections as SectionShell[] | undefined }),
    }));
  const approvals = (nodes: TraceNode[]): TraceNode[] =>
    nodes.flatMap((node) => [...(node.human ? [node] : []), ...approvals(node.children)]);

  it('gives the request and its decision the same key, so the request folds into the decision', () => {
    const feed = feedOf(
      stamp(legsLeg1, 'cognipeer.approval.id', 'ap_1'),
      stamp(legsLeg2, 'cognipeer.approval.id', 'ap_1'),
    );
    const humans = feed.filter((event) => event.human);
    expect(humans.map((event) => [event.human?.kind, event.human?.key, event.human?.state])).toEqual([
      ['approval', 'ap_1', 'pending'],
      ['approval', 'ap_1', 'approved'],
    ]);
    const rows = approvals(buildSessionModel(feed).tree);
    expect(rows).toHaveLength(1);
    expect(rows[0].human?.state).toBe('approved');
    expect(rows[0].waiting).toBeFalsy();
  });

  it('shows one waiting row while the request has no decision yet', () => {
    const rows = approvals(buildSessionModel(feedOf(stamp(legsLeg1, 'cognipeer.approval.id', 'ap_1'))).tree);
    expect(rows).toHaveLength(1);
    expect(rows[0].waiting).toBe(true);
  });

  it('without the attribute (and without sections) the request stays next to its decision, unpaired', () => {
    const rows = approvals(buildSessionModel(feedOf(asRequest(legsLeg1), asRequest(legsLeg2))).tree);
    expect(rows).toHaveLength(2);
  });

  it('pairs a question the same way', () => {
    const asQuestion = (fixture: unknown, id: string) => {
      const request = stamp(fixture, 'cognipeer.question.id', id);
      const span = spansOf(request).find((candidate) => attrOf(candidate, 'cognipeer.event.type')?.stringValue === 'tool_approval')!;
      span.attributes = span.attributes!.map((attribute) =>
        attribute.key === 'cognipeer.event.type' ? { key: attribute.key, value: { stringValue: 'user_question' } } : attribute);
      return request;
    };
    const feed = feedOf(asQuestion(legsLeg1, 'q_1'), asQuestion(legsLeg2, 'q_1'));
    expect(feed.filter((event) => event.human).map((event) => [event.human?.kind, event.human?.key, event.human?.state])).toEqual([
      ['question', 'q_1', 'pending'],
      ['question', 'q_1', 'answered'],
    ]);
    expect(approvals(buildSessionModel(feed).tree)).toHaveLength(1);
  });

  it('leaves an id that the sections already carry alone', () => {
    const request = stamp(legsLeg1, 'cognipeer.approval.id', 'ap_attr');
    const span = spansOf(request).find((candidate) => attrOf(candidate, 'cognipeer.event.type')?.stringValue === 'tool_approval')!;
    span.attributes!.push({
      key: 'cognipeer.sections',
      value: { stringValue: JSON.stringify([{ kind: 'metadata', label: 'Approval', data: { approvalId: 'ap_section', status: 'pending' } }]) },
    });
    const event = mapOtlpToInternalModels(request, TENANT, PROJECT).events.find((candidate) => candidate.type === 'tool_approval')!;
    expect(event.sections).toHaveLength(1);
    expect(humanStep({ type: event.type, status: event.status, sections: event.sections as SectionShell[] })?.key).toBe('ap_section');
  });
});

// ─── a trace somebody else exported ────────────────────────────────────────

describe('a third-party trace with remote-parent flags', () => {
  const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
  const span = (n: number, name: string, extra: Partial<OtlpSpan> = {}): OtlpSpan => ({
    traceId: hex(77, 32),
    spanId: hex(n, 16),
    name,
    startTimeUnixNano: String(1_700_000_000_000_000_000 + n * 1_000_000),
    endTimeUnixNano: String(1_700_000_000_000_000_000 + n * 1_000_000 + 500_000),
    ...extra,
  });
  // Newer OTel SDKs set 0x200 on every entry span behind an upstream traceparent, an HTTP server span among them.
  const server = span(1, 'GET /chat', { parentSpanId: hex(999, 16), flags: 0x301 });
  const chat = span(2, 'chat gpt-4o', {
    parentSpanId: server.spanId,
    flags: 0x101,
    attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }, { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } }],
  });
  const request = (resource: Array<{ key: string; value: { stringValue: string } }>): OtlpExportTraceServiceRequest => ({
    resourceSpans: [{ resource: { attributes: resource }, scopeSpans: [{ spans: [server, chat] }] }],
  });

  it('keeps every span an event and the session open: the flag alone is not a root marker', () => {
    const mapped = mapOtlpToInternalModels(request([{ key: 'service.name', value: { stringValue: 'web' } }]), TENANT, PROJECT);
    expect(mapped.events.map((event) => event.spanId)).toEqual([server.spanId, chat.spanId]);
    expect(mapped.sessions[0].totalEvents).toBe(2);
    expect(mapped.endedSessionIds).toEqual([]);
  });

  it('is still the root when the Cognipeer SDK exported it', () => {
    const mapped = mapOtlpToInternalModels(request([
      { key: 'service.name', value: { stringValue: 'web' } },
      { key: 'telemetry.sdk.name', value: { stringValue: 'cognipeer-agent-sdk' } },
    ]), TENANT, PROJECT);
    expect(mapped.sessions[0].rootSpanId).toBe(server.spanId);
    expect(mapped.events.map((event) => event.spanId)).toEqual([chat.spanId]);
    expect(mapped.endedSessionIds).toHaveLength(1);
  });
});

describe('spans without cognipeer.event.sequence (a gen_ai-only export)', () => {
  it('are marked as numbered by position, so the ingest route can continue the numbering', () => {
    const mapped = map(runSuccessGenAi);
    expect(attrOf(spansOf(asRequest(runSuccessGenAi))[0], 'cognipeer.event.sequence')).toBeUndefined();
    expect(mapped.positionalSequence.size).toBe(mapped.events.length);
  });

  it('are not marked when the SDK numbered them', () => {
    expect(map(runSuccessBoth).positionalSequence.size).toBe(0);
  });
});
