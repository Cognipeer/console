/**
 * Messages carry no plural rules, so a count that can be one has a `<key>One` sibling (picked by pluralKey) in both
 * languages. The English one must not carry a plural noun; the Turkish pair may read the same.
 */
import { describe, expect, it } from 'vitest';
import { pluralKey } from '@/components/alerts/plural';
import { messages } from '@/lib/i18n/messages';

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, key: string): string | undefined {
  let current: string | Tree | undefined = tree;
  for (const segment of key.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = current[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

/** The messages whose call sites go through pluralKey(): keep in step with them. */
const PLURALISED: Array<['alerts' | 'incidents', string[]]> = [
  [
    'alerts',
    [
      'target.pickerRequests',
      'rowValue.absenceValue',
      'rulesUx.noiseTitle',
      'rulesUx.backtest.summary',
      'rulesUx.backtest.entityFires',
      'rulesUx.backtest.suggestion',
      'libraryUx.usedByCount',
      'libraryUx.editImpact',
      'showingRules',
    ],
  ],
  [
    'incidents',
    [
      'bulk.done',
      'bulk.donePartial',
      'bulk.confirm.resolve.title',
      'bulk.confirm.resolve.message',
      'bulk.confirm.close.title',
      'bulk.confirm.close.message',
      'failingSessionsLink',
      'failingSessionsCount',
      'ux.groups.count',
      'ux.groups.entities',
      'ux.bulk.reopenTitle',
      'ux.bulk.reopenMessage',
      'ux.assign.title',
    ],
  ],
];

const PLURAL_NOUN = /\b(rules|incidents|entities|times|sessions|requests)\b/i;

describe('pluralKey', () => {
  it('picks the singular sibling for exactly one', () => {
    expect(pluralKey('libraryUx.usedByCount', 1)).toBe('libraryUx.usedByCountOne');
    for (const count of [0, 2, 10, 1.5]) expect(pluralKey('libraryUx.usedByCount', count)).toBe('libraryUx.usedByCount');
  });
});

for (const [namespace, keys] of PLURALISED) {
  describe(`${namespace} messages with a singular form`, () => {
    for (const key of keys) {
      it(`${key} has ${key}One in English and Turkish`, () => {
        for (const locale of ['en', 'tr'] as const) {
          const tree = (messages[locale] as unknown as Record<string, Tree>)[namespace]!;
          expect(lookup(tree, key), `${locale} ${namespace}.${key}`).toBeTypeOf('string');
          expect(lookup(tree, `${key}One`), `${locale} ${namespace}.${key}One`).toBeTypeOf('string');
        }
        const en = (messages.en as unknown as Record<string, Tree>)[namespace]!;
        expect(lookup(en, `${key}One`)).not.toMatch(PLURAL_NOUN);
      });
    }
  });
}

describe('no "(s)" hedging is left in the alerts messages', () => {
  for (const namespace of ['alerts', 'incidents'] as const) {
    it(namespace, () => {
      // "http(s)" is a scheme, not a plural
      expect(JSON.stringify((messages.en as unknown as Record<string, Tree>)[namespace])).not.toMatch(/(?<!\bhttp)\(s\)/);
    });
  }
});
