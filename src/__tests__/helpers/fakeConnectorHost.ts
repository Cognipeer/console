/**
 * A stand-in for the enterprise Connectors module: the `ConnectorTriggerHost`
 * seam over an in-memory subscription table, with a call log so tests can
 * assert the order in which core calls it, and switches to make a step fail.
 *
 * Three connectors exist: `conn-1` (package `cognipeer.github`, triggers
 * `pull_request` and `workflow_run`, both webhooks; takes any parameters and
 * events), `conn-gh` (the same package, but checked like the real module:
 * `repository` is a required parameter and the events are the manifest's) and
 * `conn-poll` (package `cognipeer.jira`, trigger `issue_updated`, a poll).
 * Anything else is unknown. Subscriptions are shared by (connector, trigger,
 * params, schedule) like the real module's; `bindings` counts the triggers
 * bound to one.
 */

import type { AgentTriggerConnector, IAgentTrigger } from '@/lib/database';
import type {
  ConnectorTriggerHost,
  ConnectorTriggerScope,
  ConnectorTriggerView,
} from '@/enterprise/connector-triggers';
import { GITHUB_PACKAGE_ID, GITHUB_TRIGGERS } from './githubConnectorFixture';

interface Subscription {
  id: string;
  key: string;
  kind: 'webhook' | 'poll';
  status: ConnectorTriggerView['status'];
  secret: string | null;
  /** Until when the secret before the last rotation is still accepted (a rotation with a grace period). */
  previousValidUntil: Date | null;
  bound: Set<string>;
}

interface FakeTrigger {
  packageId: string;
  kind: 'webhook' | 'poll';
  label: string;
  /** Given: the only parameters the trigger takes (others are refused), and the required ones among them. */
  params?: { accepted: string[]; required: string[] };
  /** Given: the only event types the trigger reports (others are refused). */
  events?: string[];
}

const TRIGGERS: Record<string, Record<string, FakeTrigger>> = {
  'conn-1': {
    pull_request: { packageId: 'cognipeer.github', kind: 'webhook', label: 'GitHub - Pull request' },
    workflow_run: { packageId: 'cognipeer.github', kind: 'webhook', label: 'GitHub - Workflow run' },
  },
  'conn-gh': Object.fromEntries(
    (['pull_request', 'workflow_run'] as const).map((name) => [name, {
      packageId: GITHUB_PACKAGE_ID,
      kind: 'webhook' as const,
      label: name === 'pull_request' ? 'GitHub - Pull request' : 'GitHub - Workflow run',
      params: {
        accepted: Object.keys(GITHUB_TRIGGERS[name].params),
        required: Object.entries(GITHUB_TRIGGERS[name].params).filter(([, param]) => param.required).map(([key]) => key),
      },
      events: GITHUB_TRIGGERS[name].events,
    }]),
  ),
  'conn-poll': {
    issue_updated: { packageId: 'cognipeer.jira', kind: 'poll', label: 'Jira - Issue updated' },
  },
};

export interface FakeConnectorHost {
  host: ConnectorTriggerHost;
  /** `<method>:<triggerId or connector id>` in call order. */
  calls: string[];
  /** The scopes the host was called with. */
  scopes: ConnectorTriggerScope[];
  subscriptions: Map<string, Subscription>;
  /** Make the next call of a method throw (`attach`, `detach`, `view`, `sample`, `rotate`, `retry`). */
  failing: Set<string>;
  /** Make a method throw this value instead of the plain error `failing` throws (a refusal with a status and a code, say). */
  failWith: Map<string, unknown>;
  /** Make `attach` answer a `failed` view instead of `active`. */
  attachStatus: ConnectorTriggerView['status'];
  /** What `sample` answers; null = none. */
  sampleEvent: { eventType: string; data: unknown } | null;
  /**
   * What `prepare` says of the cron of a poll's schedule, the way the real module does with its own grammar: a sentence refuses it (on
   * `connector.schedule.cron`), null takes it. Absent: any cron is taken, so core's own cron-parser check is the one that can refuse.
   */
  judgeCron: ((cron: string) => string | null) | null;
  /** The cron `prepare` hands back in place of the one it was given (a host that normalizes the schedule): core checks the prepared one. */
  rewriteCron: ((cron: string) => string) | null;
  /** The triggers (by id) bound to a subscription, from the host's own table. */
  boundTo: (subscriptionId: string) => string[];
}

