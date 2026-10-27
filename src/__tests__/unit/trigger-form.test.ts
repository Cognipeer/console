/**
 * The Studio trigger editor's form ↔ API mapping (triggerForm.ts): what a
 * save sends for each type (the `type` and the one settings object named after
 * it), what it refuses before sending, and how a stored trigger fills the form.
 */

import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';
import {
  TRIGGER_TYPES,
  WEBHOOK_EVENT_SUGGESTIONS,
  WEBHOOK_FILTER_EXAMPLES,
  WEBHOOK_FILTER_OPS,
  WEBHOOK_PRESET_AUTH,
  WEBHOOK_PRESETS,
  WEBHOOK_SAMPLES,
  WEBHOOK_TEMPLATE_VARIABLES,
  emptyTriggerForm,
  formFromTrigger,
  hasWebhookAuthorRule,
  parseMetadataLines,
  triggerBodyFromForm,
  toLocalInputValue,
  webhookVariableValue,
  type TriggerRow,
} from '@/components/agents/studio/triggerForm';
import { DEFAULT_WEBHOOK_HEADER_NAME, WEBHOOK_PRESET_AUTH as SERVER_PRESET_AUTH, WEBHOOK_PRESETS as SERVER_PRESETS } from '@/lib/services/agents/agentTriggerWebhookAuth';
import { WEBHOOK_CONTEXT_ROOTS, boundedView, firstFilterMiss, parseFilterRules, renderWebhookTemplate } from '@/lib/services/agents/agentTriggerWebhookView';

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

  it('sends preset, auth, events, the Actions chips as the first rule, then the rows', () => {
    const built = triggerBodyFromForm({
      ...webhookForm(), webhookEvents: ['pull_request'], webhookActions: ['opened', 'reopened'],
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

  it('a stored webhook fills the form; its first action rule becomes the Actions chips', () => {
    const form = formFromTrigger(storedWebhook({
      preset: 'generic', auth: 'bearer', header_name: null, events: ['merge_request'], include_payload: false,
      filter: [{ path: 'payload.user.username', op: 'in', value: ['jane', 'joe'] }],
    }), 'UTC');
    expect(form).toMatchObject({
      type: 'webhook', webhookPreset: 'generic', webhookAuth: 'bearer', webhookEvents: ['merge_request'], webhookIncludePayload: false,
      webhookActions: [], webhookFilter: [{ path: 'payload.user.username', op: 'in', value: 'jane, joe' }], webhookSecret: '',
    });
    expect(hasWebhookAuthorRule(form)).toBe(true);
    expect(hasWebhookAuthorRule({ ...form, webhookFilter: [{ path: 'payload.draft', op: 'neq', value: 'true' }] })).toBe(false);
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
  const connectorRow = (): TriggerRow => ({
    ...rest, type: 'connector',
    connector: {
      connector_id: 'c1', trigger: 'pull_request', params: { repository: 'acme/api' }, schedule: null, events: ['pull_request.opened'],
      filter: [], include_payload: true, subscription_id: 'sub1', package_id: 'cognipeer.github', kind: 'webhook', label: 'GitHub',
    },
    connector_available: true,
  } as unknown as TriggerRow);

  it('the community form sends only the type: the connector object belongs to the enterprise editor', () => {
    const built = triggerBodyFromForm({ ...base(), type: 'connector' }, [], null, now);
    expect(built.ok && built.body.type).toBe('connector');
    expect(built.ok && ['schedule', 'once', 'webhook'].some((key) => key in built.body)).toBe(false);
  });

  it('a stored connector trigger opens as a connector form, not as manual', () => {
    expect(formFromTrigger(connectorRow(), 'UTC').type).toBe('connector');
  });

  it('the type list offered to create a trigger does not include connector (the editor adds it when the module is present)', () => {
    expect([...TRIGGER_TYPES]).toEqual(['schedule', 'once', 'manual', 'webhook']);
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
      ...['presetGeneric'].flatMap((key) => [key, `${key}Hint`]),
      ...WEBHOOK_PRESETS.flatMap((preset) => WEBHOOK_FILTER_EXAMPLES[preset].map((example) => example.key)),
    ];
    expect(Object.keys(WEBHOOK_EVENT_SUGGESTIONS).sort()).toEqual([...WEBHOOK_PRESETS].sort());
    for (const locale of ['en', 'tr'] as const) {
      const strings = at(messages[locale], 'agents.triggers');
      for (const key of keys) expect(typeof strings[key], `${locale}: ${key}`).toBe('string');
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
