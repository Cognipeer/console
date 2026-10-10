// @vitest-environment jsdom
/**
 * The full-screen forms behind the Principals list: what each one sends (only
 * what changed), what it refuses to let through, how a server refusal reads,
 * and the one-time secrets that cannot be dismissed by accident.
 */
import { act, createElement, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  setInput,
  settle,
  text,
  type ApiMock,
  type Mounted,
  type RouteHandler,
} from '../helpers/iamCenterUi';
import { PROJECTS } from '../helpers/iamDirectoryFixtures';
import AddToProjectShell from '@/components/iam/principals/AddToProjectShell';
import ChangeRoleShell from '@/components/iam/principals/ChangeRoleShell';
import EditAccessShell from '@/components/iam/principals/EditAccessShell';
import EditProfileShell from '@/components/iam/principals/EditProfileShell';
import GroupShell from '@/components/iam/principals/GroupShell';
import ImportPeopleShell from '@/components/iam/principals/ImportPeopleShell';
import InvitePersonShell from '@/components/iam/principals/InvitePersonShell';
import MembershipShell from '@/components/iam/principals/MembershipShell';
import NewTokenShell from '@/components/iam/principals/NewTokenShell';
import ServicePermissionMatrix from '@/components/iam/principals/ServicePermissionMatrix';
import { readDraft, toPermissions, type MatrixDraft } from '@/components/iam/principals/permissionModel';
import { useAccessPreview, type AccessPreviewState } from '@/components/iam/principals/useAccessPreview';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/iam',
}));

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

type Route = [string, string | RegExp, RouteHandler];

async function show(element: ReturnType<typeof createElement>, routes: Route[] = [], locale = 'en') {
  api = installApiMock([['GET', '/api/iam/catalog', () => jsonResponse({ error: 'not under test' }, 404)], ...routes]);
  mounted = await mount(element, locale);
  await settle(80);
}

const shell = () => q('.form-overlay')!;
/** The name/email/search inputs of the open form (Mantine leaves the `type` attribute off a plain text input). */
const textInputs = () => qa<HTMLInputElement>('input', shell()).filter((i) => i.type === 'text' || i.type === 'email');
const inShell = (sel: string) => q(sel, shell());
const shellButton = (label: string) => qa<HTMLButtonElement>('button', shell()).find((b) => b.textContent?.trim() === label);
const chip = (label: string | RegExp) =>
  qa<HTMLButtonElement>('.form-chip', shell()).find((b) => (typeof label === 'string' ? b.textContent?.startsWith(label) : label.test(b.textContent ?? '')));
const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

// ── the permission matrix ──────────────────────────────────────────────────

describe('ServicePermissionMatrix', () => {
  function Harness({ role, mode, onDraft }: { role: string | null; mode: 'person' | 'group'; onDraft: (d: MatrixDraft) => void }) {
    const [draft, setDraft] = useState<MatrixDraft>(() => readDraft({ aegis: 'admin' }));
    onDraft(draft);
    return createElement(ServicePermissionMatrix, { draft, onChange: setDraft, role, mode });
  }
  const pick = async (service: string, label: string) => {
    const row = q(`tr[data-service="${service}"]`)!;
    await click(qa<HTMLLabelElement>('label', row).find((l) => l.textContent === label));
  };

  it('shows the role default per service and stores only what was chosen', async () => {
    let draft!: MatrixDraft;
    await show(createElement(Harness, { role: 'user', mode: 'person', onDraft: (d) => (draft = d) }));
    expect(text()).toContain('Role default');
    // a plain user writes in Model Hub by role, and has no access to an administration service
    expect(q('tr[data-service="models"]')?.textContent).toContain('Write');
    expect(q('tr[data-service="iam"]')?.textContent).toContain('No access');
    // nothing chosen: nothing stored; a retired service never shows up
    expect(toPermissions(draft)).toEqual({ aegis: 'admin' });
    expect(q('tr[data-service="aegis"]')).toBeNull();

    await pick('models', 'Read');
    expect(toPermissions(draft)).toEqual({ aegis: 'admin', models: 'read' });
    await pick('iam', 'No access');
    expect(toPermissions(draft)).toEqual({ aegis: 'admin', models: 'read', iam: 'none' });
    await pick('models', 'Role default');
    expect(toPermissions(draft)).toEqual({ aegis: 'admin', iam: 'none' });
  });

  it('counts the changed services, filters to them and resets', async () => {
    let draft!: MatrixDraft;
    await show(createElement(Harness, { role: 'user', mode: 'person', onDraft: (d) => (draft = d) }));
    await pick('models', 'Read');
    await pick('agents', 'Admin');
    expect(text()).toContain('Changed (2)');
    await click(qa<HTMLLabelElement>('label').find((l) => l.textContent === 'Changed (2)'));
    expect(qa('tbody tr')).toHaveLength(2);
    await click(buttonByText('Reset to role default'));
    expect(toPermissions(draft)).toEqual({ aegis: 'admin' });
  });

  it('for a group without a role the default is "No grant"', async () => {
    await show(createElement(Harness, { role: null, mode: 'group', onDraft: () => {} }));
    expect(text()).toContain('No grant');
    expect(text()).toContain('Clear all grants');
    expect(q('tr[data-service="models"]')?.textContent).toContain('No access');
  });
});

