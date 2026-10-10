/**
 * The audit sentence in the reader's language: the server sends each row's sentence as
 * data next to its English text; the tab turns the data into a sentence with the
 * `iamAudit.summaries.*` templates, and falls back to the English text for anything it
 * does not know.
 */
import { describe, expect, it } from 'vitest';
import { formatAuditText } from '@/components/iam/audit/summaryText';
import { messages } from '@/lib/i18n/messages';

type Dict = Record<string, unknown>;
const lookup = (locale: 'en' | 'tr', fullKey: string): string | undefined => {
  let current: unknown = (messages as Record<string, Dict>)[locale];
  for (const part of fullKey.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Dict)[part];
  }
  return typeof current === 'string' ? current : undefined;
};
const translator = (locale: 'en' | 'tr', namespace: string) => (key: string, values?: Record<string, string | number | undefined | null>) => {
  const fullKey = `${namespace}.${key}`;
  const template = lookup(locale, fullKey) ?? (locale !== 'en' ? lookup('en', fullKey) : undefined) ?? fullKey;
  return template.replace(/\{(\w+)\}/g, (match, name) => (values?.[name] === undefined || values?.[name] === null ? match : String(values[name])));
};
const sentence = (locale: 'en' | 'tr', item: Parameters<typeof formatAuditText>[0]) =>
  formatAuditText(item, translator(locale, 'iamAudit'), translator(locale, 'iamCenter'));

const item = (key: string, params: Record<string, string | number>, summary = 'ENGLISH') => ({ summary, text: { key, params } });

