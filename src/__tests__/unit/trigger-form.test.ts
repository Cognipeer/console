/**
 * The Studio trigger editor's form ↔ API mapping (triggerForm.ts): what a
 * save sends for each type (the `type` and the one settings object named after
 * it), what it refuses before sending, and how a stored trigger fills the form.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';
import type { IAgentTrigger } from '@/lib/database';
import {
  CONNECTOR_TEMPLATE_VARIABLES,
  TRIGGER_TYPES,
  WEBHOOK_EVENT_SUGGESTIONS,
  WEBHOOK_FILTER_EXAMPLES,
  WEBHOOK_FILTER_OPS,
  WEBHOOK_PRESET_AUTH,
  WEBHOOK_PRESETS,
  WEBHOOK_SAMPLES,
  WEBHOOK_TEMPLATE_VARIABLES,
  connectorFormFromRetired,
  connectorTriggerLabel,
  emptyTriggerForm,
  formFromTrigger,
  isRetiredWebhook,
  parseMetadataLines,
  rowsOnWebhookOnlyData,
  triggerBodyFromForm,
  toLocalInputValue,
  webhookVariableValue,
  withTriggerLocale,
  type TriggerRow,
  type WebhookFilterOp,
  type WebhookFilterRow,
} from '@/components/agents/studio/triggerForm';
import { eventView } from '@/lib/services/agents/agentTriggerEventDispatch';
import { DEFAULT_WEBHOOK_HEADER_NAME, WEBHOOK_PRESET_AUTH as SERVER_PRESET_AUTH, WEBHOOK_PRESETS as SERVER_PRESETS } from '@/lib/services/agents/agentTriggerWebhookAuth';
import { RETIRED_WEBHOOK_AUTH, RETIRED_WEBHOOK_PRESETS } from '@/lib/services/agents/agentTriggerWebhookAuth';
import { WEBHOOK_CONTEXT_ROOTS, boundedView, filterRuleMatches, firstFilterMiss, parseFilterRules, renderWebhookTemplate } from '@/lib/services/agents/agentTriggerWebhookView';

const now = new Date('2026-10-18T10:00:00Z');
const base = () => ({ ...emptyTriggerForm('Europe/Istanbul', now), name: 'Digest', prompt: 'Summarise.' });

/** What every stored trigger carries besides its type and the settings object of that type. */
const rest = {
  id: 'trg1', object: 'agent.trigger' as const, agent: 'report-bot', name: 'Digest', description: null, enabled: true,
  prompt: 'Summarise.', variables: { region: 'eu' },
  version: 2, class: 'deferred' as const, metadata: { team: 'ops' }, callback: { url: 'https://example.com/hook', signed: true },
  response_format: { type: 'json_object' }, next_fire_at: null, last_fire_at: null, last_run_id: null, last_status: null, last_error: null,
  created_at: null, updated_at: null,
};

/** A weekday schedule trigger. */
const stored = (): TriggerRow => ({ ...rest, type: 'schedule', schedule: { cron: '0 9 * * 1-5', timezone: 'Europe/Istanbul' } });
/** A once trigger: only its own settings object is present. */
const storedOnce = (runAt: string): TriggerRow => ({ ...rest, type: 'once', once: { run_at: runAt } });