// ── the live preview ───────────────────────────────────────────────────────

describe('useAccessPreview', () => {
  function Probe({ initial, onState, onSet }: { initial: { role?: string } | null; onState: (s: AccessPreviewState) => void; onSet: (set: (d: { role?: string } | null) => void) => void }) {
    const [draft, setDraft] = useState<{ role?: string } | null>(initial);
    onSet(setDraft);
    onState(useAccessPreview('u1', draft, { delayMs: 10 }));
    return null;
  }

  it('waits for the draft to settle, and a slow answer for an older draft never replaces a newer one', async () => {
    let latest!: AccessPreviewState;
    let setDraft!: (d: { role?: string } | null) => void;
    let calls = 0;
    api = installApiMock([
      [
        'POST',
        '/api/iam/principals/user/u1/preview',
        async (c) => {
          calls += 1;
          const role = (c.body as { role: string }).role;
          // the first draft is slow, the second is fast
          await new Promise((r) => setTimeout(r, role === 'admin' ? 300 : 10));
          return { effective: [], changes: [{ service: 'models', from: 'none', to: role === 'admin' ? 'admin' : 'read' }], projects: null };
        },
      ],
    ]);
    mounted = await mount(createElement(Probe, { initial: { role: 'admin' }, onState: (s) => (latest = s), onSet: (f) => (setDraft = f) }));
    await settle(60); // the slow request for "admin" is in flight
    expect(latest.loading).toBe(true);
    // the draft changes: "admin" is abandoned, "user" is asked for
    await act(async () => setDraft({ role: 'user' }));
    await settle(500);
    expect(calls).toBe(2);
    expect(latest.loading).toBe(false);
    expect(latest.preview?.changes[0]?.to).toBe('read');
  });

  it('asks nothing without a draft', async () => {
    api = installApiMock([]);
    mounted = await mount(createElement(Probe, { initial: null, onState: () => {}, onSet: () => {} }));
    await settle(60);
    expect(api.calls).toHaveLength(0);
  });
});

// ── edit profile ───────────────────────────────────────────────────────────

