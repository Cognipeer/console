/**
 * The Studio routine editor's form ↔ API mapping (routineForm.ts): what a
 * save sends for each trigger type, what it refuses before sending, and how a
 * stored routine fills the form.
 */

import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';
import {
  emptyRoutineForm,
  formFromRoutine,
  parseMetadataLines,
  routineBodyFromForm,
  toLocalInputValue,
  type RoutineRow,
} from '@/components/agents/studio/routineForm';

const now = new Date('2026-10-18T10:00:00Z');
const base = () => ({ ...emptyRoutineForm('Europe/Istanbul', now), name: 'Digest', prompt: 'Summarise.' });

const stored = (overrides: Partial<RoutineRow> = {}): RoutineRow => ({
  id: 'rt1', object: 'agent.routine', agent: 'report-bot', name: 'Digest', description: null, enabled: true,
  trigger: { type: 'schedule', cron: '0 9 * * 1-5', timezone: 'Europe/Istanbul' }, prompt: 'Summarise.', inputs: { region: 'eu' },
  version: 2, class: 'deferred', metadata: { team: 'ops' }, callback: { url: 'https://example.com/hook', signed: true },
  response_format: { type: 'json_object' }, next_fire_at: null, last_fire_at: null, last_run_id: null, last_status: null, last_error: null,
  created_at: null, updated_at: null, ...overrides,
});

describe('routineBodyFromForm', () => {
  it('a schedule sends cron + timezone and the run settings', () => {
    const built = routineBodyFromForm({ ...base(), metadataText: 'team=ops\n\nticket = OPS-1', runClass: 'deferred', version: 3 }, [], null, now);
    expect(built).toEqual({ ok: true, body: expect.objectContaining({
      name: 'Digest', enabled: true, prompt: 'Summarise.', version: 3, class: 'deferred', metadata: { team: 'ops', ticket: 'OPS-1' },
      callback: null, response_format: null, inputs: null, trigger: { type: 'schedule', cron: '0 9 * * 1-5', timezone: 'Europe/Istanbul' },
    }) });
  });

  it('once "in N" sends delay_seconds; once "at" sends run_at and refuses a past time', () => {
    const delay = routineBodyFromForm({ ...base(), triggerType: 'once', onceMode: 'in', delayAmount: 2, delayUnit: 'hours' }, [], null, now);
    expect(delay.ok && delay.body.trigger).toEqual({ type: 'once', delay_seconds: 7200 });
    const at = new Date('2026-10-18T12:00:00Z');
    const later = routineBodyFromForm({ ...base(), triggerType: 'once', onceMode: 'at', runAtLocal: toLocalInputValue(at) }, [], null, now);
    expect(later.ok && later.body.trigger).toEqual({ type: 'once', run_at: at.toISOString() });
    const past = routineBodyFromForm({ ...base(), triggerType: 'once', onceMode: 'at', runAtLocal: toLocalInputValue(new Date('2026-10-18T08:00:00Z')) }, [], null, now);
    expect(past).toEqual({ ok: false, problem: { field: 'runAtLocal', key: 'oncePast' } });
  });

  it('manual sends only the type', () => {
    const built = routineBodyFromForm({ ...base(), triggerType: 'manual' }, [], null, now);
    expect(built.ok && built.body.trigger).toEqual({ type: 'manual' });
  });

  it('refuses a missing name, a bad cron, bad metadata lines and bad JSON before sending', () => {
    expect(routineBodyFromForm({ ...base(), name: ' ' }, [], null, now)).toMatchObject({ ok: false, problem: { field: 'name' } });
    expect(routineBodyFromForm({ ...base(), cron: '0 0 9 * * *' }, [], null, now)).toMatchObject({ ok: false, problem: { field: 'cron' } });
    expect(routineBodyFromForm({ ...base(), metadataText: 'no equals sign' }, [], null, now)).toMatchObject({ ok: false, problem: { field: 'metadataText' } });
    expect(routineBodyFromForm({ ...base(), responseFormatText: '{oops' }, [], null, now)).toMatchObject({ ok: false, problem: { field: 'responseFormatText' } });
  });

  it('sends only the inputs the agent declares that were given', () => {
    const declared = [{ name: 'region', type: 'string' as const }, { name: 'days', type: 'integer' as const }];
    const built = routineBodyFromForm({ ...base(), inputs: { region: 'eu', days: undefined, stale: 'x' } }, declared, null, now);
    expect(built.ok && built.body.inputs).toEqual({ region: 'eu' });
  });

  it('the callback secret is sent only when one was typed', () => {
    const kept = routineBodyFromForm({ ...base(), callbackUrl: 'https://example.com/hook', callbackSigned: true }, [], null, now);
    expect(kept.ok && kept.body.callback).toEqual({ url: 'https://example.com/hook' });
    const replaced = routineBodyFromForm({ ...base(), callbackUrl: 'https://example.com/hook', callbackSecret: 'a-new-secret-12345' }, [], null, now);
    expect(replaced.ok && replaced.body.callback).toEqual({ url: 'https://example.com/hook', secret: 'a-new-secret-12345' });
  });

  it('editing a once routine whose time already passed, without touching it, leaves the trigger out', () => {
    const row = stored({ trigger: { type: 'once', run_at: '2026-10-01T06:00:00.000Z' } });
    const built = routineBodyFromForm({ ...formFromRoutine(row, 'UTC'), name: 'Renamed' }, [], row, now);
    expect(built.ok).toBe(true);
    expect(built.ok && 'trigger' in built.body).toBe(false);
  });
});

describe('formFromRoutine', () => {
  it('fills the form from a stored routine (never a secret)', () => {
    const form = formFromRoutine(stored(), 'UTC');
    expect(form).toMatchObject({
      name: 'Digest', triggerType: 'schedule', cron: '0 9 * * 1-5', timezone: 'Europe/Istanbul', inputs: { region: 'eu' },
      version: 2, runClass: 'deferred', metadataText: 'team=ops', callbackUrl: 'https://example.com/hook', callbackSigned: true, callbackSecret: '',
    });
    expect(JSON.parse(form.responseFormatText)).toEqual({ type: 'json_object' });
  });

  it('an unknown trigger type opens as manual', () => {
    expect(formFromRoutine(stored({ trigger: { type: 'something-new' } }), 'UTC').triggerType).toBe('manual');
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

  it('the routines editor has every string in English and Turkish, with the same placeholders', () => {
    const en = at(messages.en, 'agents.routines');
    const tr = at(messages.tr, 'agents.routines');
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) expect(placeholders(String(tr[key])), key).toEqual(placeholders(String(en[key])));
  });

  it('the routine delete confirm has its noun and warning in both languages', () => {
    for (const locale of ['en', 'tr'] as const) {
      expect(typeof at(messages[locale], 'common.confirm.nouns').agentRoutine).toBe('string');
      expect(typeof at(messages[locale], 'common.confirm.extras').agentRoutineStops).toBe('string');
    }
  });
});
