/**
 * The sentence of an audit row in the reader's language.
 *
 * The server sends every row's sentence twice: as English text (`summary`) and as
 * data (`text`: a key and its values). This turns the data into a sentence with the
 * `iamAudit.summaries.*` templates; a key it does not know (a newer server) falls
 * back to the English text. Pure, so it is tested without React.
 */

import type { AuditItem } from './client';

export type Translate = (key: string, values?: Record<string, string | number | undefined | null>) => string;

/** A key that resolved to nothing comes back as the key itself (see useTranslations). */
function resolved(t: Translate, namespace: string, key: string, values?: Record<string, string | number>): string | null {
  const text = t(key, values);
  return text === `${namespace}.${key}` || text === key ? null : text;
}

export function formatAuditText(
  item: Pick<AuditItem, 'summary' | 'text'>,
  t: Translate,
  /** Translator of the `iamCenter` namespace (effect and mode words). */
  tCenter: Translate,
): string {
  const text = item.text;
  if (!text) return item.summary;
  const p = text.params;
  const str = (name: string) => String(p[name] ?? '');
  const num = (name: string) => Number(p[name] ?? 0);
  /** An effect / mode word in the reader's language (`iamCenter.effects.forbid`...), or the raw value. */
  const word = (group: string, value: string) => (value ? (resolved(tCenter, 'iamCenter', `${group}.${value}`) ?? value) : '');
  const say = (key: string, values: Record<string, string | number> = p): string | null => resolved(t, 'iamAudit', `summaries.${key}`, values);

  let out: string | null = null;
  switch (text.key) {
    case 'policy.created':
    case 'policy.updated':
    case 'policy.deleted': {
      const base = say(text.key, { name: str('name') });
      if (base && text.key !== 'policy.deleted') {
        const flags = [word('effects', str('effect')), word('modes', str('mode')), num('enabled') === 0 ? say('disabledFlag', {}) : '']
          .filter(Boolean).join(', ');
        out = flags ? `${base} (${flags})` : base;
      } else {
        out = base;
      }
      break;
    }
    case 'mode.changed':
      out = say('mode.changed', { from: word('authzModes', str('from')), to: word('authzModes', str('to')) });
      break;
    case 'settings.updated': {
      const parts: string[] = [];
      if (num('lifetimeSet')) {
        parts.push(say(num('lifetimeDays') > 0 ? 'settings.lifetimeDays' : 'settings.lifetimeUnlimited', { days: num('lifetimeDays') }) ?? '');
      }
      if (num('expirySet')) parts.push(say(num('expiryRequired') ? 'settings.expiryRequired' : 'settings.expiryOptional', {}) ?? '');
      const base = say('settings.updated', {});
      out = base ? (parts.filter(Boolean).length > 0 ? `${base}: ${parts.filter(Boolean).join(', ')}` : base) : null;
      break;
    }
    case 'token.restrictions': {
      const parts: string[] = [];
      if (num('expiryChanged')) parts.push(say('tokenRestrictions.expiry', { from: str('expiryFrom') || '-', to: str('expiryTo') || '-' }) ?? '');
      if (num('ipChanged')) parts.push(say('tokenRestrictions.ip', { from: num('ipFrom'), to: num('ipTo') }) ?? '');
      const base = say('token.restrictions', { label: str('label') });
      out = base ? (parts.filter(Boolean).length > 0 ? `${base} (${parts.filter(Boolean).join(', ')})` : base) : null;
      break;
    }
    case 'monitor.would': {
      out = say(str('would') === 'allow' ? 'monitor.wouldAllow' : 'monitor.wouldDeny', {
        name: str('name'), route: str('route'), count: num('count'), since: str('since'),
      });
      break;
    }
    case 'denied.policy':
    case 'denied.tokenScope':
    case 'denied.project':
    case 'denied.noRule': {
      out = say(p.required ? text.key : `${text.key}NoLevel`, {
        route: str('route'), service: str('service'), required: str('required'), policies: str('policies'),
      });
      break;
    }
    default:
      out = say(text.key, Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v])));
  }
  return out && out.trim() ? out : item.summary;
}