describe('EditProfileShell', () => {
  const person = { id: 'u-ann', name: 'Ann Lee', email: 'ann@example.com', canLogin: true, managed: false, provider: null };
  const element = (patch: Record<string, unknown> = {}, onSaved = vi.fn(), onClose = vi.fn()) =>
    createElement(EditProfileShell, { open: true, person: { ...person, ...patch }, onClose, onSaved } as never);

  it('sends only the fields that changed', async () => {
    const onSaved = vi.fn();
    await show(element({}, onSaved), [['PATCH', '/api/users/u-ann', () => ({ user: { _id: 'u-ann' }, changed: ['name'] })]]);
    expect(shellButton('Save changes')!.disabled).toBe(true);
    await setInput(qa<HTMLInputElement>('input', shell())[0]!, 'Ann L.');
    expect(shellButton('Save changes')!.disabled).toBe(false);
    await click(shellButton('Save changes'));
    await settle(60);
    expect(api.to('PATCH', '/api/users/u-ann')[0]?.body).toEqual({ name: 'Ann L.' });
    expect(onSaved).toHaveBeenCalledWith(['name']);
  });

  it('shows a taken email on the email field, not as a generic failure', async () => {
    await show(element(), [['PATCH', '/api/users/u-ann', () => jsonResponse({ error: 'taken', code: 'email_taken' }, 409)]]);
    await setInput(qa<HTMLInputElement>('input', shell())[1]!, 'bob@example.com');
    await click(shellButton('Save changes'));
    await settle(60);
    expect(shell().textContent).toContain('Another account already uses this email address.');
    expect(inShell('[data-testid="form-error"]')).toBeNull();
  });

  it('locks a directory account: banner, read-only fields, nothing to save', async () => {
    await show(element({ managed: true, provider: 'ldap' }));
    expect(inShell('[data-testid="managed-banner"]')?.textContent).toContain('LDAP');
    expect(qa('[data-testid="locked-field"]', shell())).toHaveLength(2);
    expect(shellButton('Save changes')!.disabled).toBe(true);
  });

  it('makes the email optional for a service account and refuses a malformed one', async () => {
    await show(element({ canLogin: false, email: '' }));
    await setInput(qa<HTMLInputElement>('input', shell())[0]!, 'Build bot');
    expect(shellButton('Save changes')!.disabled).toBe(false);
    await setInput(qa<HTMLInputElement>('input', shell())[1]!, 'not-an-email');
    expect(shellButton('Save changes')!.disabled).toBe(true);
    expect(shell().textContent).toContain('Enter a valid email address');
  });
});

// ── change role ────────────────────────────────────────────────────────────

describe('ChangeRoleShell', () => {
  const ann = { id: 'u-ann', name: 'Ann Lee', email: 'ann@example.com', role: 'user', isSelf: false };
  const element = (patch: Record<string, unknown> = {}, assignable = ['admin', 'project_admin', 'user'], onSaved = vi.fn()) =>
    createElement(ChangeRoleShell, { open: true, person: { ...ann, ...patch }, assignableRoles: assignable, onClose: vi.fn(), onSaved } as never);
  const PREVIEW: Route = [
    'POST',
    '/api/iam/principals/user/u-ann/preview',
    () => ({
      effective: [],
      changes: [
        { service: 'members', from: 'none', to: 'admin' },
        { service: 'models', from: 'write', to: 'read' },
      ],
      projects: { before: 2, after: 5 },
    }),
  ];

  it('offers only the roles the signed-in person may hand out (plus the current one)', async () => {
    await show(element({ role: 'user' }, ['project_admin']), [PREVIEW]);
    const chips = qa('.form-chip', shell()).map((c) => c.textContent);
    expect(chips).toHaveLength(2);
    expect(chips.join(' ')).toContain('Project admin');
    expect(chips.join(' ')).toContain('User');
    expect(chips.join(' ')).not.toContain('Admin works');
  });

  it('previews what changes with the real engine before anything is saved, then saves only the role', async () => {
    const onSaved = vi.fn();
    await show(element({}, undefined, onSaved), [PREVIEW, ['PATCH', '/api/users/u-ann', () => ({ user: {}, changed: ['role'] })]]);
    expect(shellButton('Change role')!.disabled).toBe(true);
    await click(chip('Admin'));
    expect(inShell('[data-testid="admin-callout"]')?.textContent).toContain('Admins can manage people');
    await settle(700);
    expect(api.to('POST', '/api/iam/principals/user/u-ann/preview')[0]?.body).toEqual({ role: 'admin' });
    expect(inShell('[data-testid="role-gain"]')?.textContent).toContain('Members: No access → Admin');
    expect(inShell('[data-testid="role-loss"]')?.textContent).toContain('Model Hub: Write → Read');
    expect(shell().textContent).toContain('Reachable projects: 2 → 5');
    expect(shell().textContent).toContain('within about 30 seconds on every server');

    await click(shellButton('Change role'));
    await settle(80);
    expect(api.to('PATCH', '/api/users/u-ann')[0]?.body).toEqual({ role: 'admin' });
    expect(onSaved).toHaveBeenCalled();
  });

  it('warns when an admin is demoted', async () => {
    await show(element({ role: 'admin' }), [PREVIEW]);
    await click(chip('User'));
    expect(inShell('[data-testid="admin-callout"]')?.textContent).toContain('lose admin access');
  });

  it('cannot be used on the owner or on yourself, and says why', async () => {
    await show(element({ role: 'owner' }));
    expect(inShell('[data-testid="role-locked"]')?.textContent).toContain('cannot be changed');
    expect(shellButton('Change role')!.disabled).toBe(true);
    await mounted.unmount();
    await show(element({ isSelf: true }));
    expect(inShell('[data-testid="role-locked"]')?.textContent).toContain('your own role');
    await click(chip('Admin'));
    expect(shellButton('Change role')!.disabled).toBe(true);
    expect(api.to('POST', '/api/iam/principals/user/u-ann/preview')).toHaveLength(0);
  });

  it('shows the server\'s refusal in the form', async () => {
    await show(element(), [PREVIEW, ['PATCH', '/api/users/u-ann', () => jsonResponse({ error: 'x', code: 'admin_grant_requires_admin' }, 403)]]);
    await click(chip('Admin'));
    await click(shellButton('Change role'));
    await settle(80);
    expect(inShell('[data-testid="form-error"]')?.textContent).toContain('Only an owner or an admin can grant or remove the admin role.');
  });

  it('still lets the role be saved when the preview itself fails', async () => {
    await show(element(), [['POST', '/api/iam/principals/user/u-ann/preview', () => jsonResponse({ error: 'x' }, 500)], ['PATCH', '/api/users/u-ann', () => ({ user: {}, changed: ['role'] })]]);
    await click(chip('Project admin'));
    await settle(700);
    expect(shell().textContent).toContain('could not be previewed');
    expect(shellButton('Change role')!.disabled).toBe(false);
  });
});

