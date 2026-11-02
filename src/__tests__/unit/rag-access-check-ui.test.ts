// @vitest-environment jsdom
/**
 * "Check access" in a DOM, against a mocked `fetch`: pick a person and a document, ask, and read the answer: the
 * decision, the node and entry behind it, whether they administer the knowledge engine, their keys by name and the
 * connector rule that matched them. And what the card says when the answer is thinner (no document, a project-only
 * admin, access control off) or fails.
 */

import { createElement as h, Fragment, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RagCheckAccess } from '@/components/rag/access/RagCheckAccess';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  qa,
  setInput,
  settle,
  text,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import { until } from '../helpers/filesUploadDetailHarness';

let mounted: Mounted | null = null;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/* ── fixtures ────────────────────────────────────────────────────────────── */

const PEOPLE = [
  { principal: 'user:u-ada', kind: 'user', label: 'Ada Example', detail: 'ada@example.com' },
  { principal: 'user:u-bob', kind: 'user', label: 'Bob Sample', detail: 'bob@example.com' },
];

const DOCUMENTS = [
  { _id: 'd-leave', fileName: 'parental-leave.docx', folderId: 'f-leave' },
  { _id: 'd-handbook', fileName: 'handbook.pdf' },
];

const KEYS = ['everyone', 'user:u-ada', 'email:ada@example.com', 'group:g-hr', 'x:sp:u:ext-1', 'x:sp:g:grp-hr', 'x:sp:all'];

const AUDIENCE: Record<string, unknown> = {
  everyone: { kind: 'everyone', exists: true, people: null },
  'user:u-ada': { kind: 'user', label: 'Ada Example', detail: 'ada@example.com', exists: true, people: 1 },
  'email:ada@example.com': { kind: 'email', exists: true, people: 1 },
  'group:g-hr': { kind: 'group', label: 'HR', exists: true, people: 24 },
  'x:sp:u:ext-1': { kind: 'external_user', label: 'Ada Example', detail: 'HR SharePoint', exists: true, people: 1 },
  'x:sp:g:grp-hr': { kind: 'external_group', label: 'HR Team', detail: 'HR SharePoint', exists: true, people: 14 },
  'x:sp:all': { kind: 'external_all', label: 'All members', detail: 'HR SharePoint', exists: true, people: 900 },
};

const FOLDERS = [
  { _id: 'f-policies', name: 'Policies', path: 'Policies', aclMode: 'own' },
  { _id: 'f-leave', parentId: 'f-policies', name: 'Leave', path: 'Policies/Leave', aclMode: 'own' },
];

const DIRECTORIES = [
  { key: 'sp', kind: 'generic', label: 'HR SharePoint', userMatch: [], source: { kind: 'connector', connectorId: 'conn-1' } },
];

function explanation(over: Record<string, unknown> = {}, document: Record<string, unknown> | null = {}) {
  return {
    userId: 'u-ada',
    active: true,
    enabled: true,
    manage: false,
    bypass: false,
    email: 'ada@example.com',
    groupIds: ['g-hr'],
    principals: KEYS,
    matches: [{ domain: 'sp', via: 'rule', rule: { console: 'email', external: 'email' }, externalIds: ['ext-1'] }],
    ...(document === null ? {} : {
      document: {
        documentId: 'd-leave',
        folderId: 'f-leave',
        mode: 'own',
        effectiveNode: { type: 'document', id: 'd-leave' },
        readable: true,
        grantedBy: ['x:sp:g:grp-hr'],
        ...document,
      },
    }),
    ...over,
  };
}

