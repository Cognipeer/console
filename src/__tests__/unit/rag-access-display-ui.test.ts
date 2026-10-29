/**
 * The wording of the access screens as plain functions: what a principal key is called, what its row says about who
 * it reaches, how a matching rule is described, and the small sentences that depend on a count. No DOM, no fetch.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_MATCH } from '@/lib/services/rag/access/identity';
import {
  DEFAULT_MATCH_RULES,
  MAX_ENTRIES,
  administersText,
  consolePeopleText,
  countOf,
  decidedByText,
  describeMatch,
  effectiveRules,
  emailEntry,
  emptyListSentence,
  entryDetail,
  entryInput,
  entryPhrase,
  entryTitle,
  externalSideText,
  folderPathText,
  formatCount,
  inheritedSentence,
  keepsPermissionsText,
  kindOf,
  listSentence,
  nodeSubtitle,
  peopleText,
  ruleNumber,
  ruleText,
  sameEntries,
  startingEntries,
} from '@/components/rag/access/principalDisplay';
import type { RagAccessAudienceItem, RagNodeAclView } from '@/components/rag/access/ragAccessApi';

const audience = (over: Partial<RagAccessAudienceItem> & Pick<RagAccessAudienceItem, 'kind'>): RagAccessAudienceItem => ({
  exists: true,
  people: null,
  ...over,
});

describe('counts and lists', () => {
  it('writes numbers the English way and picks singular and plural', () => {
    expect(formatCount(1240)).toBe('1,240');
    expect(countOf(1, 'folder')).toBe('1 folder');
    expect(countOf(3, 'folder')).toBe('3 folders');
    expect(countOf(2, 'entry', 'entries')).toBe('2 entries');
    expect(peopleText(1)).toBe('1 person');
    expect(peopleText(24)).toBe('24 people');
    expect(consolePeopleText(0)).toBe('no console person yet');
    expect(consolePeopleText(1)).toBe('1 console person');
    expect(consolePeopleText(14)).toBe('14 console people');
  });

  it('joins names the way a sentence does, and cuts a long list', () => {
    expect(listSentence([])).toBe('');
    expect(listSentence(['A'])).toBe('A');
    expect(listSentence(['A', 'B'])).toBe('A and B');
    expect(listSentence(['A', 'B', 'C'])).toBe('A, B and C');
    expect(listSentence(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more');
    expect(listSentence(['A', 'B', 'C', 'D'], 5)).toBe('A, B, C and D');
  });

  it('says what a connector directory keeps', () => {
    expect(keepsPermissionsText(23, 0)).toBe('23 documents keep their source permissions');
    expect(keepsPermissionsText(1, 0)).toBe('1 document keeps its source permissions');
    expect(keepsPermissionsText(0, 1)).toBe('1 folder keeps its source permissions');
    expect(keepsPermissionsText(23, 2)).toBe('23 documents and 2 folders keep their source permissions');
  });

  it('prints a folder path with spaces around the slashes', () => {
    expect(folderPathText('Policies/Leave')).toBe('Policies / Leave');
    expect(folderPathText('Policies')).toBe('Policies');
  });
});

describe('the name of an entry', () => {
  it('prefers the live name, then the label stored with the entry, then the key', () => {
    expect(entryTitle('user:u1', 'Stored name', audience({ kind: 'user', label: 'Live name' }))).toBe('Live name');
    expect(entryTitle('user:u1', 'Stored name', audience({ kind: 'user' }))).toBe('Stored name');
    expect(entryTitle('user:u1', 'Stored name')).toBe('Stored name');
    expect(entryTitle('user:u1')).toBe('user:u1');
  });

  it('knows what to call a key that carries no name', () => {
    expect(entryTitle('everyone')).toBe('Everyone who can open this knowledge engine');
    expect(entryTitle('email:Legal@Example.com')).toBe('legal@example.com');
    expect(entryTitle('x:sp:all')).toBe('All members');
    expect(entryTitle('x:sp:g:grp-1')).toBe('grp-1');
  });

  it('tells the kind of a key', () => {
    expect(kindOf('everyone')).toBe('everyone');
    expect(kindOf('group:g1')).toBe('group');
    expect(kindOf('x:sp:u:42')).toBe('external_user');
    expect(kindOf('nonsense')).toBeNull();
  });
});

describe('the second line of an entry', () => {
  it('says who a person, group, token and address reach', () => {
    expect(entryDetail('user:u1', audience({ kind: 'user', detail: 'ada@example.com', people: 1 })).text).toBe('Person · ada@example.com');
    expect(entryDetail('group:g1', audience({ kind: 'group', people: 24 })).text).toBe('Group · 24 people');
    expect(entryDetail('group:g1', audience({ kind: 'group', people: 1 })).text).toBe('Group · 1 person');
    expect(entryDetail('token:t1', audience({ kind: 'token' })).text).toBe('API token · for calls without a person');
    expect(entryDetail('email:legal@example.com', audience({ kind: 'email', people: 0 })).text).toBe('E-mail · no console person with this address yet');
    expect(entryDetail('email:legal@example.com', audience({ kind: 'email', people: 2 })).text).toBe('E-mail · 2 people');
    expect(entryDetail('everyone').text).toBe('Everyone · including calls without a person');
  });

  it('shows only the kind while the live answer has not arrived', () => {
    expect(entryDetail('user:u1').text).toBe('Person');
    expect(entryDetail('group:g1').text).toBe('Group');
    expect(entryDetail('email:legal@example.com').text).toBe('E-mail');
  });

  it('says what a directory key reaches, and that guests are not members', () => {
    const directory = 'SharePoint · contoso';
    expect(entryDetail('x:sp:g:grp-1', audience({ kind: 'external_group', detail: directory, people: 14 })).text)
      .toBe('SharePoint · contoso group · matches 14 console people');
    expect(entryDetail('x:sp:u:42', audience({ kind: 'external_user', detail: directory, people: 0 })).text)
      .toBe('SharePoint · contoso user · matches no console person yet');
    expect(entryDetail('x:sp:all', audience({ kind: 'external_all', detail: directory })).text)
      .toBe('SharePoint · contoso · guests not included');
    // Not a workspace admin: nothing is counted, nothing is claimed.
    expect(entryDetail('x:sp:g:grp-1', audience({ kind: 'external_group', detail: directory, people: null })).text)
      .toBe('SharePoint · contoso group');
    // Without the directory's label the key stands in.
    expect(entryDetail('x:sp:g:grp-1').text).toBe('sp group');
  });

  it('marks what no longer exists', () => {
    const gone = { exists: false } as const;
    expect(entryDetail('user:u1', audience({ kind: 'user', ...gone }))).toEqual({ text: 'Person · no longer exists', warn: true });
    expect(entryDetail('group:g1', audience({ kind: 'group', ...gone }))).toEqual({ text: 'Group · no longer exists', warn: true });
    expect(entryDetail('token:t1', audience({ kind: 'token', ...gone }))).toEqual({ text: 'API token · no longer exists', warn: true });
    expect(entryDetail('x:sp:all', audience({ kind: 'external_all', detail: 'SharePoint', ...gone })).warn).toBe(true);
    expect(entryDetail('garbage').warn).toBe(true);
  });
});

describe('a key in running text', () => {
  it('names the kind where the name alone would be ambiguous', () => {
    expect(entryPhrase('everyone')).toBe('Everyone');
    expect(entryPhrase('user:u1', 'Ada Example')).toBe('Ada Example');
    expect(entryPhrase('email:ada@example.com')).toBe('ada@example.com');
    expect(entryPhrase('group:g1', 'HR')).toBe('Group HR');
    expect(entryPhrase('token:t1', 'HR chatbot')).toBe('API token HR chatbot');
    const directory = audience({ kind: 'external_group', detail: 'HR SharePoint', label: 'HR Team' });
    expect(entryPhrase('x:sp:g:1', undefined, directory)).toBe('HR SharePoint group HR Team');
    expect(entryPhrase('x:sp:u:1', undefined, { ...directory, kind: 'external_user', label: 'Ada Example' })).toBe('HR SharePoint user Ada Example');
    expect(entryPhrase('x:sp:all', undefined, { ...directory, kind: 'external_all' })).toBe('All HR SharePoint members');
  });
});

describe('what a node starts with and what it inherits', () => {
  const effective = (over: Partial<RagNodeAclView['effective']> = {}): RagNodeAclView['effective'] => ({
    node: { type: 'folder', id: 'f1' },
    entries: [],
    ...over,
  });

  it('starts an own list as a copy of what is inherited', () => {
    const copy = startingEntries(effective({
      entries: [
        { principal: 'group:g1', kind: 'group', label: 'HR' },
        { principal: 'user:u1', kind: 'user' },
      ],
    }));
    expect(copy).toEqual([{ principal: 'group:g1', label: 'HR' }, { principal: 'user:u1' }]);
  });

  it('copies a root nobody is named on as the everyone key, never as an empty (closed) list', () => {
    expect(startingEntries(effective({ node: { type: 'module', id: 'kb' }, openToEveryone: true }))).toEqual([{ principal: 'everyone' }]);
    expect(startingEntries(effective({ node: { type: 'missing', id: 'f9' } }))).toEqual([]);
    expect(startingEntries(null)).toEqual([]);
  });

  it('says in a sentence who reads what a node inherits', () => {
    const names = { 'user:u1': audience({ kind: 'user', label: 'Ada Example' }) };
    expect(inheritedSentence(effective({
      entries: [
        { principal: 'group:g1', kind: 'group', label: 'HR' },
        { principal: 'user:u1', kind: 'user' },
        { principal: 'email:legal@example.com', kind: 'email' },
      ],
    }), names)).toBe('Now readable by Group HR, Ada Example and legal@example.com.');
    expect(inheritedSentence(effective({ node: { type: 'module', id: 'kb' }, openToEveryone: true }), {}))
      .toBe('Now readable by everyone who can open this knowledge engine.');
    expect(inheritedSentence(effective({ entries: [{ principal: 'everyone', kind: 'everyone' }] }), {}))
      .toBe('Now readable by everyone who can open this knowledge engine.');
    expect(inheritedSentence(effective(), {})).toBe('Now readable by nobody.');
    expect(inheritedSentence(effective({ node: { type: 'missing', id: 'f9' } }), {})).toBe('Now readable by nobody: a folder above it is missing.');
    expect(inheritedSentence(null, {})).toBe('');
  });
});

describe('entries to store', () => {
  it('keeps the label only when there is one, flattened and cut to what the server keeps', () => {
    expect(entryInput('user:u1', '  Ada\nExample  ')).toEqual({ principal: 'user:u1', label: 'Ada Example' });
    expect(entryInput('user:u1', '   ')).toEqual({ principal: 'user:u1' });
    expect(entryInput('user:u1')).toEqual({ principal: 'user:u1' });
    expect(entryInput('user:u1', 'x'.repeat(300)).label).toHaveLength(200);
  });

  it('turns a typed address into an entry, lower-cased, or says why not', () => {
    expect(emailEntry('  Legal@Example.COM ')).toEqual({ entry: { principal: 'email:legal@example.com', label: 'legal@example.com' } });
    expect(emailEntry('not-an-address')).toEqual({ error: 'Enter an e-mail address such as name@example.com.' });
    expect(emailEntry('')).toHaveProperty('error');
    expect(emailEntry('a b@example.com')).toHaveProperty('error');
  });

  it('compares lists by their keys only', () => {
    expect(sameEntries([{ principal: 'a' }, { principal: 'b' }], [{ principal: 'b', label: 'B' }, { principal: 'a' }])).toBe(true);
    expect(sameEntries([{ principal: 'a' }], [{ principal: 'a' }, { principal: 'b' }])).toBe(false);
    expect(sameEntries([{ principal: 'a' }, { principal: 'a' }], [{ principal: 'a' }, { principal: 'b' }])).toBe(false);
    expect(sameEntries([], [])).toBe(true);
  });

  it('holds the same limit the server does', () => {
    expect(MAX_ENTRIES).toBe(1000);
  });
});

describe('where a node is and what decided', () => {
  it('writes the subtitle of the editor for each kind of node', () => {
    expect(nodeSubtitle('module', 'HR Policies', undefined, 'HR Policies')).toBe('Default access · HR Policies');
    expect(nodeSubtitle('folder:f1', 'Leave', 'Policies/Leave', 'HR Policies')).toBe('Folder · HR Policies / Policies / Leave');
    expect(nodeSubtitle('folder:f1', 'Leave', undefined, 'HR Policies')).toBe('Folder · HR Policies / Leave');
    expect(nodeSubtitle('document:d1', 'handbook.pdf', 'Policies', 'HR Policies')).toBe('Document · HR Policies / Policies / handbook.pdf');
    expect(nodeSubtitle('document:d1', 'handbook.pdf', '', 'HR Policies')).toBe('Document · HR Policies / handbook.pdf');
  });

  it('names the node that decided', () => {
    expect(decidedByText({ type: 'document', id: 'd1' })).toBe("the document's own permissions");
    expect(decidedByText({ type: 'folder', id: 'f1' }, 'Policies/Leave')).toBe('the permissions of the folder Policies / Leave');
    expect(decidedByText({ type: 'folder', id: 'f1' })).toBe('the permissions of its folder');
    expect(decidedByText({ type: 'module', id: 'kb' })).toBe('the default access');
    expect(decidedByText({ type: 'missing', id: 'f9' })).toContain('a broken folder chain');
  });

  it('says whether a person administers the knowledge engine and what the admin exception does for them', () => {
    expect(administersText(false, false)).toBe('No');
    expect(administersText(true, true)).toContain('the admin exception applies');
    expect(administersText(true, false)).toContain('the admin exception is off');
  });

  it('says what an empty own list means, by the admin exception', () => {
    expect(emptyListSentence(true)).toBe('Admins of this knowledge engine still can, because the admin exception is on.');
    expect(emptyListSentence(false)).toBe('Not even admins of this knowledge engine: the admin exception is off.');
  });
});

describe('matching rules', () => {
  it('uses the very defaults the engine uses', () => {
    expect(DEFAULT_MATCH_RULES).toEqual([...DEFAULT_USER_MATCH]);
  });

  it('applies the defaults when no rule is stored', () => {
    expect(effectiveRules([])).toEqual(DEFAULT_MATCH_RULES);
    expect(effectiveRules(undefined)).toEqual(DEFAULT_MATCH_RULES);
    expect(effectiveRules([{ console: 'externalId', external: 'id' }])).toEqual([{ console: 'externalId', external: 'id' }]);
  });

  it('numbers a rule by its place among the rules in force', () => {
    const rules = effectiveRules([]);
    expect(ruleNumber({ console: 'email', external: 'email' }, rules)).toBe(1);
    expect(ruleNumber({ console: 'email', external: 'upn' }, rules)).toBe(2);
    expect(ruleNumber({ console: 'email', external: 'attr:employeeId' }, rules)).toBeUndefined();
  });

  it('describes both sides of a rule', () => {
    expect(ruleText({ console: 'email', external: 'email' })).toBe('console e-mail = directory e-mail');
    expect(ruleText({ console: 'externalId', external: 'upn' })).toBe('console external ID (SSO / LDAP) = directory UPN');
    expect(externalSideText('id')).toBe('ID');
    expect(externalSideText('attr:employeeId')).toBe('attribute "employeeId"');
  });

  it('describes how a directory matched a person', () => {
    const directory = { label: 'HR SharePoint', userMatch: [] };
    expect(describeMatch({ domain: 'sp', via: 'rule', rule: { console: 'email', external: 'email' }, externalIds: ['1'] }, directory))
      .toBe('HR SharePoint, rule 1: console e-mail = directory e-mail');
    // The second default rule is rule 2.
    expect(describeMatch({ domain: 'sp', via: 'rule', rule: { console: 'email', external: 'upn' }, externalIds: ['1'] }, directory))
      .toBe('HR SharePoint, rule 2: console e-mail = directory UPN');
    // Stored rules are numbered by their own order.
    const stored = { label: 'HR SharePoint', userMatch: [{ console: 'externalId', external: 'id' }, { console: 'email', external: 'email' }] as const };
    expect(describeMatch({ domain: 'sp', via: 'rule', rule: { console: 'email', external: 'email' }, externalIds: ['1'] }, stored))
      .toContain('rule 2:');
    expect(describeMatch({ domain: 'sp', via: 'link', externalIds: ['1'] }, directory)).toBe('HR SharePoint: manual link');
    expect(describeMatch({ domain: 'sp', via: 'external_id', externalIds: ['1'] }, directory)).toContain('external ID (SSO / LDAP)');
    expect(describeMatch({ domain: 'sp', via: 'group_external_id', externalIds: ['1'] }, directory)).toContain('group');
  });

  it('falls back to the directory key, and leaves the number out, when the directory is not known', () => {
    expect(describeMatch({ domain: 'sp', via: 'rule', rule: { console: 'email', external: 'email' }, externalIds: [] }))
      .toBe('sp: console e-mail = directory e-mail');
    expect(describeMatch({ domain: 'sp', via: 'rule', rule: { console: 'email', external: 'attr:badge' }, externalIds: [] }))
      .toBe('sp: console e-mail = directory attribute "badge"');
  });
});
