/**
 * Unit tests - the structural check of an answer against openapi.yaml
 *
 * Route tests lean on `shapeProblems` to say "this answer is what the document promises". A check that never
 * complains proves nothing, so the cases below show what it flags on real schemas of the document, and that it
 * accepts the shapes the document itself describes (a wire built by `toSubscriptionWire`).
 */

import { describe, expect, it } from 'vitest';

import { toSubscriptionWire } from '@/lib/services/agents/agentTriggerConnectorHost';
import type { ConnectorTriggerView } from '@/enterprise/connector-triggers';
import { componentSchema, shapeProblems } from '../helpers/openapiShape';

const manualView: ConnectorTriggerView = {
  subscriptionId: 'sub_1',
  status: 'manual',
  kind: 'webhook',
  reason: 'This trigger cannot be registered at the vendor automatically. Set the webhook up with the URL and the secret.',
  reasonCode: 'no_subscribe',
  callbackUrl: 'https://console.example/api/public/connectors/sub_1',
  secretHint: 'abcd',
  secret: 'whsec_example',
  previousSecretValidUntil: new Date('2026-10-28T12:00:00.000Z'),
  autoRegistered: false,
  setup: '1. Open the repository settings.',
  bindings: 2,
};

describe('shapeProblems', () => {
  it('accepts a subscription wire built from a view, with and without the optional parts', () => {
    expect(shapeProblems(toSubscriptionWire(manualView), 'ConnectorSubscription')).toEqual([]);
    const poll: ConnectorTriggerView = {
      subscriptionId: 'sub_2', status: 'active', kind: 'poll', bindings: 1,
      schedule: { cron: '*/15 * * * *', timezone: 'UTC' }, nextPollAt: new Date('2026-10-28T10:15:00.000Z'), lastPollAt: new Date('2026-10-28T10:00:00.000Z'),
    };
    expect(shapeProblems(toSubscriptionWire(poll), 'ConnectorSubscription')).toEqual([]);
  });

  it('flags a key the schema does not declare, at any depth, unless it is told not to', () => {
    const wire = { ...toSubscriptionWire(manualView), extra_key: 1 };
    expect(shapeProblems(wire, 'ConnectorSubscription')).toEqual(['$.extra_key: not declared by the schema']);
    expect(shapeProblems(wire, 'ConnectorSubscription', { strict: false })).toEqual([]);
    const nested = { ...toSubscriptionWire(manualView), schedule: { cron: '* * * * *', timezone: 'UTC', jitter: 5 } };
    expect(shapeProblems(nested, 'ConnectorSubscription')).toEqual(['$.schedule.jitter: not declared by the schema']);
  });

  it('flags null where the schema is not nullable, a wrong type, a value outside the enum and a missing required key', () => {
    const wire = toSubscriptionWire(manualView) as unknown as Record<string, unknown>;
    expect(shapeProblems({ ...wire, bindings: null }, 'ConnectorSubscription')).toEqual(['$.bindings: null, but the schema does not allow null']);
    expect(shapeProblems({ ...wire, bindings: '2' }, 'ConnectorSubscription')).toEqual(['$.bindings: expected integer, got string']);
    expect(shapeProblems({ ...wire, bindings: 1.5 }, 'ConnectorSubscription')).toEqual(['$.bindings: expected integer, got number']);
    expect(shapeProblems({ ...wire, status: 'broken' }, 'ConnectorSubscription')[0]).toContain('$.status: "broken" is not one of');
    const { subscription_id: _omitted, ...without } = wire;
    expect(shapeProblems(without, 'ConnectorSubscription')).toEqual(['$.subscription_id: required, but missing']);
  });

  it('follows allOf + nullable (the subscription inside a trigger answer) and refuses an undeclared key there', () => {
    const answer = {
      object: 'agent.trigger.webhook_secret', secret_hint: null, previous_valid_until: null,
      connector_subscription: toSubscriptionWire(manualView),
    };
    expect(shapeProblems(answer, 'AgentTriggerWebhookSecret')).toEqual([]);
    expect(shapeProblems({ ...answer, connector_subscription: null }, 'AgentTriggerWebhookSecret')).toEqual([]);
    expect(shapeProblems({ ...answer, connector_subscription: { ...toSubscriptionWire(manualView), oops: true } }, 'AgentTriggerWebhookSecret'))
      .toEqual(['$.connector_subscription.oops: not declared by the schema']);
  });

  it('knows the rotation answer schema declares the subscription and a nullable secret hint', () => {
    const properties = componentSchema('AgentTriggerWebhookSecret').properties;
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['connector_subscription', 'previous_valid_until', 'secret_hint']));
    expect(properties.secret_hint.nullable).toBe(true);
    expect(componentSchema('ConnectorSubscription').properties.previous_secret_valid_until.nullable).toBe(true);
    expect(componentSchema('ConnectorSubscription').properties.reason_code.nullable).toBe(true);
  });

  it('refuses an unknown schema name', () => {
    expect(() => shapeProblems({}, 'NoSuchSchema')).toThrow('openapi.yaml has no schema NoSuchSchema');
  });
});
