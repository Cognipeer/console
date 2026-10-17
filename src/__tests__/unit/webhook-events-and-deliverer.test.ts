/**
 * The pure parts of webhook subscriptions: which events a subscription covers,
 * how an attempt's outcome is classified, the signature scheme, the env-driven
 * parameters, and which session-log events become webhook events.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const hoisted = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: hoisted.safeFetch }));

import {
  WEBHOOK_EVENT_CATALOG,
  eventMatches,
  isValidEventPattern,
  normalizeEventList,
  patternMatches,
} from '@/lib/services/webhooks/webhookEvents';
import { sendSignedWebhook, signWebhookBody } from '@/lib/services/webhooks/webhookDeliverer';
import { sessionWebhookEvents } from '@/lib/services/webhooks/sessionWebhookEvents';
import { getConfig, reloadConfig } from '@/lib/core/config';
import { signAgentRunCallback } from '@/lib/services/agents/agentRunService';

afterEach(() => {
  delete process.env.WEBHOOK_RETRY_SCHEDULE_SECONDS;
  delete process.env.WEBHOOK_TIMEOUT_MS;
  delete process.env.WEBHOOK_AUTO_DISABLE_HOURS;
  delete process.env.WEBHOOK_DELIVERY_RETENTION_DAYS;
  reloadConfig();
  vi.clearAllMocks();
});

describe('event matching', () => {
  it('matches exact types, prefix.* patterns and *', () => {
    expect(patternMatches('session.idled', 'session.idled')).toBe(true);
    expect(patternMatches('session.idled', 'session.work_done')).toBe(false);
    expect(patternMatches('agent_run.*', 'agent_run.requires_action')).toBe(true);
    expect(patternMatches('agent_run.*', 'agent_run')).toBe(false);
    expect(patternMatches('session.*', 'agent_run.succeeded')).toBe(false);
    expect(patternMatches('*', 'routine.failed')).toBe(true);
  });

  it('alerts are a catalog group: alert.fired and alert.resolved are selectable and covered by alert.*', () => {
    const types = WEBHOOK_EVENT_CATALOG.filter((event) => event.group === 'alert').map((event) => event.type);
    expect(types).toEqual(['alert.fired', 'alert.resolved']);
    expect(eventMatches(['alert.*'], 'alert.fired')).toBe(true);
    expect(eventMatches(['alert.*'], 'alert.resolved')).toBe(true);
    expect(isValidEventPattern('alert.*')).toBe(true);
    expect(normalizeEventList(['alert.fired'])).toEqual({ ok: true, events: ['alert.fired'] });
  });

  it('a prefix pattern does not match a longer, different prefix', () => {
    expect(patternMatches('agent.*', 'agent_run.succeeded')).toBe(false);
  });

  it('covers a type when any entry of the subscription does', () => {
    expect(eventMatches(['budget.reached', 'routine.*'], 'routine.fired')).toBe(true);
    expect(eventMatches(['budget.reached', 'routine.*'], 'session.idled')).toBe(false);
    expect(eventMatches([], 'session.idled')).toBe(false);
  });

  it('every catalog type is selectable and covered by its own group pattern', () => {
    for (const event of WEBHOOK_EVENT_CATALOG) {
      expect(isValidEventPattern(event.type)).toBe(true);
      expect(patternMatches(`${event.type.split('.')[0]}.*`, event.type)).toBe(true);
    }
  });

  it('validates a subscription list: known types and patterns only, de-duplicated, non-empty', () => {
    expect(normalizeEventList(['session.idled', 'session.idled', ' agent_run.* '])).toEqual({
      ok: true, events: ['session.idled', 'agent_run.*'],
    });
    expect(normalizeEventList([])).toMatchObject({ ok: false });
    expect(normalizeEventList('session.idled')).toMatchObject({ ok: false });
    expect(normalizeEventList(['nope.never'])).toMatchObject({ ok: false, message: expect.stringContaining('nope.never') });
    expect(normalizeEventList(['nope.*'])).toMatchObject({ ok: false });
    expect(normalizeEventList([''])).toMatchObject({ ok: false });
  });
});

describe('signature', () => {
  it('is t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")> and the agent-run callback signer is the same scheme', () => {
    const header = signWebhookBody('s3cret', '{"a":1}', 1_700_000_000);
    const expected = crypto.createHmac('sha256', 's3cret').update('1700000000.{"a":1}').digest('hex');
    expect(header).toBe(`t=1700000000,v1=${expected}`);
    expect(signAgentRunCallback('s3cret', '{"a":1}', 1_700_000_000)).toBe(header);
    expect(signWebhookBody('other', '{"a":1}', 1_700_000_000)).not.toBe(header);
  });
});

describe('sendSignedWebhook outcomes', () => {
  const input = {
    url: 'https://hooks.example.com/in', body: '{}', eventName: 'session.idled', eventId: 'evt_1',
    userAgent: 'test/1', secret: 'k', timeoutMs: 1000,
  };

  it('classifies 2xx, 3xx, other statuses, network errors and guard refusals', async () => {
    hoisted.safeFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await sendSignedWebhook(input)).toMatchObject({ outcome: 'delivered', ok: true, statusCode: 204 });

    hoisted.safeFetch.mockResolvedValueOnce(new Response(null, { status: 301 }));
    expect(await sendSignedWebhook(input)).toMatchObject({ outcome: 'redirect', ok: false, statusCode: 301 });

    hoisted.safeFetch.mockResolvedValueOnce(new Response('x', { status: 410 }));
    expect(await sendSignedWebhook(input)).toMatchObject({ outcome: 'http_error', ok: false, statusCode: 410 });

    hoisted.safeFetch.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect(await sendSignedWebhook(input)).toMatchObject({ outcome: 'network', ok: false, error: 'ETIMEDOUT' });

    const refused = new Error('Refusing outbound request to private/loopback host: localhost');
    refused.name = 'OutboundNetworkError';
    hoisted.safeFetch.mockRejectedValueOnce(refused);
    expect(await sendSignedWebhook(input)).toMatchObject({ outcome: 'blocked', ok: false });

    // A failed DNS lookup is a network failure (retried), not a rejected target.
    const unresolved = Object.assign(new Error('Could not resolve host: hooks.example.com'), {
      name: 'OutboundNetworkError', code: 'dns_lookup_failed',
    });
    hoisted.safeFetch.mockRejectedValueOnce(unresolved);
    expect(await sendSignedWebhook(input)).toMatchObject({ outcome: 'network', ok: false });
  });

  it('says a request that ran out of time timed out, instead of the bare "This operation was aborted"', async () => {
    // The guard aborts its own controller at `timeoutMs`; fetch rejects with the abort's name and message.
    hoisted.safeFetch.mockRejectedValueOnce(new DOMException('This operation was aborted', 'AbortError'));
    expect(await sendSignedWebhook({ ...input, timeoutMs: 5000 })).toMatchObject({
      outcome: 'network', ok: false, error: 'Timed out after 5000 ms',
    });

    hoisted.safeFetch.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(await sendSignedWebhook(input)).toMatchObject({ outcome: 'network', error: 'Timed out after 1000 ms' });

    // Other network failures keep their own message.
    hoisted.safeFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED 203.0.113.9:443'));
    expect(await sendSignedWebhook(input)).toMatchObject({ outcome: 'network', error: 'connect ECONNREFUSED 203.0.113.9:443' });
  });

  it('omits the signature without a secret, and only adds webhook-id and no-redirect when asked', async () => {
    hoisted.safeFetch.mockResolvedValue(new Response(null, { status: 200 }));
    await sendSignedWebhook({ ...input, secret: undefined });
    const [, plainInit, plainOptions] = hoisted.safeFetch.mock.calls[0] as [string, { headers: Record<string, string> }, Record<string, unknown>];
    expect(plainInit.headers['x-cognipeer-signature']).toBeUndefined();
    expect(plainInit.headers['webhook-id']).toBeUndefined();
    expect(plainOptions).toEqual({ timeoutMs: 1000 });

    await sendSignedWebhook({ ...input, webhookIdHeader: true, followRedirects: false });
    const [, init, options] = hoisted.safeFetch.mock.calls[1] as [string, { headers: Record<string, string> }, Record<string, unknown>];
    expect(init.headers['webhook-id']).toBe('evt_1');
    expect(init.headers['x-cognipeer-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(options).toEqual({ timeoutMs: 1000, followRedirects: false });
  });
});

describe('parameters (env)', () => {
  it('defaults: 10s timeout, 7-step schedule, 72h auto-disable, 30 days retention', () => {
    const cfg = getConfig().webhooks;
    expect(cfg.timeoutMs).toBe(10_000);
    expect(cfg.retryScheduleSeconds).toEqual([60, 300, 1800, 7200, 21600, 43200, 86400]);
    expect(cfg.autoDisableHours).toBe(72);
    expect(cfg.deliveryRetentionDays).toBe(30);
  });

  it('are set from WEBHOOK_* env; an unusable schedule keeps the default', () => {
    process.env.WEBHOOK_TIMEOUT_MS = '3000';
    process.env.WEBHOOK_RETRY_SCHEDULE_SECONDS = '5, 10,20';
    process.env.WEBHOOK_AUTO_DISABLE_HOURS = '24';
    process.env.WEBHOOK_DELIVERY_RETENTION_DAYS = '7';
    reloadConfig();
    expect(getConfig().webhooks).toMatchObject({
      timeoutMs: 3000, retryScheduleSeconds: [5, 10, 20], autoDisableHours: 24, deliveryRetentionDays: 7,
    });

    process.env.WEBHOOK_RETRY_SCHEDULE_SECONDS = 'soon,never,-4';
    reloadConfig();
    expect(getConfig().webhooks.retryScheduleSeconds).toHaveLength(7);
  });
});

describe('session log events that are webhook events', () => {
  const scope = { agentKey: 'support', conversationId: 'conv-1' };

  it('an action.required webhook never carries the request: no arguments, no tool name', () => {
    const [call] = sessionWebhookEvents([
      { type: 'action.required', data: { actionId: 'act_9', kind: 'client_tool', toolName: 'lookup_order', args: { id: 'A-1' }, timeoutSeconds: 20 } },
      { type: 'action.required', data: { actionId: 'act_11', kind: 'tool_approval', toolName: 'sandbox_exec', args: { cmd: 'rm -rf' } } },
    ], scope);
    expect(call.data).toEqual({ sessionId: 'conv-1', conversationId: 'conv-1', agentKey: 'support', actionId: 'act_9', kind: 'client_tool' });
    expect(JSON.stringify(sessionWebhookEvents([
      { type: 'action.required', data: { actionId: 'act_11', kind: 'tool_approval', toolName: 'sandbox_exec', args: { cmd: 'rm -rf' } } },
    ], scope))).not.toContain('rm -rf');
  });

  it('maps idle, work_done, action.required and budget.reached to thin event data', () => {
    const events = sessionWebhookEvents([
      { type: 'agent.message', data: { content: 'secret text that must not leave' } },
      { type: 'action.required', data: { actionId: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec', args: { cmd: 'rm -rf' } } },
      { type: 'budget.reached', data: { spentUsd: 1.5, maxCostUsd: 1 } },
      { type: 'session.status_idle', data: { stopReason: 'end_turn', detail: 'x' } },
      { type: 'session.work_done', data: {} },
      { type: 'agent.tool_use', data: { name: 'x' } },
    ], scope);

    expect(events).toEqual([
      { type: 'action.required', data: { sessionId: 'conv-1', conversationId: 'conv-1', agentKey: 'support', actionId: 'act_1', kind: 'tool_approval' } },
      { type: 'budget.reached', data: { sessionId: 'conv-1', conversationId: 'conv-1', agentKey: 'support', spentUsd: 1.5, maxCostUsd: 1 } },
      { type: 'session.idled', data: { sessionId: 'conv-1', conversationId: 'conv-1', agentKey: 'support', stopReason: 'end_turn' } },
      { type: 'session.work_done', data: { sessionId: 'conv-1', conversationId: 'conv-1', agentKey: 'support' } },
    ]);
  });

  it('maps nothing for events that are only part of the log', () => {
    expect(sessionWebhookEvents([{ type: 'user.message', data: { content: 'hi' } }, { type: 'session.usage', data: {} }], scope)).toEqual([]);
  });
});
