/**
 * Unit tests - the matching kernel of the access views (access/audience.ts)
 *
 * The kernel is the part of "which directory users is this console person" that needs no I/O: what a rule asks of a
 * directory, which rule wins, which keys a match adds, how links apply, and the same question asked the other way
 * round (who holds a key, which people a directory user is tied to, what a list of rules would match). It is pure,
 * so every case here is plain data. That the search-time engine and the kernel agree for a whole workspace is
 * rag-access-audience-parity.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { IRagIdentityLink, IRagIdentityUser, IRagIdentityUserMatchRule } from '@/lib/database';
import {
  MAX_DIRECTORY_MATCHES,
  consoleKeysOf,
  domainKeysOf,
  firstRuleHit,
  groupExternalIdsOf,
  holdersByKey,
  indexDirectoryMatches,
  matchablePersonOf,
  memoryFinder,
  previewUserMatch,
  ruleQueryOf,
  type DomainRules,
  type MatchablePerson,
} from '@/lib/services/rag/access/audience';

const TENANT = 'tenant-1';

const row = (extId: string, extra: Partial<IRagIdentityUser> = {}): IRagIdentityUser => ({
  tenantId: TENANT,
  domain: 'corp',
  extId,
  ...extra,
});

const link = (
  externalKind: 'user' | 'group',
  externalId: string,
  consoleKind: 'user' | 'group',
  consoleId: string,
  extra: Partial<IRagIdentityLink> = {},
): IRagIdentityLink => ({
  _id: `link-${consoleKind}-${consoleId}-${externalKind}-${externalId}`,
  tenantId: TENANT,
  domain: 'corp',
  externalKind,
  externalId,
  consoleKind,
  consoleId,
  ...extra,
});

const person = (userId: string, extra: Partial<MatchablePerson> = {}): MatchablePerson => ({
  userId,
  active: true,
  hostApp: false,
  groupIds: [],
  groupExternalIds: [],
  ...extra,
});

const EMAIL_EMAIL: IRagIdentityUserMatchRule = { console: 'email', external: 'email' };
const EMAIL_UPN: IRagIdentityUserMatchRule = { console: 'email', external: 'upn' };
const ID_ID: IRagIdentityUserMatchRule = { console: 'externalId', external: 'id' };
const EMAIL_ALIAS: IRagIdentityUserMatchRule = { console: 'email', external: 'attr:mailAlias' };

describe('memoryFinder', () => {
  it('compares e-mail, UPN and attributes folded on both sides, and ids as they are', () => {
    const find = memoryFinder([
      row('u1', { email: ' Ada@Corp.Example ', upn: 'ADA@corp.onmicrosoft.example' }),
      row('E-1', { attrs: { mailAlias: ' Dave@Example.COM' } }),
    ]);
    expect(find('email', ['ADA@corp.example']).map((u) => u.extId)).toEqual(['u1']);
    expect(find('upn', [' ada@CORP.onmicrosoft.example ']).map((u) => u.extId)).toEqual(['u1']);
    expect(find('attr:mailAlias', ['dave@example.com']).map((u) => u.extId)).toEqual(['E-1']);
    expect(find('extId', ['E-1']).map((u) => u.extId)).toEqual(['E-1']);
    expect(find('extId', ['e-1'])).toEqual([]);
  });

  it('finds nothing for no values, an unknown field or an attribute name no store can look up', () => {
    const find = memoryFinder([row('u1', { email: 'ada@corp.example', attrs: { mailAlias: 'x@example.com' } })]);
    expect(find('email', [])).toEqual([]);
    expect(find('email', ['   '])).toEqual([]);
    expect(find('displayName' as never, ['Ada'])).toEqual([]);
    expect(find('attr:bad name!', ['x@example.com'])).toEqual([]);
    expect(find('attr:', ['x@example.com'])).toEqual([]);
  });

  it('keeps one row per id (the last one given) and answers in the order the stores do: byte order of the id', () => {
    const find = memoryFinder([
      row('b', { email: 'shared@corp.example' }),
      row('Z', { email: 'shared@corp.example' }),
      row('a', { email: 'shared@corp.example' }),
      row('a', { email: 'shared@corp.example', name: 'second a' }),
      // U+FF21 sorts after U+1F600 in UTF-16 code units but before it by code point, which is what the stores compare.
      row('\u{1F600}', { email: 'shared@corp.example' }),
      row('Ａ', { email: 'shared@corp.example' }),
    ]);
    const found = find('email', ['shared@corp.example']);
    expect(found.map((u) => u.extId)).toEqual(['Z', 'a', 'b', 'Ａ', '\u{1F600}']);
    expect(found.find((u) => u.extId === 'a')?.name).toBe('second a');
  });

  it('answers each lookup from the rows alone: a user matches on whichever field is asked', () => {
    const find = memoryFinder([row('u1', { email: 'ada@corp.example', upn: 'ada-upn@corp.example' })]);
    expect(find('email', ['ada-upn@corp.example'])).toEqual([]);
    expect(find('upn', ['ada-upn@corp.example']).map((u) => u.extId)).toEqual(['u1']);
  });
});

describe('the person', () => {
  it('is active unless disabled, keeps the stored address, the SSO anchor and the groups', () => {
    const p = matchablePersonOf(
      { _id: 'u1', email: 'Ada@Example.com', emailLower: 'ada@example.com', externalId: '  E-1 ', kind: undefined, status: undefined },
      [{ _id: 'g1', externalId: ' cn=finance ' }, { _id: 'g2' }, { _id: 'g1', externalId: 'cn=finance' }, { _id: 'g3', externalId: '   ' }],
    );
    expect(p).toEqual({
      userId: 'u1',
      active: true,
      hostApp: false,
      email: 'ada@example.com',
      externalId: 'E-1',
      groupIds: ['g1', 'g2', 'g3'],
      groupExternalIds: ['cn=finance'],
    });
  });

  it('is inactive when disabled, and an account of a host application has no address and is marked as such', () => {
    const disabled = matchablePersonOf({ _id: 'u2', email: 'b@example.com', status: 'disabled' } as never, []);
    expect(disabled.active).toBe(false);
    const host = matchablePersonOf({ _id: 'u3', email: 'victim@corp.example', externalId: 'E-9', kind: 'external' } as never, [{ _id: 'g1' }]);
    expect(host).toMatchObject({ userId: 'u3', active: true, hostApp: true, externalId: 'E-9', groupIds: ['g1'] });
    expect(host.email).toBeUndefined();
  });

  it('ignores an address that is none and a blank SSO id', () => {
    const p = matchablePersonOf({ _id: 'u4', email: 'not-an-address', externalId: '   ' } as never, []);
    expect(p.email).toBeUndefined();
    expect(p.externalId).toBeUndefined();
  });

  it('lists the console keys in the order the engine adds them, and only "everyone" for a disabled account', () => {
    const p = person('u1', { email: 'ada@example.com', groupIds: ['g1', 'g2'] });
    expect(consoleKeysOf(p)).toEqual(['everyone', 'user:u1', 'email:ada@example.com', 'group:g1', 'group:g2']);
    expect(consoleKeysOf(person('u2', { groupIds: ['g1'] }))).toEqual(['everyone', 'user:u2', 'group:g1']);
    expect(consoleKeysOf(person('u3', { active: false, email: 'x@example.com', groupIds: ['g1'] }))).toEqual(['everyone']);
  });

  it('collects the distinct external ids of groups', () => {
    expect(groupExternalIdsOf([{ externalId: 'a' }, { externalId: ' a ' }, { externalId: '' }, {}, { externalId: 'b' }])).toEqual(['a', 'b']);
  });
});

describe('what a rule asks', () => {
  it('compares the stored address folded, and the SSO id as it is', () => {
    expect(ruleQueryOf(person('u1', { email: 'ada@example.com' }), EMAIL_EMAIL)).toEqual({ field: 'email', values: ['ada@example.com'] });
    expect(ruleQueryOf(person('u1', { email: 'ada@example.com' }), EMAIL_ALIAS)).toEqual({ field: 'attr:mailAlias', values: ['ada@example.com'] });
    expect(ruleQueryOf(person('u1', { externalId: 'E-Mixed' }), ID_ID)).toEqual({ field: 'extId', values: ['E-Mixed'] });
  });

  it('asks nothing when the person has no value for the side, or the rule names no field', () => {
    expect(ruleQueryOf(person('u1'), EMAIL_EMAIL)).toBeNull();
    expect(ruleQueryOf(person('u1', { email: 'ada@example.com' }), ID_ID)).toBeNull();
    expect(ruleQueryOf(person('u1', { email: 'ada@example.com' }), { console: 'email', external: 'attr:' as never })).toBeNull();
    expect(ruleQueryOf(person('u1', { email: 'ada@example.com' }), { console: 'email', external: 'phone' as never })).toBeNull();
  });
});

describe('the first rule that finds directory users decides', () => {
  const users = [
    row('u1', { email: 'ada@example.com', upn: 'ada@corp.onmicrosoft.example' }),
    row('u2', { upn: 'ada@example.com' }),
    row('E-1', { email: 'robert@corp.example' }),
  ];
  const find = memoryFinder(users);

  it('stops at the first rule with a hit; later rules are not looked at', () => {
    const hit = firstRuleHit(person('p', { email: 'ada@example.com' }), [EMAIL_EMAIL, EMAIL_UPN], find);
    expect(hit?.ruleIndex).toBe(0);
    expect(hit?.users.map((u) => u.extId)).toEqual(['u1']);
    const second = firstRuleHit(person('p', { email: 'ada@example.com' }), [EMAIL_UPN, EMAIL_EMAIL], find);
    expect(second?.ruleIndex).toBe(0);
    expect(second?.users.map((u) => u.extId)).toEqual(['u2']);
  });

  it('skips a rule the person has no value for, and one that finds nobody', () => {
    const hit = firstRuleHit(person('p', { email: 'ada@example.com', externalId: 'E-1' }), [ID_ID, EMAIL_ALIAS, EMAIL_EMAIL], find);
    expect(hit?.ruleIndex).toBe(0);
    const viaThird = firstRuleHit(person('p', { email: 'ada@example.com' }), [ID_ID, EMAIL_ALIAS, EMAIL_EMAIL], find);
    expect(viaThird?.ruleIndex).toBe(2);
    expect(firstRuleHit(person('p', { email: 'nobody@example.com' }), [EMAIL_EMAIL, EMAIL_UPN], find)).toBeNull();
  });

  it('matches nobody who is disabled or an account of a host application', () => {
    expect(firstRuleHit(person('p', { email: 'ada@example.com', active: false }), [EMAIL_EMAIL], find)).toBeNull();
    expect(firstRuleHit(person('p', { email: 'ada@example.com', hostApp: true }), [EMAIL_EMAIL], find)).toBeNull();
  });

  it(`keeps at most ${MAX_DIRECTORY_MATCHES} directory users for one person, the first ones by id`, () => {
    const crowd = Array.from({ length: 13 }, (_, i) => row(`m${String(i).padStart(2, '0')}`, { email: 'team@corp.example' }));
    const hit = firstRuleHit(person('p', { email: 'team@corp.example' }), [EMAIL_EMAIL], memoryFinder(crowd));
    expect(hit?.users).toHaveLength(MAX_DIRECTORY_MATCHES);
    expect(hit?.users.map((u) => u.extId)).toEqual(crowd.slice(0, MAX_DIRECTORY_MATCHES).map((u) => u.extId));
  });
});

describe('the keys one directory gives a person', () => {
  const ada = person('ada', { email: 'ada@example.com', externalId: 'E-ada', groupIds: ['g-fin'], groupExternalIds: ['cn=finance'] });
  const directory = [
    row('u-ada', { email: 'ada@example.com', groups: ['fin-readers', 'ops'] }),
    row('u-guest', { email: 'guest@example.com', type: 'guest', groups: ['partners'] }),
    row('u-linked', { email: 'linked@corp.example', groups: ['linked-g'] }),
  ];
  const find = memoryFinder(directory);
  const domain = (extra: Partial<DomainRules> = {}): DomainRules => ({
    key: 'corp',
    rules: [EMAIL_EMAIL],
    matchGroupsByExternalId: true,
    links: [],
    ...extra,
  });
  const sorted = (keys: string[]) => [...keys].sort();

  it('adds the user, its groups and the domain-wide key for a member', () => {
    const { keys, matches } = domainKeysOf(ada, domain({ matchGroupsByExternalId: false }), find);
    expect(sorted(keys)).toEqual(['x:corp:all', 'x:corp:g:fin-readers', 'x:corp:g:ops', 'x:corp:u:u-ada']);
    expect(matches).toEqual([{ domain: 'corp', via: 'rule', rule: EMAIL_EMAIL, externalIds: ['u-ada'] }]);
  });

  it('gives a guest its groups and itself, never the domain-wide key', () => {
    const { keys } = domainKeysOf(person('g', { email: 'guest@example.com' }), domain({ matchGroupsByExternalId: false }), find);
    expect(sorted(keys)).toEqual(['x:corp:g:partners', 'x:corp:u:u-guest']);
  });

  it('takes the SSO id as the directory id when an externalId -> id rule exists and no rule found anyone', () => {
    const sso = person('sso', { externalId: 'NOROW-1' });
    const withRule = domainKeysOf(sso, domain({ rules: [EMAIL_EMAIL, ID_ID], matchGroupsByExternalId: false }), find);
    expect(withRule.keys).toEqual(['x:corp:u:NOROW-1']);
    expect(withRule.matches).toEqual([{ domain: 'corp', via: 'external_id', externalIds: ['NOROW-1'] }]);
    expect(domainKeysOf(sso, domain({ rules: [EMAIL_EMAIL], matchGroupsByExternalId: false }), find).keys).toEqual([]);
  });

  it('lets a console group stand for the directory group with its external id, unless the directory turns it off', () => {
    const on = domainKeysOf(ada, domain(), find);
    expect(on.keys).toContain('x:corp:g:cn=finance');
    expect(on.matches).toContainEqual({ domain: 'corp', via: 'group_external_id', externalIds: ['cn=finance'] });
    const off = domainKeysOf(ada, domain({ matchGroupsByExternalId: false }), find);
    expect(off.keys).not.toContain('x:corp:g:cn=finance');
  });

  it('applies the links that reach the person: their own, and those of their console groups', () => {
    const links = [
      link('user', 'u-linked', 'user', 'ada'),
      link('group', 'ops-wide', 'user', 'ada'),
      link('group', 'fin-wide', 'group', 'g-fin'),
      link('group', 'elsewhere', 'group', 'g-other'),
      link('user', 'u-guest', 'user', 'somebody-else'),
    ];
    const { keys, matches } = domainKeysOf(ada, domain({ links, matchGroupsByExternalId: false }), find);
    expect(sorted(keys)).toEqual([
      'x:corp:all',
      'x:corp:g:fin-readers',
      'x:corp:g:fin-wide',
      'x:corp:g:linked-g',
      'x:corp:g:ops',
      'x:corp:g:ops-wide',
      'x:corp:u:u-ada',
      'x:corp:u:u-linked',
    ]);
    expect(matches.filter((m) => m.via === 'link')).toEqual([
      { domain: 'corp', via: 'link', externalIds: ['ops-wide'] },
      { domain: 'corp', via: 'link', externalIds: ['fin-wide'] },
      { domain: 'corp', via: 'link', externalIds: ['u-linked'] },
    ]);
  });

  it('keeps the key of a link to a user the directory does not list, without the groups of that user', () => {
    const { keys } = domainKeysOf(person('p'), domain({ links: [link('user', 'GHOST', 'user', 'p')] }), find);
    expect(keys).toEqual(['x:corp:u:GHOST']);
  });

  it('ignores a console group linked to an external user, and links of another directory', () => {
    const links = [
      link('user', 'u-linked', 'group', 'g-fin'),
      link('group', 'other-dir', 'user', 'ada', { domain: 'elsewhere' }),
    ];
    const { keys } = domainKeysOf(ada, domain({ links, matchGroupsByExternalId: false, rules: [] }), find);
    expect(keys).toEqual([]);
  });

  it('gives a link even where a rule matched: the keys are a union', () => {
    const { keys } = domainKeysOf(ada, domain({ links: [link('group', 'extra', 'user', 'ada')], matchGroupsByExternalId: false }), find);
    expect(keys).toContain('x:corp:u:u-ada');
    expect(keys).toContain('x:corp:g:extra');
  });

  it('gives an account of a host application its groups and links only', () => {
    const host = person('host', { hostApp: true, externalId: 'E-ada', groupIds: ['g-fin'], groupExternalIds: ['cn=finance'] });
    const { keys, matches } = domainKeysOf(
      host,
      domain({ rules: [EMAIL_EMAIL, ID_ID], links: [link('group', 'fin-wide', 'user', 'host')] }),
      memoryFinder([row('E-ada', { email: 'host@example.com', groups: ['fin-readers'] })]),
    );
    expect(sorted(keys)).toEqual(['x:corp:g:cn=finance', 'x:corp:g:fin-wide']);
    expect(matches.map((m) => m.via).sort()).toEqual(['group_external_id', 'link']);
  });

  it('gives nothing to a disabled person or for a key no principal can carry', () => {
    expect(domainKeysOf({ ...ada, active: false }, domain(), find)).toEqual({ keys: [], matches: [] });
    expect(domainKeysOf(ada, domain({ key: 'Not A Key' }), find)).toEqual({ keys: [], matches: [] });
  });
});

describe('who holds a key', () => {
  it('lists the people per key, once each, in the order the people were given', () => {
    const held = new Map<string, string[]>([
      ['p1', ['x:corp:all', 'x:corp:all', 'x:corp:g:a']],
      ['p2', ['x:corp:all']],
      ['p3', []],
    ]);
    const holders = holdersByKey(held);
    expect(holders.get('x:corp:all')).toEqual(['p1', 'p2']);
    expect(holders.get('x:corp:g:a')).toEqual(['p1']);
    expect(holders.has('x:corp:g:none')).toBe(false);
  });
});

describe('which people a directory user is tied to', () => {
  const directory = memoryFinder([
    row('u1', { email: 'ada@example.com' }),
    row('u2', { email: 'bob@example.com', attrs: { mailAlias: 'robert@example.com' } }),
    row('u3', { email: 'carol@example.com' }),
    row('u4', { email: 'dave@example.com' }),
    row('E-9', { email: 'unrelated@corp.example' }),
  ]);
  const people = [
    person('ada', { email: 'ada@example.com' }),
    person('bob', { email: 'bob@example.com' }),
    person('robert', { email: 'robert@example.com', externalId: 'u4' }),
    person('gone', { email: 'carol@example.com', active: false }),
    person('host', { email: 'carol@example.com', hostApp: true }),
    person('lonely', { email: 'lonely@example.com' }),
  ];
  const rules = [EMAIL_EMAIL, EMAIL_ALIAS, ID_ID];

  it('ties users to the people the first matching rule found them for, and nobody who is disabled or a host account', () => {
    const index = indexDirectoryMatches(people, { key: 'corp', rules, links: [] }, directory);
    // carol@example.com belongs to u3, but its only holders are a disabled person and a host-application account.
    expect([...index.keys()].sort()).toEqual(['u1', 'u2']);
    expect(index.get('u1')).toEqual([{ userId: 'ada', via: 'rule', ruleIndex: 0 }]);
    // bob finds u2 by e-mail (rule 0); robert has no e-mail match, so his second rule (the alias) finds it.
    expect(index.get('u2')).toEqual([
      { userId: 'bob', via: 'rule', ruleIndex: 0 },
      { userId: 'robert', via: 'rule', ruleIndex: 1 },
    ]);
  });

  it('records the rule that decided for each person, and several people can share a user', () => {
    const shared = [...people, person('bob-two', { email: 'bob@example.com' })];
    const index = indexDirectoryMatches(shared, { key: 'corp', rules: [EMAIL_ALIAS, EMAIL_EMAIL], links: [] }, directory);
    expect(index.get('u2')).toEqual([
      { userId: 'bob', via: 'rule', ruleIndex: 1 },
      { userId: 'robert', via: 'rule', ruleIndex: 0 },
      { userId: 'bob-two', via: 'rule', ruleIndex: 1 },
    ]);
  });

  it('ties a user to the person a link names, when the directory lists the user and the person is active', () => {
    const links = [
      link('user', 'u3', 'user', 'lonely', { _id: 'link-1' }),
      link('user', 'GHOST', 'user', 'lonely'),
      link('user', 'u4', 'user', 'gone'),
      link('group', 'g1', 'user', 'lonely'),
      link('user', 'u1', 'group', 'some-group'),
    ];
    const index = indexDirectoryMatches(people, { key: 'corp', rules: [EMAIL_EMAIL], links }, directory);
    expect(index.get('u3')).toEqual([{ userId: 'lonely', via: 'link', linkId: 'link-1' }]);
    expect(index.has('GHOST')).toBe(false);
    expect(index.has('u4')).toBe(false);
    // The link to a user another person's rule found adds the link person next to it.
    const both = indexDirectoryMatches(people, { key: 'corp', rules: [EMAIL_EMAIL], links: [link('user', 'u1', 'user', 'lonely', { _id: 'link-2' })] }, directory);
    expect(both.get('u1')).toEqual([
      { userId: 'ada', via: 'rule', ruleIndex: 0 },
      { userId: 'lonely', via: 'link', linkId: 'link-2' },
    ]);
  });

  it('counts a linked account of a host application: a link is the one way such an account reaches a directory user', () => {
    const index = indexDirectoryMatches(people, { key: 'corp', rules: [EMAIL_EMAIL], links: [link('user', 'E-9', 'user', 'host')] }, directory);
    expect(index.get('E-9')).toEqual([{ userId: 'host', via: 'link', linkId: 'link-user-host-user-E-9' }]);
  });
});

describe('what a list of rules would match', () => {
  const directory = memoryFinder([
    row('u1', { email: 'ada@example.com' }),
    row('u2', { upn: 'bob@example.com' }),
    row('u3', { email: 'carol@example.com' }),
    row('u4', { email: 'bob@example.com' }),
    row('u5', { email: 'nobody@example.com' }),
    row('E-ada', { email: 'someone-else@example.com' }),
  ]);
  const people = [
    person('ada', { email: 'ada@example.com' }),
    person('bob', { email: 'bob@example.com', externalId: 'E-ada' }),
    person('carol', { email: 'carol@example.com' }),
    person('off', { email: 'off@example.com', active: false }),
    person('nobody-matches', { email: 'zed@example.com' }),
  ];

  it('counts people and users, and credits each user to the lowest rule that ties a person to it', () => {
    const preview = previewUserMatch([EMAIL_EMAIL, EMAIL_UPN, ID_ID], people, { key: 'corp', links: [] }, directory);
    // ada -> u1 (rule 0), bob -> u4 (rule 0: email), carol -> u3 (rule 0); bob's second rule is not reached.
    expect([...preview.matchedExtIds].sort()).toEqual(['u1', 'u3', 'u4']);
    expect(preview.decidedByRule).toEqual([3, 0, 0]);
    expect(preview.matchedPeople).toBe(3);
    expect(preview.considered).toBe(4);
  });

  it('credits a user to the lowest rule that ties any person to it', () => {
    const shared = memoryFinder([
      row('s1', { email: 'shared@example.com', upn: 'shared-upn@example.com' }),
      row('s2', { email: 'solo@example.com' }),
    ]);
    const holders = [
      // Finds s1 by e-mail, which is the second rule here.
      person('by-email', { email: 'shared@example.com' }),
      // Finds s1 by UPN, the first rule.
      person('by-upn', { email: 'shared-upn@example.com' }),
      person('solo', { email: 'solo@example.com' }),
    ];
    const preview = previewUserMatch([EMAIL_UPN, EMAIL_EMAIL], holders, { key: 'corp', links: [] }, shared);
    expect(preview.byDirectoryUser.get('s1')?.map((m) => `${m.userId}:${m.ruleIndex}`)).toEqual(['by-email:1', 'by-upn:0']);
    // s1 is rule 0's (its lowest); s2 only rule 1 finds. The counts never add up to more than the users matched.
    expect(preview.decidedByRule).toEqual([1, 1]);
    expect(preview.matchedExtIds.size).toBe(2);
    expect(preview.matchedPeople).toBe(3);
  });

  it('leaves a user that only a link ties to a person in no rule', () => {
    const links = [link('user', 'u5', 'user', 'nobody-matches', { _id: 'l1' })];
    const preview = previewUserMatch([EMAIL_EMAIL], people, { key: 'corp', links }, directory);
    expect(preview.matchedExtIds.has('u5')).toBe(true);
    expect(preview.decidedByRule).toEqual([3]);
    expect(preview.matchedPeople).toBe(4);
  });

  it('matches nothing for no rules and no links', () => {
    const preview = previewUserMatch([], people, { key: 'corp', links: [] }, directory);
    expect(preview.matchedExtIds.size).toBe(0);
    expect(preview.decidedByRule).toEqual([]);
    expect(preview.matchedPeople).toBe(0);
    expect(preview.considered).toBe(4);
  });
});