// ── edit access ────────────────────────────────────────────────────────────

describe('EditAccessShell', () => {
  const ann = { id: 'u-ann', name: 'Ann Lee', email: 'ann@example.com', role: 'user', servicePermissions: { models: 'read', aegis: 'admin' } };
  const pickIn = async (service: string, label: string) => {
    const row = q(`tr[data-service="${service}"]`, shell())!;
    await click(qa<HTMLLabelElement>('label', row).find((l) => l.textContent === label));
  };

  it('starts from the direct overrides, previews the whole draft and saves it with the entries it does not offer', async () => {
    const onSaved = vi.fn();
    await show(createElement(EditAccessShell, { open: true, person: ann, onClose: vi.fn(), onSaved } as never), [
      ['POST', '/api/iam/principals/user/u-ann/preview', () => ({ effective: [], changes: [{ service: 'agents', from: 'write', to: 'admin' }], projects: null })],
      ['PATCH', '/api/users/u-ann/permissions', () => ({ user: {} })],
    ]);
    expect(shellButton('Save access')!.disabled).toBe(true);
    expect(q('tr[data-service="models"]', shell())?.querySelector('input:checked')?.getAttribute('value')).toBe('read');

    await pickIn('agents', 'Admin');
    expect(shellButton('Save access')!.disabled).toBe(false);
    await settle(700);
    expect(api.to('POST', '/api/iam/principals/user/u-ann/preview')[0]?.body).toEqual({ servicePermissions: { models: 'read', agents: 'admin', aegis: 'admin' } });
    expect(inShell('[data-testid="access-change"]')?.textContent).toContain('Agents: Write → Admin');

    await click(shellButton('Save access'));
    await settle(80);
    expect(api.to('PATCH', '/api/users/u-ann/permissions')[0]?.body).toEqual({ servicePermissions: { models: 'read', agents: 'admin', aegis: 'admin' } });
    expect(onSaved).toHaveBeenCalled();
  });

  it('resets every service to the role default in one click', async () => {
    await show(createElement(EditAccessShell, { open: true, person: ann, onClose: vi.fn(), onSaved: vi.fn() } as never), [
      ['POST', '/api/iam/principals/user/u-ann/preview', () => ({ effective: [], changes: [], projects: null })],
      ['PATCH', '/api/users/u-ann/permissions', () => ({ user: {} })],
    ]);
    await click(buttonByText('Reset to role default'));
    await click(shellButton('Save access'));
    await settle(60);
    // the retired service stays; everything the matrix offers is back to the role default
    expect(api.to('PATCH', '/api/users/u-ann/permissions')[0]?.body).toEqual({ servicePermissions: { aegis: 'admin' } });
  });
});