function install(answer: (query: Record<string, string>) => unknown = () => ({ explanation: explanation() })) {
  api = installApiMock([
    ['GET', '/api/rag/modules/kb/access/principals', (call) => ({
      items: PEOPLE.filter((item) => item.label.toLowerCase().includes((call.query.q ?? '').toLowerCase())),
    })],
    ['GET', '/api/rag/modules/kb/documents', (call) => ({
      documents: DOCUMENTS.filter((item) => item.fileName.includes(call.query.search ?? '')),
      total: DOCUMENTS.length,
    })],
    ['GET', '/api/rag/modules/kb/access/explain', (call) => answer(call.query)],
    ['POST', '/api/rag/modules/kb/access/audience', (call) => ({
      audience: Object.fromEntries(((call.body as { principals: string[] }).principals).filter((key) => key in AUDIENCE).map((key) => [key, AUDIENCE[key]])),
    })],
    ['GET', '/api/rag/modules/kb/folders', () => ({ folders: FOLDERS })],
    ['GET', '/api/rag/identity/domains', () => ({ domains: DIRECTORIES })],
  ]);
}

async function open(answer?: (query: Record<string, string>) => unknown) {
  install(answer);
  mounted = await mount(h(RagCheckAccess, { moduleKey: 'kb', refreshKey: 0 }));
  await until(() => text().includes('Check access'), 'the card');
}

const inputOf = (label: string) => {
  const element = qa('label').find((l) => l.textContent?.trim().startsWith(label));
  return document.getElementById(element?.getAttribute('for') ?? '') as HTMLInputElement;
};

/** Types into a search select, waits for the answer and picks the option. */
async function pick(label: string, query: string, option: string) {
  const input = inputOf(label);
  await click(input);
  await setInput(input, query);
  await settle(450);
  const choice = qa('[role="option"]').find((o) => o.textContent?.includes(option));
  if (!choice) throw new Error(`no option "${option}" among ${qa('[role="option"]').map((o) => o.textContent).join(' | ')}`);
  await click(choice);
}

async function check(person = 'Ada Example', document?: string) {
  await pick('Person', 'ada', person);
  if (document) await pick('Document (optional)', document.slice(0, 6), document);
  await click(buttonByText('Check'));
  await until(() => api.to('GET', '/api/rag/modules/kb/access/explain').length > 0, 'the request');
}

const explainCalls = () => api.to('GET', '/api/rag/modules/kb/access/explain');

/* ── tests ───────────────────────────────────────────────────────────────── */

describe('asking', () => {
  it('cannot ask until a person is chosen', async () => {
    await open();
    const button = buttonByText('Check') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await pick('Person', 'ada', 'Ada Example');
    expect((buttonByText('Check') as HTMLButtonElement).disabled).toBe(false);
  });

  it('searches people and documents on the server, and asks with the ids of the choices', async () => {
    await open();
    await check('Ada Example', 'parental-leave.docx');
    // The person is found among the users who reach the project; the id is the user's, not the key.
    expect(api.to('GET', '/api/rag/modules/kb/access/principals').some((call) => call.query.type === 'user' && call.query.q === 'ada')).toBe(true);
    expect(api.to('GET', '/api/rag/modules/kb/documents').some((call) => call.query.search === 'parent')).toBe(true);
    expect(explainCalls()[0]!.query).toEqual({ userId: 'u-ada', documentId: 'd-leave' });
  });

  it('asks about the person alone when no document is chosen', async () => {
    await open(() => ({ explanation: explanation({}, null) }));
    await check();
    expect(explainCalls()[0]!.query).toEqual({ userId: 'u-ada' });
    await until(() => text().includes('Pick a document to see whether they can read it.'), 'the note');
    expect(text()).not.toContain('Decided by');
    expect(text()).not.toContain('Matching entry');
    // The rest is still said.
    expect(text()).toContain('Administers this knowledge engine');
    expect(text()).toContain('Keys (7)');
  });
});