describe('triggerBodyFromForm', () => {
  it('a schedule sends cron + timezone and the run settings', () => {
    const built = triggerBodyFromForm({ ...base(), metadataText: 'team=ops\n\nticket = OPS-1', runClass: 'deferred', version: 3 }, [], null, now);
    expect(built).toEqual({ ok: true, body: expect.objectContaining({
      name: 'Digest', enabled: true, prompt: 'Summarise.', version: 3, class: 'deferred', metadata: { team: 'ops', ticket: 'OPS-1' },
      callback: null, response_format: null, variables: null, type: 'schedule', schedule: { cron: '0 9 * * 1-5', timezone: 'Europe/Istanbul' },
    }) });
  });

  it('once "in N" sends delay_seconds; once "at" sends run_at and refuses a past time', () => {
    const delay = triggerBodyFromForm({ ...base(), type: 'once', onceMode: 'in', delayAmount: 2, delayUnit: 'hours' }, [], null, now);
    expect(delay.ok && [delay.body.type, delay.body.once]).toEqual(['once', { delay_seconds: 7200 }]);
    expect(delay.ok && ['schedule', 'webhook'].some((key) => key in delay.body)).toBe(false);
    const at = new Date('2026-10-18T12:00:00Z');
    const later = triggerBodyFromForm({ ...base(), type: 'once', onceMode: 'at', runAtLocal: toLocalInputValue(at) }, [], null, now);
    expect(later.ok && [later.body.type, later.body.once]).toEqual(['once', { run_at: at.toISOString() }]);
    const past = triggerBodyFromForm({ ...base(), type: 'once', onceMode: 'at', runAtLocal: toLocalInputValue(new Date('2026-10-18T08:00:00Z')) }, [], null, now);
    expect(past).toEqual({ ok: false, problem: { field: 'runAtLocal', key: 'oncePast' } });
  });

  it('manual sends only the type, with no settings object', () => {
    const built = triggerBodyFromForm({ ...base(), type: 'manual' }, [], null, now);
    expect(built.ok && built.body.type).toBe('manual');
    expect(built.ok && ['schedule', 'once', 'webhook'].some((key) => key in built.body)).toBe(false);
  });

  it('refuses a missing name, a bad cron, bad metadata lines and bad JSON before sending', () => {
    expect(triggerBodyFromForm({ ...base(), name: ' ' }, [], null, now)).toMatchObject({ ok: false, problem: { field: 'name' } });
    expect(triggerBodyFromForm({ ...base(), cron: '0 0 9 * * *' }, [], null, now)).toMatchObject({ ok: false, problem: { field: 'cron' } });
    expect(triggerBodyFromForm({ ...base(), metadataText: 'no equals sign' }, [], null, now)).toMatchObject({ ok: false, problem: { field: 'metadataText' } });
    expect(triggerBodyFromForm({ ...base(), responseFormatText: '{oops' }, [], null, now)).toMatchObject({ ok: false, problem: { field: 'responseFormatText' } });
  });

  it('sends only the variables the agent declares that were given', () => {
    const declared = [{ name: 'region', type: 'string' as const }, { name: 'days', type: 'integer' as const }];
    const built = triggerBodyFromForm({ ...base(), variables: { region: 'eu', days: undefined, stale: 'x' } }, declared, null, now);
    expect(built.ok && built.body.variables).toEqual({ region: 'eu' });
  });

  it('the callback secret is sent only when one was typed', () => {
    const kept = triggerBodyFromForm({ ...base(), callbackUrl: 'https://example.com/hook', callbackSigned: true }, [], null, now);
    expect(kept.ok && kept.body.callback).toEqual({ url: 'https://example.com/hook' });
    const replaced = triggerBodyFromForm({ ...base(), callbackUrl: 'https://example.com/hook', callbackSecret: 'a-new-secret-12345' }, [], null, now);
    expect(replaced.ok && replaced.body.callback).toEqual({ url: 'https://example.com/hook', secret: 'a-new-secret-12345' });
  });

  it('editing a once trigger whose time already passed, without touching it, leaves its type and time out', () => {
    const row = storedOnce('2026-10-01T06:00:00.000Z');
    const built = triggerBodyFromForm({ ...formFromTrigger(row, 'UTC'), name: 'Renamed' }, [], row, now);
    expect(built.ok).toBe(true);
    expect(built.ok && ['type', 'once'].some((key) => key in built.body)).toBe(false);
  });
});