// ── invite a person / create a service account ─────────────────────────────

describe('InvitePersonShell', () => {
  const ROLES = ['admin', 'project_admin', 'user'];
  const element = (mode: 'person' | 'service', handlers: Record<string, unknown> = {}) =>
    createElement(InvitePersonShell, { open: true, mode, assignableRoles: ROLES, onCreated: vi.fn(), onClose: vi.fn(), ...handlers } as never);
  const fill = async (name: string, email: string) => {
    const inputs = textInputs();
    await setInput(inputs[0]!, name);
    await setInput(inputs[1]!, email);
  };

  it('invites a person with the chosen role, by email', async () => {
    const onCreated = vi.fn();
    await show(element('person', { onCreated }), [
      ['POST', '/api/users/invite', () => ({ message: 'ok', user: { id: 'u9', name: 'Ada', email: 'ada@example.com', role: 'admin', canLogin: true }, invitationEmailSent: true, invitationUrl: 'https://x/accept?t=1' })],
    ]);
    expect(shellButton('Invite')!.disabled).toBe(true);
    await fill('Ada Lovelace', 'ada@example.com');
    await click(chip('Admin'));
    expect(shellButton('Invite')!.disabled).toBe(false);
    await click(shellButton('Invite'));
    await settle(80);
    expect(api.to('POST', '/api/users/invite')[0]?.body).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      role: 'admin',
      canLogin: true,
      sendInvite: true,
      servicePermissions: {},
    });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u9' }));
    // the link is shown, with its delivery state
    expect(inShell('[data-testid="invitation-url"]')?.textContent).toBe('https://x/accept?t=1');
    expect(shell().textContent).toContain('Email sent');
  });

  it('shows a one-time password when no invitation is sent, and Escape does not dismiss it', async () => {
    const onClose = vi.fn();
    await show(element('person', { onClose }), [
      ['POST', '/api/users/invite', () => ({ message: 'ok', user: { id: 'u9', name: 'Ada', email: 'ada@example.com', role: 'user', canLogin: true }, generatedPassword: 'Tmp#Pass-123' })],
    ]);
    await fill('Ada Lovelace', 'ada@example.com');
    // delivery: no invitation email
    await click(qa<HTMLInputElement>('input[type="checkbox"]', shell())[0]);
    await click(shellButton('Invite'));
    await settle(80);
    expect(api.to('POST', '/api/users/invite')[0]?.body).toMatchObject({ sendInvite: false, canLogin: true });
    expect(inShell('[data-testid="generated-password"]')?.textContent).toBe('Tmp#Pass-123');
    escape();
    await settle(30);
    expect(onClose).not.toHaveBeenCalled();
    await click(shellButton('Done, I copied it'));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u9' }));
  });

  it('creates a service account: cannot sign in, email optional, offers to create a token', async () => {
    const onCreateToken = vi.fn();
    await show(element('service', { onCreateToken }), [
      ['POST', '/api/users/invite', () => ({ message: 'ok', user: { id: 's1', name: 'ci-bot', email: '', role: 'user', canLogin: false }, generatedPassword: 'ignored-for-a-service-account' })],
    ]);
    expect(shell().textContent).toContain('Create a service account');
    expect(shell().textContent).toContain('cannot sign in');
    const inputs = textInputs();
    await setInput(inputs[0]!, 'ci-bot');
    expect(shellButton('Create service account')!.disabled).toBe(false);
    await click(shellButton('Create service account'));
    await settle(80);
    expect(api.to('POST', '/api/users/invite')[0]?.body).toEqual({
      name: 'ci-bot',
      email: '',
      role: 'user',
      canLogin: false,
      sendInvite: false,
      servicePermissions: {},
    });
    // no password is shown: it would be useless for an account that cannot sign in
    expect(inShell('[data-testid="generated-password"]')).toBeNull();
    expect(shell().textContent).toContain('Service account created');
    await click(shellButton('Create a token'));
    expect(onCreateToken).toHaveBeenCalledWith(expect.objectContaining({ userId: 's1', name: 'ci-bot' }));
  });

  it('offers only the roles the signed-in person may hand out', async () => {
    await show(element('person', { assignableRoles: ['user'] }));
    expect(qa('.form-chip', shell())).toHaveLength(1);
    await mounted.unmount();
    await show(element('person', { assignableRoles: [] }));
    expect(shell().textContent).toContain('You cannot hand out any role.');
    await fill('Ada Lovelace', 'ada@example.com');
    expect(shellButton('Invite')!.disabled).toBe(true);
  });

  it('words the plan limit and a taken email the way the server said it', async () => {
    await show(element('person'), [['POST', '/api/users/invite', () => jsonResponse({ error: 'User quota exceeded for your plan' }, 429)]]);
    await fill('Ada Lovelace', 'ada@example.com');
    await click(shellButton('Invite'));
    await settle(80);
    expect(inShell('[data-testid="form-error"]')?.textContent).toContain('User quota exceeded for your plan');
    await mounted.unmount();
    await show(element('person'), [['POST', '/api/users/invite', () => jsonResponse({ error: 'exists', code: 'email_taken' }, 409)]]);
    await fill('Ada Lovelace', 'ada@example.com');
    await click(shellButton('Invite'));
    await settle(80);
    expect(inShell('[data-testid="form-error"]')?.textContent).toContain('Another account already uses this email address.');
  });
});