describe('the answer', () => {
  it('says that the person can read, who decided, which entry let them in, their keys by name and how they matched', async () => {
    await open();
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('Ada Example can read parental-leave.docx'), 'the headline');

    const page = text();
    expect(page).toMatch(/Decided by\s*the document's own permissions/);
    // The entry that let them in, named through the audience route.
    await until(() => /Matching entry\s*HR SharePoint group HR Team/.test(text()), 'the entry name');
    expect(text()).toMatch(/Administers this knowledge engine\s*No/);
    expect(text()).toMatch(/Account\s*Active/);

    // Every key, by the name it stands for.
    await until(() => text().includes('All HR SharePoint members'), 'the key names');
    const keys = text();
    expect(keys).toContain('Keys (7)');
    for (const name of ['Everyone', 'Ada Example', 'ada@example.com', 'Group HR', 'HR SharePoint user Ada Example', 'HR SharePoint group HR Team']) {
      expect(keys).toContain(name);
    }

    // The connector rule, by its place among the directory's rules (none stored: the defaults, so rule 1).
    await until(() => text().includes('HR SharePoint, rule 1: console e-mail = directory e-mail'), 'the rule');
  });

  it('asks the audience route once for the keys it shows', async () => {
    await open();
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('All HR SharePoint members'), 'the key names');
    const asked = api.to('POST', '/api/rag/modules/kb/access/audience').flatMap((call) => (call.body as { principals: string[] }).principals);
    for (const key of KEYS) expect(asked).toContain(key);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it('says that the person cannot read, and that none of their keys is on the list', async () => {
    await open(() => ({ explanation: explanation({}, { readable: false, grantedBy: [] }) }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('Ada Example cannot read parental-leave.docx'), 'the headline');
    expect(text()).toContain('None of their keys is on the list.');
  });

  it('names the folder that decided', async () => {
    await open(() => ({ explanation: explanation({}, { mode: 'inherit', effectiveNode: { type: 'folder', id: 'f-leave' } }) }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('the permissions of the folder Policies / Leave'), 'the folder path');
  });

  it('says the default access decided, and that it names nobody', async () => {
    await open(() => ({
      explanation: explanation({}, { mode: 'inherit', effectiveNode: { type: 'module', id: 'kb' }, grantedBy: [], openToEveryone: true }),
    }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('the default access'), 'the node');
    expect(text()).toContain('None needed: the default access names nobody, so everyone who can open this knowledge engine reads it.');
  });

  it('says a broken folder chain left nobody able to read', async () => {
    await open(() => ({
      explanation: explanation({}, { mode: 'inherit', effectiveNode: { type: 'missing', id: 'f-gone' }, readable: false, grantedBy: [] }),
    }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('a broken folder chain'), 'the node');
    expect(text()).toContain('cannot read');
  });

  it('says an admin reads through the admin exception, and what the exception does', async () => {
    await open(() => ({ explanation: explanation({ manage: true, bypass: true }, { grantedBy: [] }) }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('Yes · the admin exception applies, so they read every document'), 'the admin line');
    expect(text()).toContain('None needed: they administer this knowledge engine and the admin exception is on.');
  });

  it('says an admin without the exception reads only what the permissions allow', async () => {
    await open(() => ({ explanation: explanation({ manage: true, bypass: false }, { readable: false, grantedBy: [] }) }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('Yes · the admin exception is off, so they read only what the permissions allow'), 'the admin line');
    expect(text()).toContain('cannot read');
  });

  it('says a disabled account is disabled', async () => {
    await open(() => ({ explanation: explanation({ active: false, principals: ['everyone'], matches: [] }, { readable: false, grantedBy: [] }) }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => /Account\s*Disabled/.test(text()), 'the account');
    expect(text()).toContain('Keys (1)');
  });

  it('reminds that access control is off, when it is', async () => {
    await open(() => ({ explanation: explanation({ enabled: false }) }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('Access control is off for this knowledge engine, so everyone who can open it reads every document.'), 'the note');
    expect(text()).toContain('Ada Example can read parental-leave.docx');
  });

  it('describes a manual link and the other ways a directory matched', async () => {
    await open(() => ({
      explanation: explanation({
        matches: [
          { domain: 'sp', via: 'link', externalIds: ['ext-1'] },
          { domain: 'sp', via: 'external_id', externalIds: ['ext-1'] },
          { domain: 'sp', via: 'group_external_id', externalIds: ['grp-hr'] },
          { domain: 'sp', via: 'rule', rule: { console: 'email', external: 'upn' }, externalIds: ['ext-1'] },
        ],
      }),
    }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('HR SharePoint, rule 2: console e-mail = directory UPN'), 'the rules');
    expect(text()).toContain('HR SharePoint: manual link');
    expect(text()).toContain('the external ID (SSO / LDAP) of the person is taken as the directory user ID');
    expect(text()).toContain('the external ID of one of their groups is the ID of a directory group');
  });

  it('says no directory knows the person when none matched', async () => {
    await open(() => ({ explanation: explanation({ matches: [] }) }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('No connector directory knows this person.'), 'the note');
  });

  it('keeps the identity back from an admin of the project only, and says why', async () => {
    const thin = explanation({}, { grantedBy: [] });
    delete (thin as Record<string, unknown>).principals;
    delete (thin as Record<string, unknown>).matches;
    delete (thin as Record<string, unknown>).email;
    delete (thin as Record<string, unknown>).groupIds;
    await open(() => ({ explanation: thin }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('Keys and directory matches are shown to Knowledge Engine admins of the whole workspace.'), 'the note');
    expect(text()).not.toContain('Keys (');
    expect(text()).not.toContain('Matched by');
    // The decision is still given.
    expect(text()).toContain('Ada Example can read parental-leave.docx');
    expect(api.to('GET', '/api/rag/identity/domains')).toHaveLength(0);
  });

  it('lists the first keys and the rest on request', async () => {
    const many = ['everyone', ...Array.from({ length: 11 }, (_, index) => `group:g${index}`)];
    await open(() => ({ explanation: explanation({ principals: many }) }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('Keys (12)'), 'the keys');
    expect(text()).toContain('Show all 12 keys');
    expect(text()).not.toContain('group:g10');
    await click(buttonByText('Show all 12 keys'));
    await until(() => text().includes('g10'), 'all keys');
    expect(text()).toContain('Show fewer keys');
  });
});

describe('when the check fails', () => {
  it('shows the server’s sentence and no answer', async () => {
    await open((query) => (query.userId === 'u-ada'
      ? jsonResponse({ error: 'User not found', code: 'user_not_found' }, 404)
      : { explanation: explanation() }));
    await check();
    await until(() => text().includes('User not found'), 'the error');
    expect(text()).not.toContain('Administers this knowledge engine');
  });

  it('drops an earlier answer when the next check fails', async () => {
    let fail = false;
    await open(() => (fail ? jsonResponse({ error: 'Not now' }, 500) : { explanation: explanation() }));
    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('Ada Example can read parental-leave.docx'), 'the answer');
    fail = true;
    await click(buttonByText('Check'));
    await until(() => text().includes('Not now'), 'the error');
    expect(text()).not.toContain('can read parental-leave.docx');
  });
});

describe('after permissions changed elsewhere', () => {
  it('asks again, with the same person and document, when the page bumps the refresh key', async () => {
    function Harness() {
      const [key, setKey] = useState(0);
      return h(Fragment, null, h('button', { onClick: () => setKey((n) => n + 1) }, 'bump'), h(RagCheckAccess, { moduleKey: 'kb', refreshKey: key }));
    }
    install();
    mounted = await mount(h(Harness));
    await until(() => text().includes('Check access'), 'the card');
    // Nothing is asked again while there is nothing on screen.
    await click(buttonByText('bump'));
    await settle(30);
    expect(explainCalls()).toHaveLength(0);

    await check('Ada Example', 'parental-leave.docx');
    await until(() => text().includes('Ada Example can read parental-leave.docx'), 'the answer');
    await click(buttonByText('bump'));
    await until(() => explainCalls().length === 2, 'the second request');
    expect(explainCalls()[1]!.query).toEqual({ userId: 'u-ada', documentId: 'd-leave' });
  });
});