describe('webhook trigger', () => {
  const webhookForm = () => ({ ...base(), type: 'webhook' as const });
  const storedWebhook = (webhook: Record<string, unknown>): TriggerRow => ({
    ...rest, type: 'webhook', webhook: { url: 'https://console.example.com/api/public/hooks/t/wh_x', ...webhook },
  });

  it('the preset and auth lists match the server’s', () => {
    expect([...WEBHOOK_PRESETS]).toEqual([...SERVER_PRESETS]);
    expect(WEBHOOK_PRESET_AUTH).toEqual(SERVER_PRESET_AUTH);
    expect(emptyTriggerForm().webhookHeaderName).toBe(DEFAULT_WEBHOOK_HEADER_NAME);
    for (const variable of WEBHOOK_TEMPLATE_VARIABLES) expect(WEBHOOK_CONTEXT_ROOTS).toContain(variable.split('.')[0]);
  });

  it('the auth select offers the generic modes only and the tags are roots the server knows', () => {
    expect([...WEBHOOK_PRESET_AUTH.generic].sort()).toEqual(['bearer', 'header', 'signature', 'standard_webhooks']);
    for (const retired of RETIRED_WEBHOOK_AUTH) expect(WEBHOOK_PRESET_AUTH.generic).not.toContain(retired);
    for (const retired of RETIRED_WEBHOOK_PRESETS) expect(WEBHOOK_PRESETS).not.toContain(retired);
  });

  it('sends preset, auth, events, then the filter rows', () => {
    const built = triggerBodyFromForm({
      ...webhookForm(), webhookEvents: ['pull_request'],
      webhookFilter: [{ path: 'payload.pull_request.draft', op: 'neq', value: 'true' }, { path: 'payload.labels.*.name', op: 'in', value: 'bug, ui ,' }, { path: '', op: 'eq', value: '' }],
    }, [], null, now);
    expect(built.ok && built.body.type).toBe('webhook');
    expect(built.ok && built.body.webhook).toEqual({
      preset: 'generic', auth: 'bearer', events: ['pull_request'], include_payload: true,
      filter: [
        { path: 'payload.pull_request.draft', op: 'neq', value: 'true' },
        { path: 'payload.labels.*.name', op: 'in', value: ['bug', 'ui'] },
      ],
    });
  });

  it('every one-click example is a filter the server accepts', () => {
    for (const preset of WEBHOOK_PRESETS) {
      for (const example of WEBHOOK_FILTER_EXAMPLES[preset]) {
        const built = triggerBodyFromForm({ ...webhookForm(), webhookPreset: preset, webhookAuth: WEBHOOK_PRESET_AUTH[preset][0], webhookSecret: 'whsec_x', webhookFilter: example.rows }, [], null, now);
        expect(built.ok, example.key).toBe(true);
        expect(parseFilterRules((built.ok && (built.body.webhook as { filter: unknown }).filter)).ok, example.key).toBe(true);
      }
    }
  });

  it('header auth sends the header name; a rule without its value is refused', () => {
    const header = triggerBodyFromForm({ ...webhookForm(), webhookPreset: 'generic', webhookAuth: 'header', webhookHeaderName: 'X-Token' }, [], null, now);
    expect(header.ok && header.body.webhook).toMatchObject({ auth: 'header', header_name: 'X-Token' });
    const missing = triggerBodyFromForm({ ...webhookForm(), webhookFilter: [{ path: 'payload.action', op: 'eq', value: '' }] }, [], null, now);
    expect(missing).toEqual({ ok: false, problem: { field: 'webhookFilter', key: 'filterRowInvalid' } });
    const exists = triggerBodyFromForm({ ...webhookForm(), webhookFilter: [{ path: 'payload.sender', op: 'exists', value: '' }] }, [], null, now);
    expect(exists.ok && (exists.body.webhook as { filter: unknown }).filter).toEqual([{ path: 'payload.sender', op: 'exists' }]);
  });

  it('Standard Webhooks needs the sender’s secret unless the stored trigger already has one', () => {
    const form = { ...webhookForm(), webhookPreset: 'generic' as const, webhookAuth: 'standard_webhooks' as const };
    expect(triggerBodyFromForm(form, [], null, now)).toEqual({ ok: false, problem: { field: 'webhookSecret', key: 'standardSecretRequired' } });
    const pasted = triggerBodyFromForm({ ...form, webhookSecret: ' whsec_abc ' }, [], null, now);
    expect(pasted.ok && pasted.body.webhook).toMatchObject({ auth: 'standard_webhooks', secret: 'whsec_abc' });
    const row = storedWebhook({ preset: 'generic', auth: 'standard_webhooks' });
    const kept = triggerBodyFromForm(form, [], row, now);
    expect(kept.ok && 'secret' in (kept.body.webhook as object)).toBe(false);
    // A secret typed for another auth mode is never sent (the server generates those).
    const other = triggerBodyFromForm({ ...webhookForm(), webhookSecret: 'whsec_abc' }, [], null, now);
    expect(other.ok && 'secret' in (other.body.webhook as object)).toBe(false);
  });

  it('a stored webhook fills the form', () => {
    const form = formFromTrigger(storedWebhook({
      preset: 'generic', auth: 'bearer', header_name: null, events: ['merge_request'], include_payload: false,
      filter: [{ path: 'payload.user.username', op: 'in', value: ['jane', 'joe'] }],
    }), 'UTC');
    expect(form).toMatchObject({
      type: 'webhook', webhookPreset: 'generic', webhookAuth: 'bearer', webhookEvents: ['merge_request'], webhookIncludePayload: false,
      webhookFilter: [{ path: 'payload.user.username', op: 'in', value: 'jane, joe' }], webhookSecret: '',
    });
  });

  it('a retired vendor webhook opens as a generic one and is told apart from a live one', () => {
    const retired = storedWebhook({ preset: 'github', auth: 'github_signature', events: ['pull_request'], retired: true });
    expect(isRetiredWebhook(retired)).toBe(true);
    expect(isRetiredWebhook(storedWebhook({ preset: 'generic', auth: 'bearer', retired: false }))).toBe(false);
    expect(isRetiredWebhook(stored())).toBe(false);
    expect(formFromTrigger(retired, 'UTC')).toMatchObject({ type: 'webhook', webhookPreset: 'generic', webhookAuth: 'bearer' });
  });

  it('a mapping field keeps a template as text and brings a literal to the declared type', () => {
    expect(webhookVariableValue({ name: 'n', type: 'integer' }, '{{payload.number}}')).toBe('{{payload.number}}');
    expect(webhookVariableValue({ name: 'n', type: 'integer' }, '7')).toBe(7);
    expect(webhookVariableValue({ name: 'n', type: 'number' }, '1.')).toBe('1.');
    expect(webhookVariableValue({ name: 'b', type: 'boolean' }, 'false')).toBe(false);
    expect(webhookVariableValue({ name: 'j', type: 'json' }, '{"a":1}')).toEqual({ a: 1 });
    expect(webhookVariableValue({ name: 's', type: 'string' }, '42')).toBe('42');
  });
});