// ── import ─────────────────────────────────────────────────────────────────

describe('ImportPeopleShell', () => {
  it('imports service accounts from a pasted CSV with one role, and reports what could not be read', async () => {
    const onImported = vi.fn();
    await show(createElement(ImportPeopleShell, { open: true, assignableRoles: ['admin', 'user'], onClose: vi.fn(), onImported } as never), [
      ['POST', '/api/users/bulk-import', () => ({ createdCount: 2, skippedExisting: ['old@x.co'], invalid: ['row 4: no name'], invalidCount: 1, halted: { at: 2 } })],
    ]);
    expect(shell().textContent).toContain('Import service accounts');
    expect(shell().textContent).toContain('cannot sign in');
    expect(shellButton('Import')!.disabled).toBe(true);
    await setInput(q<HTMLTextAreaElement>('textarea', shell())!, 'email,name\na@x.co,A\nb@x.co,B\n');
    expect(shell().textContent).toContain('3'); // rows
    await click(shellButton('Import'));
    await settle(80);
    expect(api.to('POST', '/api/users/bulk-import')[0]?.body).toEqual({ csv: 'email,name\na@x.co,A\nb@x.co,B\n', role: 'user' });
    expect(onImported).toHaveBeenCalled();
    expect(inShell('[data-testid="import-created"]')?.textContent).toContain('2 service accounts were created');
    expect(inShell('[data-testid="import-invalid"]')?.textContent).toContain('row 4: no name');
    expect(inShell('[data-testid="import-halted"]')?.textContent).toContain('user limit');
  });
});

// ── groups ─────────────────────────────────────────────────────────────────