export function createFakeConnectorHost(): FakeConnectorHost {
  const calls: string[] = [];
  const scopes: ConnectorTriggerScope[] = [];
  const subscriptions = new Map<string, Subscription>();
  const failing = new Set<string>();
  const failWith = new Map<string, unknown>();
  let counter = 0;

  const state: FakeConnectorHost = {
    host: null as unknown as ConnectorTriggerHost,
    calls,
    scopes,
    subscriptions,
    failing,
    failWith,
    attachStatus: 'active',
    // The package's own flat event data (see githubConnectorFixture), with the repository and number the tests read.
    sampleEvent: { eventType: GITHUB_TRIGGERS.pull_request.sample.type, data: { ...GITHUB_TRIGGERS.pull_request.sample.data, repository: 'acme/api', number: 42 } },
    judgeCron: null,
    rewriteCron: null,
    boundTo: (subscriptionId) => [...(subscriptions.get(subscriptionId)?.bound ?? [])],
  };

  const keyOf = (settings: AgentTriggerConnector) => JSON.stringify([settings.connectorId, settings.trigger, settings.params, settings.schedule ?? null]);
  const fail = (method: string) => {
    if (failWith.has(method)) throw failWith.get(method);
    if (failing.has(method)) throw new Error(`${method} failed`);
  };
  const viewOf = (subscription: Subscription, secret?: string | null): ConnectorTriggerView => ({
    subscriptionId: subscription.id,
    status: subscription.status,
    kind: subscription.kind,
    reason: subscription.status === 'failed' ? 'The vendor refused the registration.' : null,
    reasonCode: subscription.status === 'failed' ? 'subscribe_failed' : null,
    callbackUrl: subscription.kind === 'webhook' ? `https://console.example/api/public/connectors/${subscription.id}` : null,
    secretHint: subscription.secret ? subscription.secret.slice(-4) : null,
    secret: secret ?? null,
    // Like the real module: the previous secret is reported only while its grace period runs.
    previousSecretValidUntil: subscription.previousValidUntil && subscription.previousValidUntil.getTime() > Date.now() ? subscription.previousValidUntil : null,
    autoRegistered: subscription.status === 'active',
    bindings: subscription.bound.size,
  });

  state.host = {
    async prepare(scope, input) {
      calls.push('prepare');
      scopes.push(scope);
      const settings = input.settings as AgentTriggerConnector;
      const catalog = TRIGGERS[settings.connectorId];
      if (!catalog) return { ok: false, errors: [{ field: 'connector.connector_id', message: 'No such connector in this project' }] };
      const trigger = catalog[settings.trigger];
      if (!trigger) return { ok: false, errors: [{ field: 'connector.trigger', message: 'The connector\'s package has no such trigger' }] };
      if (settings.params && 'bad' in settings.params) return { ok: false, errors: [{ field: 'connector.params.bad', message: 'Not a parameter of this trigger' }] };
      if (trigger.params) {
        // Like the real module: an unknown parameter and a missing required one are refused, each on its own field.
        const errors: Array<{ field: string; message: string }> = [];
        for (const key of Object.keys(settings.params ?? {})) {
          if (!trigger.params.accepted.includes(key)) errors.push({ field: `connector.params.${key}`, message: `${key} is not a parameter of this trigger` });
        }
        for (const key of trigger.params.required) {
          const value = settings.params?.[key];
          if (value === undefined || value === null || value === '') errors.push({ field: `connector.params.${key}`, message: `${key} is required` });
        }
        if (errors.length > 0) return { ok: false, errors };
      }
      const unknownEvents = trigger.events ? (settings.events ?? []).filter((event) => !trigger.events!.includes(event)) : [];
      if (unknownEvents.length > 0) return { ok: false, errors: [{ field: 'connector.events', message: `Not an event of this trigger: ${unknownEvents.join(', ')}` }] };
      if (trigger.kind === 'poll' && !settings.schedule) return { ok: false, errors: [{ field: 'connector.schedule', message: 'A poll trigger needs a schedule' }] };
      const cronSentence = trigger.kind === 'poll' && settings.schedule ? state.judgeCron?.(settings.schedule.cron) ?? null : null;
      if (cronSentence) return { ok: false, errors: [{ field: 'connector.schedule.cron', message: cronSentence }] };
      const prepared = trigger.kind === 'poll' ? settings.schedule ?? null : null;
      return {
        ok: true,
        settings: {
          ...settings,
          schedule: prepared && state.rewriteCron ? { ...prepared, cron: state.rewriteCron(prepared.cron) } : prepared,
          packageId: trigger.packageId,
          kind: trigger.kind,
          label: trigger.label,
        },
      };
    },

    async attach(scope, trigger) {
      calls.push(`attach:${String(trigger._id)}`);
      scopes.push(scope);
      fail('attach');
      if (trigger.type !== 'connector') throw new Error('attach called for a trigger that is not a connector one');
      const key = keyOf(trigger.connector);
      let subscription = [...subscriptions.values()].find((item) => item.key === key);
      let secret: string | null = null;
      if (!subscription) {
        counter += 1;
        secret = `whsec_fake_${counter}_${'x'.repeat(12)}`;
        subscription = {
          id: `sub_${counter}`,
          key,
          kind: trigger.connector.kind ?? 'webhook',
          status: state.attachStatus,
          secret,
          previousValidUntil: null,
          bound: new Set(),
        };
        subscriptions.set(subscription.id, subscription);
      }
      subscription.bound.add(String(trigger._id));
      return { settings: { ...trigger.connector, subscriptionId: subscription.id }, view: viewOf(subscription, secret) };
    },

    async detach(scope, trigger) {
      calls.push(`detach:${String(trigger._id)}`);
      scopes.push(scope);
      fail('detach');
      if (trigger.type !== 'connector' || !trigger.connector.subscriptionId) return;
      const subscription = subscriptions.get(trigger.connector.subscriptionId);
      if (!subscription) return;
      subscription.bound.delete(String(trigger._id));
      if (subscription.bound.size === 0) subscriptions.delete(subscription.id);
    },

    async view(scope, trigger: IAgentTrigger) {
      calls.push(`view:${String(trigger._id)}`);
      scopes.push(scope);
      fail('view');
      if (trigger.type !== 'connector' || !trigger.connector.subscriptionId) return null;
      const subscription = subscriptions.get(trigger.connector.subscriptionId);
      return subscription ? viewOf(subscription) : null;
    },

    async sample(scope, trigger) {
      calls.push(`sample:${String(trigger._id)}`);
      scopes.push(scope);
      fail('sample');
      return state.sampleEvent;
    },

    async rotate(scope, trigger, options) {
      calls.push(`rotate:${String(trigger._id)}`);
      scopes.push(scope);
      fail('rotate');
      if (trigger.type !== 'connector' || !trigger.connector.subscriptionId) return null;
      const subscription = subscriptions.get(trigger.connector.subscriptionId);
      if (!subscription) return null;
      if (subscription.kind === 'poll') return viewOf(subscription);
      subscription.secret = `whsec_rotated_${'y'.repeat(14)}`;
      // The old secret stays accepted for the grace period the caller asked for (none: it stops at once).
      subscription.previousValidUntil = options.graceSeconds > 0 ? new Date(Date.now() + options.graceSeconds * 1000) : null;
      return viewOf(subscription, subscription.secret);
    },

    async retry(scope, trigger) {
      calls.push(`retry:${String(trigger._id)}`);
      scopes.push(scope);
      fail('retry');
      if (trigger.type !== 'connector' || !trigger.connector.subscriptionId) return null;
      const subscription = subscriptions.get(trigger.connector.subscriptionId);
      if (!subscription) return null;
      subscription.status = 'active';
      return viewOf(subscription);
    },
  };
  return state;
}