describe('formatAuditText', () => {
  it('falls back to the English sentence when there is no data or the key is unknown', () => {
    expect(sentence('tr', { summary: 'English only', text: null })).toBe('English only');
    expect(sentence('tr', item('something.new', { a: 1 }, 'From a newer server'))).toBe('From a newer server');
  });

  it('denials: the reason, the route, the service and the level', () => {
    expect(sentence('en', item('denied.policy', { route: 'POST /api/agents', service: 'agents', required: 'write', policies: 'Freeze' })))
      .toBe('Denied POST /api/agents: agents needs write by policy "Freeze"');
    expect(sentence('tr', item('denied.policy', { route: 'POST /api/agents', service: 'agents', required: 'write', policies: 'Freeze' })))
      .toBe('Reddedildi POST /api/agents: agents için "Freeze" politikası nedeniyle write izni gerekiyor');
    expect(sentence('tr', item('denied.tokenScope', { route: 'GET /api/x', service: 'models', required: 'read', policies: '' }))).toMatch(/token kapsamı/);
    expect(sentence('tr', item('denied.project', { route: 'GET /api/x', service: 'models', required: 'read', policies: '' }))).toMatch(/proje izinleri/);
    expect(sentence('tr', item('denied.noRule', { route: 'GET /api/x', service: 'models', required: 'read', policies: '' }))).toMatch(/hiçbir kural/);
    // no level known: the variant without it
    expect(sentence('en', item('denied.noRule', { route: 'GET /api/x', service: 'models', required: '', policies: '' })))
      .toBe('Denied GET /api/x: models because no rule allows it');
  });

  it('blocked rows', () => {
    expect(sentence('tr', item('undeclared', { route: 'GET /api/zz' }))).toBe('Engellendi: GET /api/zz için yetki tanımı yok');
    // The engine could not decide (HTTP 503): said as such, not as a denial by a rule.
    expect(sentence('en', item('unavailable', { route: 'GET /api/models' }))).toBe('Refused GET /api/models: authorization was temporarily unavailable');
    expect(sentence('tr', item('unavailable', { route: 'GET /api/models' }))).toBe('GET /api/models reddedildi: yetkilendirme geçici olarak kullanılamıyordu');
    expect(sentence('en', item('ipNotAllowedAt', { who: 'ci-token', ip: '198.51.100.7', route: 'GET /api/models' })))
      .toBe('Blocked: ci-token is not allowed from 198.51.100.7 (IP allowlist): GET /api/models');
    expect(sentence('tr', item('ipNotAllowed', { who: 'ci-token', ip: '198.51.100.7', route: '' }))).toBe('Engellendi: ci-token, 198.51.100.7 adresinden kullanılamaz (IP izin listesi)');
  });

  it('policy changes, with the effect in the reader\'s words and a note when switched off', () => {
    expect(sentence('en', item('policy.created', { name: 'Freeze', effect: 'forbid', enabled: 1 }))).toBe('Created policy "Freeze" (Deny)');
    expect(sentence('tr', item('policy.updated', { name: 'Freeze', effect: 'forbid', enabled: 0 }))).toBe('"Freeze" politikası güncellendi (Engelle, kapalı)');
    expect(sentence('tr', item('policy.deleted', { name: 'Freeze', effect: '', enabled: 1 }))).toBe('"Freeze" politikası silindi');
    // A row written before the monitor mode was removed still carries its `mode`: it is simply not said.
    expect(sentence('en', item('policy.created', { name: 'Old', effect: 'permit', mode: 'monitor', enabled: 1 }))).toBe('Created policy "Old" (Allow)');
  });

  it('rows of the removed mode and monitor views fall back to the English sentence', () => {
    expect(sentence('en', item('mode.changed', { from: 'shadow', to: 'enforce' }, 'Changed the authorization mode from shadow to enforce'))).toBe('Changed the authorization mode from shadow to enforce');
    expect(sentence('en', item('monitor.would', { name: 'Watch', would: 'deny' }, 'Policy "Watch" would deny'))).toBe('Policy "Watch" would deny');
  });

  it('settings and token restrictions list only what changed', () => {
    expect(sentence('en', item('settings.updated', { lifetimeSet: 1, lifetimeDays: 90, expirySet: 1, expiryRequired: 1 })))
      .toBe('Changed IAM settings: token max lifetime 90 days, token expiry required');
    expect(sentence('en', item('settings.updated', { lifetimeSet: 1, lifetimeDays: 0, expirySet: 0, expiryRequired: 0 })))
      .toBe('Changed IAM settings: token max lifetime unlimited');
    expect(sentence('tr', item('settings.updated', { lifetimeSet: 0, lifetimeDays: 0, expirySet: 0, expiryRequired: 0 }))).toBe('IAM ayarları değiştirildi');
    expect(sentence('en', item('token.restrictions', { label: 'ci', expiryChanged: 1, expiryFrom: '', expiryTo: '2027-01-01', ipChanged: 1, ipFrom: 0, ipTo: 2 })))
      .toBe('Changed the restrictions of token "ci" (expiry - -> 2027-01-01, IP allowlist 0 -> 2 ranges)');
    expect(sentence('en', item('token.restrictions', { label: 'ci', expiryChanged: 0, expiryFrom: '', expiryTo: '', ipChanged: 0, ipFrom: 0, ipTo: 0 })))
      .toBe('Changed the restrictions of token "ci"');
  });

  it('every template the formatter can reach exists in both languages', () => {
    const keys = [
      'disabledFlag', 'undeclared', 'unavailable', 'ipNotAllowed', 'ipNotAllowedAt',
      ...['policy', 'tokenScope', 'project', 'noRule'].flatMap((r) => [`denied.${r}`, `denied.${r}NoLevel`]),
      'policy.created', 'policy.updated', 'policy.deleted',
      'settings.updated', 'settings.lifetimeDays', 'settings.lifetimeUnlimited', 'settings.expiryRequired', 'settings.expiryOptional',
      'token.restrictions', 'tokenRestrictions.expiry', 'tokenRestrictions.ip',
    ];
    for (const locale of ['en', 'tr'] as const) {
      for (const key of keys) expect(lookup(locale, `iamAudit.summaries.${key}`), `${locale} ${key}`).toBeTruthy();
    }
  });
});