describe('GroupShell', () => {
  const stored = { id: 'g1', name: 'Eng', description: 'Builders', tenantRole: 'user', servicePermissions: { models: 'read' }, source: 'local', memberCount: 12 };

  it('creates a group with a name, a role and grants', async () => {
    const onSaved = vi.fn();
    await show(createElement(GroupShell, { open: true, group: null, onClose: vi.fn(), onSaved } as never), [
      ['POST', '/api/groups', () => jsonResponse({ group: { _id: 'g9', name: 'Ops' } }, 201)],
    ]);
    expect(shellButton('Create group')!.disabled).toBe(true);
    await setInput(textInputs()[0]!, 'Ops');
    await click(chip('Admin'));
    await click(shellButton('Create group'));
    await settle(80);
    expect(api.to('POST', '/api/groups')[0]?.body).toEqual({ name: 'Ops', tenantRole: 'admin', servicePermissions: {} });
    expect(onSaved).toHaveBeenCalledWith('g9');
  });

  it('edits only what changed', async () => {
    await show(createElement(GroupShell, { open: true, group: stored, onClose: vi.fn(), onSaved: vi.fn() } as never), [['PATCH', '/api/groups/g1', () => ({ group: {} })]]);
    expect(shellButton('Save group')!.disabled).toBe(true);
    await click(chip('No role'));
    await click(shellButton('Save group'));
    await settle(80);
    expect(api.to('PATCH', '/api/groups/g1')[0]?.body).toEqual({ tenantRole: null });
  });

  it('keeps the name of a directory group and says what the directory owns', async () => {
    await show(createElement(GroupShell, { open: true, group: { ...stored, source: 'ldap' }, onClose: vi.fn(), onSaved: vi.fn() } as never));
    expect(inShell('[data-testid="managed-banner"]')?.textContent).toContain('LDAP');
    expect(textInputs()[0]!.disabled).toBe(true);
  });

  it('never writes grants it could not load', async () => {
    await show(createElement(GroupShell, { open: true, group: { ...stored, servicePermissions: null }, onClose: vi.fn(), onSaved: vi.fn() } as never), [['PATCH', '/api/groups/g1', () => ({ group: {} })]]);
    expect(inShell('[data-testid="grants-unavailable"]')).not.toBeNull();
    await setInput(textInputs()[0]!, 'Platform');
    await click(shellButton('Save group'));
    await settle(60);
    expect(api.to('PATCH', '/api/groups/g1')[0]?.body).toEqual({ name: 'Platform' });
  });
});

// ── tokens ─────────────────────────────────────────────────────────────────

describe('NewTokenShell', () => {
  const TOKEN_ROUTES: Route[] = [
    ['GET', '/api/projects', () => PROJECTS],
    ['GET', '/api/iam/principals', () => ({ items: [{ type: 'user', id: 'u-me', label: 'Me Myself', sublabel: '', policyCount: 0 }], nextCursor: null })],
    ['GET', '/api/tokens/policy', () => ({ maxLifetimeDays: null, requireExpiry: false, expiryRequired: false, maxIpRanges: 10, clientIp: null, trustsForwardedHeaders: false })],
    ['POST', '/api/tokens', () => jsonResponse({ id: 't1', token: 'cp_secret', label: 'ci', expiresAt: null, allowedIpRanges: null }, 201)],
  ];

  it('mints for the preset person in the chosen project', async () => {
    const onCreated = vi.fn();
    await show(
      createElement(NewTokenShell, { open: true, onClose: vi.fn(), onCreated, owner: { id: 'u-ann', label: 'Ann Lee' }, me: { userId: 'u-me' }, canMintForOthers: true } as never),
      TOKEN_ROUTES,
    );
    expect(shell().textContent).toContain('Owner and project');
    expect(shell().textContent).toContain('Ann Lee');
    await setInput(q<HTMLInputElement>('input[placeholder^="Production API"]', shell())!, 'ci-pipeline');
    await click(shellButton('Create Token'));
    await settle(100);
    const body = api.to('POST', '/api/tokens')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ label: 'ci-pipeline', userId: 'u-ann', projectId: 'p-a' });
    expect(shell().textContent).toContain('cp_secret');
  });

  it('is locked to the signed-in person when they may not mint for others, and names no owner', async () => {
    await show(
      createElement(NewTokenShell, { open: true, onClose: vi.fn(), onCreated: vi.fn(), owner: { id: 'u-ann', label: 'Ann Lee' }, me: { userId: 'u-me' }, canMintForOthers: false } as never),
      TOKEN_ROUTES,
    );
    expect(shell().textContent).toContain('You can only create tokens for yourself.');
    await setInput(q<HTMLInputElement>('input[placeholder^="Production API"]', shell())!, 'mine');
    await click(shellButton('Create Token'));
    await settle(100);
    const body = api.to('POST', '/api/tokens')[0]?.body as Record<string, unknown>;
    expect(body.userId).toBeUndefined();
    expect(body.projectId).toBe('p-a');
  });
});

// ── memberships ────────────────────────────────────────────────────────────