describe('connector trigger', () => {
  const connectorRow = (connector: Record<string, unknown> = {}): TriggerRow => ({
    ...rest, type: 'connector',
    connector: {
      connector_id: 'c1', trigger: 'pull_request', params: { repository: 'acme/api' }, schedule: null, events: ['pull_request.opened'],
      filter: [{ path: 'payload.pull_request.draft', op: 'neq', value: 'true' }], include_payload: false, subscription_id: 'sub1',
      package_id: 'cognipeer.github', kind: 'webhook', label: 'GitHub', ...connector,
    },
    connector_available: true,
  } as unknown as TriggerRow);
  const picked = (value: Partial<NonNullable<ReturnType<typeof emptyTriggerForm>['connector']>> = {}) => ({
    connectorId: 'c1', trigger: 'pull_request', params: { repository: 'acme/api' }, events: ['pull_request.opened'], scheduleCron: '', scheduleTimezone: 'UTC', ...value,
  });
  const connectorForm = (value = picked()) => ({ ...base(), type: 'connector' as const, connector: value });

  it('the type list is the server’s, with connector last', () => {
    const plugin = readFileSync(path.resolve(__dirname, '../../server/api/plugins/agent-triggers.ts'), 'utf8');
    const server = /const TRIGGER_TYPES[^=]*=\s*\[([^\]]+)\]/.exec(plugin)?.[1].split(',').map((item) => item.trim().replace(/'/g, '')).filter(Boolean);
    expect([...TRIGGER_TYPES]).toEqual(server);
    expect(TRIGGER_TYPES.at(-1)).toBe('connector');
  });

  it('sends the picker’s value, the filter rows and the payload choice in the API’s spelling', () => {
    const built = triggerBodyFromForm({
      ...connectorForm(), webhookIncludePayload: false,
      webhookFilter: [{ path: 'payload.pull_request.draft', op: 'neq', value: 'true' }, { path: 'payload.labels.*.name', op: 'in', value: 'bug, ui' }, { path: '', op: 'eq', value: '' }],
    }, [], null, now);
    expect(built.ok && built.body.type).toBe('connector');
    expect(built.ok && built.body.connector).toEqual({
      connector_id: 'c1', trigger: 'pull_request', params: { repository: 'acme/api' }, events: ['pull_request.opened'],
      filter: [{ path: 'payload.pull_request.draft', op: 'neq', value: 'true' }, { path: 'payload.labels.*.name', op: 'in', value: ['bug', 'ui'] }],
      include_payload: false,
    });
    expect(built.ok && ['schedule', 'once', 'webhook'].some((key) => key in built.body)).toBe(false);
  });

  it('a poll trigger sends its schedule; a webhook one sends none', () => {
    const poll = triggerBodyFromForm(connectorForm(picked({ scheduleCron: ' */5 * * * * ', scheduleTimezone: 'Europe/Istanbul' })), [], null, now);
    expect(poll.ok && (poll.body.connector as { schedule?: unknown }).schedule).toEqual({ cron: '*/5 * * * *', timezone: 'Europe/Istanbul' });
    const push = triggerBodyFromForm(connectorForm(), [], null, now);
    expect(push.ok && 'schedule' in (push.body.connector as object)).toBe(false);
  });

  it('refuses a missing connector or trigger, a bad cron and a half-written filter row before sending', () => {
    expect(triggerBodyFromForm({ ...base(), type: 'connector' }, [], null, now)).toEqual({ ok: false, problem: { field: 'connector', key: 'connectorRequired' } });
    expect(triggerBodyFromForm(connectorForm(picked({ trigger: '' })), [], null, now)).toMatchObject({ ok: false, problem: { field: 'connector', key: 'connectorRequired' } });
    expect(triggerBodyFromForm(connectorForm(picked({ scheduleCron: '0 0 9 * * *' })), [], null, now)).toEqual({ ok: false, problem: { field: 'connector', key: 'previewInvalid' } });
    expect(triggerBodyFromForm({ ...connectorForm(), webhookFilter: [{ path: 'payload.x', op: 'eq', value: '' }] }, [], null, now))
      .toEqual({ ok: false, problem: { field: 'webhookFilter', key: 'filterRowInvalid' } });
  });

  it('a stored connector trigger opens as a connector form, not as manual, and sends back what it was', () => {
    const row = connectorRow({ kind: 'poll', schedule: { cron: '*/10 * * * *', timezone: 'UTC' } });
    const form = formFromTrigger(row, 'Europe/Istanbul');
    expect(form).toMatchObject({
      type: 'connector', webhookIncludePayload: false, webhookFilter: [{ path: 'payload.pull_request.draft', op: 'neq', value: 'true' }],
      connector: { connectorId: 'c1', trigger: 'pull_request', params: { repository: 'acme/api' }, events: ['pull_request.opened'], scheduleCron: '*/10 * * * *', scheduleTimezone: 'UTC' },
    });
    const built = triggerBodyFromForm(form, [], row, now);
    expect(built.ok && built.body.connector).toEqual({
      connector_id: 'c1', trigger: 'pull_request', params: { repository: 'acme/api' }, events: ['pull_request.opened'],
      schedule: { cron: '*/10 * * * *', timezone: 'UTC' }, filter: [{ path: 'payload.pull_request.draft', op: 'neq', value: 'true' }], include_payload: false,
    });
  });

  it('a stored webhook connector trigger has no schedule in its form', () => {
    expect(formFromTrigger(connectorRow(), 'UTC').connector).toMatchObject({ scheduleCron: '', scheduleTimezone: 'UTC' });
  });

  it('converting a retired vendor trigger carries the prompt, variables, filter and payload choice, and leaves the connector to pick', () => {
    const retired: TriggerRow = {
      ...rest, type: 'webhook', prompt: 'Review {{payload.number}}', variables: { region: 'eu' },
      webhook: {
        url: 'https://console.example.com/api/public/hooks/t/wh_x', preset: 'github', auth: 'github_signature', retired: true, events: ['pull_request'],
        filter: [{ path: 'payload.sender.type', op: 'eq', value: 'User' }], include_payload: false,
      },
    } as unknown as TriggerRow;
    const form = connectorFormFromRetired(retired, 'UTC');
    expect(form).toMatchObject({
      type: 'connector', name: 'Digest', prompt: 'Review {{payload.number}}', variables: { region: 'eu' }, connector: null, webhookEvents: [],
      webhookFilter: [{ path: 'payload.sender.type', op: 'eq', value: 'User' }], webhookIncludePayload: false,
    });
    // Once the connector is picked, the save turns the same row into a connector trigger.
    const built = triggerBodyFromForm({ ...form, connector: picked() }, [{ name: 'region', type: 'string' }], retired, now);
    expect(built.ok && built.body).toMatchObject({
      type: 'connector', prompt: 'Review {{payload.number}}', variables: { region: 'eu' },
      connector: { connector_id: 'c1', filter: [{ path: 'payload.sender.type', op: 'eq', value: 'User' }], include_payload: false },
    });
    expect(built.ok && 'webhook' in built.body).toBe(false);
  });

  it('keeps the rows that read the vendor\'s headers or preset as they were, and points them out', () => {
    const retired = {
      ...rest, id: 'r1', type: 'webhook',
      webhook: {
        url: 'https://console.example.com/api/public/hooks/t/wh_x', preset: 'github', auth: 'github_signature', retired: true, events: ['pull_request'],
        filter: [
          { path: 'headers.x-github-event', op: 'eq', value: 'pull_request' },
          { path: 'payload.pull_request.draft', op: 'eq', value: false },
          { path: 'preset', op: 'eq', value: 'github' },
        ],
        include_payload: true,
      },
    } as unknown as TriggerRow;
    const form = connectorFormFromRetired(retired, 'UTC');
    // Nothing is dropped behind the user's back ...
    expect(form.webhookFilter.map((row) => row.path)).toEqual(['headers.x-github-event', 'payload.pull_request.draft', 'preset']);
    // ... but the two rules a connector event can never meet are found.
    expect(rowsOnWebhookOnlyData(form.webhookFilter)).toEqual({ never: [0, 2], always: [] });
  });

  it('flags only paths that start at headers or preset', () => {
    const rows = (...paths: string[]) => paths.map((path) => ({ path, op: 'eq' as const, value: 'x' }));
    expect(rowsOnWebhookOnlyData(rows('headers', 'headers.x-github-event', 'preset', 'preset.name'))).toEqual({ never: [0, 1, 2, 3], always: [] });
    expect(rowsOnWebhookOnlyData(rows('  headers.x-a  ', ' preset '))).toEqual({ never: [0, 1], always: [] });
    // Data the connector event does carry, or that only looks alike.
    expect(rowsOnWebhookOnlyData(rows('payload.headers.x', 'payload.preset', 'event', 'delivery_id', 'headersx', 'presets', 'connector.name', 'trigger.name', 'agent.key', 'payload.'))).toEqual({ never: [], always: [] });
    expect(rowsOnWebhookOnlyData([])).toEqual({ never: [], always: [] });
  });

  describe('a row on headers or preset is judged by what it does on a connector event', () => {
    const row = (path: string, op: WebhookFilterOp, value = ''): WebhookFilterRow => ({ path, op, value });

    it('a rule on a header holds only when it asks for the header to be absent', () => {
      expect(rowsOnWebhookOnlyData([
        row('headers.x-github-event', 'eq', 'pull_request'),
        row('headers.x-github-event', 'neq', 'pull_request'),
        row('headers.x-github-event', 'exists'),
        row('headers.x-github-event', 'not_exists'),
        row('headers.x-github-event', 'contains', 'pull'),
        row('headers.x-github-event', 'in', 'push, pull_request'),
        row('headers.x-github-event', 'not_in', 'push, pull_request'),
        row('headers.x-github-event', 'starts_with', 'pull'),
        row('headers.x-github-event', 'glob', '*'),
      ])).toEqual({ never: [0, 1, 2, 4, 5, 6, 7, 8], always: [3] });
    });

    it('a rule on the preset is judged against the text connector', () => {
      expect(rowsOnWebhookOnlyData([
        row('preset', 'eq', 'connector'),
        row('preset', 'eq', 'github'),
        row('preset', 'neq', 'github'),
        row('preset', 'neq', 'connector'),
        row('preset', 'in', 'github, connector'),
        row('preset', 'not_in', 'github, gitlab'),
        row('preset', 'contains', 'nect'),
        row('preset', 'glob', 'git*'),
        row('preset', 'exists'),
        row('preset', 'not_exists'),
        row('preset.name', 'not_exists'),
        row('preset.name', 'eq', 'connector'),
      ])).toEqual({ never: [1, 3, 7, 9, 11], always: [0, 2, 4, 5, 6, 8, 10] });
    });

    it('does not judge a row that cannot be sent yet (a save refuses it first)', () => {
      expect(rowsOnWebhookOnlyData([row('headers.x', 'eq', ''), row('preset', 'in', ' , '), row('preset', 'neq', ''), row('headers.x', 'not_exists')]))
        .toEqual({ never: [], always: [3] });
    });

    it('judges the row over the very view a connector event has', () => {
      // The view the server builds for a connector event (the Connectors module hands it no headers).
      const view = eventView({
        trigger: { _id: 't1', name: 'Example', agentKey: 'agent' } as unknown as IAgentTrigger,
        preset: 'connector',
        payload: { number: 7 },
        headers: {},
        identity: { event: 'pull_request.opened', deliveryId: 'delivery-1' },
        receivedAt: new Date(now),
        connector: { id: 'c1', key: 'github', name: 'GitHub', packageId: 'cognipeer.github', trigger: 'pull_request' },
      });
      const rows: WebhookFilterRow[] = [];
      for (const path of ['headers', 'headers.x-github-event', 'headers.*', 'preset', 'preset.name', ' preset ']) {
        for (const op of WEBHOOK_FILTER_OPS) {
          for (const value of op === 'exists' || op === 'not_exists' ? [''] : ['connector', 'github', 'conn*', 'github, connector']) rows.push(row(path, op, value));
        }
      }
      const ruleOf = (item: WebhookFilterRow) => ({
        path: item.path.trim(),
        op: item.op,
        ...(item.op === 'exists' || item.op === 'not_exists' ? {} : { value: item.op === 'in' || item.op === 'not_in' ? item.value.split(',').map((part) => part.trim()) : item.value }),
      });
      const found = rowsOnWebhookOnlyData(rows);
      const always = rows.flatMap((item, index) => (filterRuleMatches(view, ruleOf(item)) ? [index] : []));
      expect(found.always).toEqual(always);
      expect(found.never).toEqual(rows.flatMap((_, index) => (always.includes(index) ? [] : [index])));
      // Both kinds are there, so the comparison says something.
      expect(found.always.length).toBeGreaterThan(10);
      expect(found.never.length).toBeGreaterThan(10);
    });
  });

  it('the tags offered are roots the server knows, and a connector event has no headers', () => {
    for (const variable of CONNECTOR_TEMPLATE_VARIABLES) expect(WEBHOOK_CONTEXT_ROOTS).toContain(variable.split('.')[0]);
    expect(CONNECTOR_TEMPLATE_VARIABLES.some((variable) => variable.startsWith('headers'))).toBe(false);
  });
});

describe('formFromTrigger', () => {
  it('fills the form from a stored trigger (never a secret)', () => {
    const form = formFromTrigger(stored(), 'UTC');
    expect(form).toMatchObject({
      name: 'Digest', type: 'schedule', cron: '0 9 * * 1-5', timezone: 'Europe/Istanbul', variables: { region: 'eu' },
      version: 2, runClass: 'deferred', metadataText: 'team=ops', callbackUrl: 'https://example.com/hook', callbackSigned: true, callbackSecret: '',
    });
    expect(JSON.parse(form.responseFormatText)).toEqual({ type: 'json_object' });
  });

  it('an unknown type opens as manual', () => {
    // A type a newer server knows: the form falls back to manual rather than failing.
    const row = { ...rest, type: 'something-new' } as unknown as TriggerRow;
    expect(formFromTrigger(row, 'UTC').type).toBe('manual');
  });
});

describe('parseMetadataLines', () => {
  it('reads key=value lines, values may contain "="', () => {
    expect(parseMetadataLines('a=1\n b = x=y \n')).toEqual({ a: '1', b: 'x=y' });
    expect(parseMetadataLines('=v')).toBeNull();
  });
});

describe('strings', () => {
  type Tree = { [key: string]: string | Tree };
  const at = (tree: unknown, path: string) => path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree) as Tree;
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('the triggers editor has every string in English and Turkish, with the same placeholders', () => {
    const en = at(messages.en, 'agents.triggers');
    const tr = at(messages.tr, 'agents.triggers');
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) expect(placeholders(String(tr[key])), key).toEqual(placeholders(String(en[key])));
  });

  it('keys built at run time (operators, outcomes, presets, auth modes, examples, event hints) exist in both languages', () => {
    const keys = [
      ...WEBHOOK_FILTER_OPS.map((op) => `op_${op}`),
      ...['accepted', 'duplicate', 'filtered', 'ignored', 'unauthorized', 'rejected', 'failed'].map((outcome) => `outcome_${outcome}`),
      // The names of the retired presets stay: a stored trigger of one is still listed under its name.
      'presetGeneric', 'presetGithub', 'presetGitlab', 'presetAzureDevops',
      ...['kindConnectorWebhook', 'kindConnectorPoll', 'summaryConnector', 'summaryConnectorAny', 'retired', 'retiredHint', 'retiredNotice', 'convert'],
      ...['connectorUnavailable', 'connectorUnavailableBadge', 'connectorCatalogFailed', 'connectorRequired', 'connectorUnattendedHint', 'deliveriesHintConnector'],
      ...['connectorTestHint', 'connectorTestEvent', 'connectorTestEventPlaceholder', 'connectorTestEventInvalid', 'connectorTestPayloadHint'],
      ...WEBHOOK_PRESETS.flatMap((preset) => WEBHOOK_FILTER_EXAMPLES[preset].map((example) => example.key)),
    ];
    expect(Object.keys(WEBHOOK_EVENT_SUGGESTIONS).sort()).toEqual([...WEBHOOK_PRESETS].sort());
    for (const locale of ['en', 'tr'] as const) {
      const strings = at(messages[locale], 'agents.triggers');
      for (const key of keys) expect(typeof strings[key], `${locale}: ${key}`).toBe('string');
    }
  });

  it('the hint under a rule that never matches names what a connector event does carry, in both languages: no headers, and the preset “connector”', () => {
    // `preset eq github` is in the group of rules that match nothing: a connector event has a preset, and it is not github.
    expect(rowsOnWebhookOnlyData([{ path: 'preset', op: 'eq', value: 'github' }])).toEqual({ never: [0], always: [] });
    const en = at(messages.en, 'agents.triggers');
    const tr = at(messages.tr, 'agents.triggers');
    expect(en.convertRowHint).toBe('A connector event has no headers and its preset is always “connector”: this rule never matches.');
    expect(tr.convertRowHint).toBe('Bağlayıcı olayında başlık (header) yoktur ve hazır ayarı (preset) her zaman “connector”dır: bu kural hiçbir zaman eşleşmez.');
    // It does not say the event has no preset (it has one), nor does its twin for the rules that match everything.
    expect(en.convertRowHint).not.toMatch(/no headers or preset/);
    expect(tr.convertRowHint).not.toMatch(/ve hazır ayar yoktur/);
    for (const strings of [en, tr]) {
      expect(strings.convertRowHint).toContain('“connector”');
      expect(strings.convertRowAlwaysHint).toContain('“connector”');
      expect(strings.convertRowHint).not.toBe(strings.convertRowAlwaysHint);
    }
  });

  it('the editor’s strings no longer carry the vendor presets, except the names a retired trigger is listed under', () => {
    for (const locale of ['en', 'tr'] as const) {
      const vendor = Object.keys(at(messages[locale], 'agents.triggers')).filter((key) => /github|gitlab|azure|ado/i.test(key));
      expect(vendor.sort(), locale).toEqual(['presetAzureDevops', 'presetGithub', 'presetGitlab']);
    }
  });

  it('the trigger delete confirm has its noun and warning in both languages', () => {
    for (const locale of ['en', 'tr'] as const) {
      expect(typeof at(messages[locale], 'common.confirm.nouns').agentTrigger).toBe('string');
      expect(typeof at(messages[locale], 'common.confirm.extras').agentTriggerStops).toBe('string');
    }
  });
});