describe('MembershipShell and AddToProjectShell', () => {
  const GROUP_LIST: Route = [
    'GET',
    '/api/iam/principals',
    () => ({ items: [{ type: 'group', id: 'g-eng', label: 'Engineering', sublabel: '', source: 'local', tenantRole: 'admin', memberCount: 12, policyCount: 0 }], nextCursor: null }),
  ];

  it('adds a person to the local groups picked, one membership each', async () => {
    const onDone = vi.fn();
    await show(
      createElement(MembershipShell, { mode: 'person', open: true, person: { id: 'u-ann', name: 'Ann Lee', email: 'ann@example.com', groupIds: [] }, onClose: vi.fn(), onDone } as never),
      [GROUP_LIST, ['POST', '/api/groups/g-eng/members', () => jsonResponse({ message: 'Member added' }, 201)]],
    );
    // directory groups are never offered: only local ones are searched
    expect(api.to('GET', '/api/iam/principals')[0]?.query).toMatchObject({ type: 'group', source: 'local' });
    await click(q('input', shell()));
    await settle(80);
    const option = qa('[role="option"]').find((o) => o.textContent?.includes('Engineering'))!;
    // each option says what joining it gives
    expect(option.textContent).toContain('Gives the Admin role');
    expect(option.textContent).toContain('12 members');
    await click(option);
    await settle(30);
    await click(shellButton('Add to groups'));
    await settle(100);
    expect(api.to('POST', '/api/groups/g-eng/members')[0]?.body).toEqual({ userId: 'u-ann', role: 'member' });
    expect(onDone).toHaveBeenCalled();
  });

  it('hands the chosen group to the bulk flow instead of writing', async () => {
    const onPick = vi.fn();
    await show(createElement(MembershipShell, { mode: 'bulk-add', open: true, count: 12, onClose: vi.fn(), onPick } as never), [GROUP_LIST]);
    expect(shell().textContent).toContain('Add 12 people to a group');
    await click(q('input', shell()));
    await settle(80);
    await click(qa('[role="option"]').find((o) => o.textContent?.includes('Engineering')));
    await click(shellButton('Continue'));
    expect(onPick).toHaveBeenCalledWith({ id: 'g-eng', name: 'Engineering' });
  });

  it('adds a person to a project they are not in yet, with a role', async () => {
    const onDone = vi.fn();
    await show(
      createElement(AddToProjectShell, { open: true, subject: { kind: 'user', id: 'u-ann', name: 'Ann Lee', projectIds: ['p-a'] }, onClose: vi.fn(), onDone } as never),
      [['GET', '/api/projects', () => PROJECTS], ['POST', '/api/projects/p-b/members', () => ({ userProject: {} })]],
    );
    await click(q('input', shell()));
    await settle(60);
    const options = qa('[role="option"]').map((o) => o.textContent);
    expect(options).toEqual(['Beta']); // Alpha: already a member
    await click(qa('[role="option"]')[0]);
    await click(chip('Project admin'));
    await click(shellButton('Add to project'));
    await settle(80);
    expect(api.to('POST', '/api/projects/p-b/members')[0]?.body).toEqual({ userId: 'u-ann', role: 'project_admin' });
    expect(onDone).toHaveBeenCalled();
  });

  it('assigns a group to a project through the group endpoint', async () => {
    await show(
      createElement(AddToProjectShell, { open: true, subject: { kind: 'group', id: 'g-eng', name: 'Engineering', projectIds: [] }, onClose: vi.fn(), onDone: vi.fn() } as never),
      [['GET', '/api/projects', () => PROJECTS], ['POST', '/api/groups/g-eng/projects', () => jsonResponse({ assignment: {} }, 201)]],
    );
    await click(q('input', shell()));
    await settle(60);
    await click(qa('[role="option"]')[0]);
    await click(shellButton('Assign to project'));
    await settle(80);
    expect(api.to('POST', '/api/groups/g-eng/projects')[0]?.body).toEqual({ projectId: 'p-a', role: 'member' });
  });
});

// ── Turkish ────────────────────────────────────────────────────────────────

describe('in Turkish', () => {
  it('renders the forms in the user\'s language', async () => {
    await show(createElement(InvitePersonShell, { open: true, mode: 'service', assignableRoles: ['user'], onCreated: vi.fn(), onClose: vi.fn() } as never), [], 'tr');
    expect(shell().textContent).toContain('Servis hesabı oluştur');
    expect(shell().textContent).not.toContain('Create a service account');
    expect(shell().textContent).not.toMatch(/programatik/i);
  });
});