describe('the Test tab samples and the variables offered', () => {
  const view = (preset: keyof typeof WEBHOOK_SAMPLES) => boundedView({ payload: WEBHOOK_SAMPLES[preset].payload, headers: WEBHOOK_SAMPLES[preset].headers });

  it('do not offer received_at as an example (a template may still use it)', () => {
    expect([...WEBHOOK_TEMPLATE_VARIABLES]).not.toContain('received_at');
    expect(WEBHOOK_CONTEXT_ROOTS).toContain('received_at');
  });

  it('the generic sample carries what its prompts and filters name', () => {
    expect(renderWebhookTemplate('{{payload.ticket.id}} {{payload.id}} {{payload.ticket.url}}', view('generic'))).toContain('"T-1001" "evt_sample_1"');
  });

  it('the first filter example of every preset matches its own sample', () => {
    for (const preset of WEBHOOK_PRESETS) {
      const example = WEBHOOK_FILTER_EXAMPLES[preset][0];
      if (!example) continue;
      const built = triggerBodyFromForm({ ...base(), type: 'webhook', webhookPreset: preset, webhookAuth: WEBHOOK_PRESET_AUTH[preset][0], webhookFilter: example.rows, webhookSecret: 'whsec_x'.padEnd(20, 'x') }, [], null, now);
      const filter = built.ok ? (built.body.webhook as { filter?: Parameters<typeof firstFilterMiss>[1] }).filter : undefined;
      expect(firstFilterMiss(view(preset), filter), preset).toBeNull();
    }
  });
});

describe('withTriggerLocale', () => {
  it('names tr and en on the path; another locale leaves it as it is', () => {
    expect(withTriggerLocale('/api/agents/a1/triggers', 'tr')).toBe('/api/agents/a1/triggers?locale=tr');
    expect(withTriggerLocale('/api/agents/a1/triggers/t1', 'en')).toBe('/api/agents/a1/triggers/t1?locale=en');
    expect(withTriggerLocale('/api/agents/a1/triggers/t1', 'de')).toBe('/api/agents/a1/triggers/t1');
    expect(withTriggerLocale('/api/agents/a1/triggers/t1', '')).toBe('/api/agents/a1/triggers/t1');
  });

  it('adds to a query string that is already there', () => {
    expect(withTriggerLocale('/api/agents/a1/triggers?limit=5', 'tr')).toBe('/api/agents/a1/triggers?limit=5&locale=tr');
  });
});

describe('connectorTriggerLabel', () => {
  const stored = { connector_id: 'c1', trigger: 'pull_request', package_id: 'cognipeer.github', label: 'GitHub · Pull request' };
  const entry = (title: string, over: Record<string, unknown> = {}) => ({
    id: 'c1', packageName: 'GitHub', triggers: [{ name: 'issues', title: 'Issues' }, { name: 'pull_request', title }], ...over,
  }) as unknown as Parameters<typeof connectorTriggerLabel>[1][number];

  it('is the title the reader\'s catalog gives the connector\'s trigger, with the package name in front', () => {
    expect(connectorTriggerLabel(stored, [entry('Çekme isteği')])).toBe('GitHub · Çekme isteği');
    expect(connectorTriggerLabel(stored, [entry('Pull request')])).toBe('GitHub · Pull request');
  });

  it('is the stored label where the catalog does not know the connector or the trigger', () => {
    expect(connectorTriggerLabel(stored, [])).toBe('GitHub · Pull request');
    expect(connectorTriggerLabel(stored, [entry('Çekme isteği', { id: 'c9' })])).toBe('GitHub · Pull request');
    expect(connectorTriggerLabel({ ...stored, trigger: 'workflow_run' }, [entry('Çekme isteği')])).toBe('GitHub · Pull request');
    expect(connectorTriggerLabel(stored, [entry('')])).toBe('GitHub · Pull request');
  });

  it('is the package or the trigger name for a trigger stored without a label', () => {
    expect(connectorTriggerLabel({ ...stored, label: null }, [])).toBe('cognipeer.github');
    expect(connectorTriggerLabel({ ...stored, label: undefined, package_id: null }, [])).toBe('pull_request');
  });
});
