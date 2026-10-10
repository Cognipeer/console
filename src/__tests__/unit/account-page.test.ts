// @vitest-environment jsdom
/**
 * "My account": every signed-in person's own page. A local account edits its
 * name and changes its password; a directory account (LDAP, SSO) sees what is
 * managed elsewhere and is told so; a service account has no password.
 */
import { createElement } from 'react';
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
} from '../helpers/iamCenterUi';
import { parseMe, passwordIssue, passwordProblems, passwordUnavailable } from '@/components/account/accountModel';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: router.refresh }),
  usePathname: () => '/dashboard/account',
  useSearchParams: () => new URLSearchParams(),
}));

import AccountPage from '@/app/dashboard/account/page';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  router.refresh.mockClear();
});

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const LOCAL = {
  userId: 'u1',
  name: 'Ann Lee',
  email: 'ann@example.com',
  role: 'admin',
  authProvider: 'local',
  canLogin: true,
  canChangePassword: true,
  managedFields: [],
};

async function renderPage(me: unknown | (() => unknown), locale = 'en', extra: Parameters<typeof installApiMock>[0] = []) {
  api = installApiMock([
    ['GET', '/api/auth/me', () => (typeof me === 'function' ? (me as () => unknown)() : me)],
    ['PATCH', '/api/auth/profile', () => ({ ok: true })],
    ['POST', '/api/auth/change-password', () => ({ success: true })],
    ...extra,
  ]);
  mounted = await mount(createElement(AccountPage), locale);
  await settle(50);
}

describe('the account model', () => {
  it('reads /api/auth/me tolerantly and decides what is managed elsewhere', () => {
    expect(parseMe(null)).toBeNull();
    expect(parseMe({ name: 'no id' })).toBeNull();
    expect(parseMe(LOCAL)).toMatchObject({ userId: 'u1', authProvider: 'local', canChangePassword: true });
    // no word from the server: a directory account keeps its fields in the directory
    expect(parseMe({ userId: 'u', authProvider: 'oidc' })).toMatchObject({
      canChangePassword: false,
      managedFields: ['name', 'email', 'password'],
    });
    expect(parseMe({ userId: 'u', authProvider: 'weird' })?.authProvider).toBe('local');
  });

  it('checks the same password rules the server enforces', () => {
    expect(passwordProblems('abc')).toEqual(['length', 'upper', 'digit', 'special']);
    expect(passwordProblems('Abcdef1!')).toEqual([]);
    expect(passwordIssue({ current: '', next: 'Abcdef1!', confirm: 'Abcdef1!' })).toBe('currentRequired');
    expect(passwordIssue({ current: 'x', next: 'weak', confirm: 'weak' })).toBe('weak');
    expect(passwordIssue({ current: 'x', next: 'Abcdef1!', confirm: 'Abcdef1?' })).toBe('mismatch');
    expect(passwordIssue({ current: 'x', next: 'Abcdef1!', confirm: 'Abcdef1!' })).toBeNull();
  });

  it('explains why there is no password form', () => {
    expect(passwordUnavailable(parseMe(LOCAL)!)).toBeNull();
    expect(passwordUnavailable(parseMe({ ...LOCAL, authProvider: 'ldap', canChangePassword: false })!)).toBe('managed');
    expect(passwordUnavailable(parseMe({ ...LOCAL, canLogin: false })!)).toBe('service');
  });
});

describe('a local account', () => {
  it('shows the profile, keeps the email and the role read-only and links to the personal tokens', async () => {
    await renderPage(LOCAL);
    const name = q<HTMLInputElement>('[data-testid="name-input"]')!;
    expect(name.value).toBe('Ann Lee');
    const email = qa<HTMLInputElement>('input').find((i) => i.value === 'ann@example.com')!;
    expect(email.disabled).toBe(true);
    expect(text()).toContain('Admin');
    expect(text()).toContain('Local account');
    expect(q('[data-testid="managed-note"]')).toBeNull();
    const link = qa<HTMLAnchorElement>('a').find((a) => a.textContent === 'Open API tokens');
    expect(link?.getAttribute('href')).toBe('/dashboard/tokens');
    expect(api.to('GET', '/api/auth/me')).toHaveLength(1);
  });

  it('saves the name only once it changed and is valid, then reloads the account and the top bar', async () => {
    await renderPage(LOCAL);
    const save = () => buttonByText('Save changes') as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    const name = q<HTMLInputElement>('[data-testid="name-input"]')!;
    await setInput(name, 'A');
    expect(save().disabled).toBe(true);
    expect(text()).toContain('Use 2 to 120 characters.');

    await setInput(name, '  Ann L.  ');
    expect(save().disabled).toBe(false);
    await click(save());
    await settle(30);
    expect(api.to('PATCH', '/api/auth/profile')).toHaveLength(1);
    expect(api.to('PATCH', '/api/auth/profile')[0]?.body).toEqual({ name: 'Ann L.' });
    expect(api.to('GET', '/api/auth/me')).toHaveLength(2);
    // the server layout (the name in the top bar) is asked again as well
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('says so when the server refuses the name', async () => {
    await renderPage(LOCAL, 'en', [['PATCH', '/api/auth/profile', () => jsonResponse({ error: 'managed', code: 'directory_managed' }, 409)]]);
    await setInput(q<HTMLInputElement>('[data-testid="name-input"]')!, 'New Name');
    await click(buttonByText('Save changes'));
    await settle(30);
    expect(text()).toContain('This account is managed by your directory. Change it there.');
    // nothing was saved: nothing to refresh
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('changes the password only with the current one, a strong new one and a matching confirmation', async () => {
    await renderPage(LOCAL);
    const [current, next, confirm] = qa<HTMLInputElement>('input[type="password"]');
    const submit = () => buttonByText('Change password') as HTMLButtonElement;
    expect(submit().disabled).toBe(true);

    await setInput(current!, 'old-secret');
    await setInput(next!, 'weak');
    expect(submit().disabled).toBe(true);
    // the checklist shows what is still missing
    expect(q('[data-rule="length"]')?.getAttribute('data-met')).toBeNull();
    await setInput(next!, 'Str0ng!pass');
    expect(q('[data-rule="length"]')?.getAttribute('data-met')).toBe('true');
    expect(q('[data-rule="special"]')?.getAttribute('data-met')).toBe('true');

    await setInput(confirm!, 'Str0ng!pasx');
    expect(text()).toContain('The passwords do not match');
    expect(submit().disabled).toBe(true);

    await setInput(confirm!, 'Str0ng!pass');
    expect(submit().disabled).toBe(false);
    await click(submit());
    await settle(30);
    const calls = api.to('POST', '/api/auth/change-password');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ currentPassword: 'old-secret', newPassword: 'Str0ng!pass' });
    // the form is emptied afterwards
    expect(qa<HTMLInputElement>('input[type="password"]').every((i) => i.value === '')).toBe(true);
  });

  it.each([
    ['a wrong current password', 401, { error: 'Invalid current password', code: 'invalid_current_password' }, 'The current password is not correct.'],
    ['the attempt limit', 429, { error: 'Too many', code: 'rate_limited' }, 'Too many attempts. Try again later.'],
    ['a password the server rejects', 400, { error: 'Password must contain', code: 'invalid_password' }, 'The new password does not meet the requirements.'],
  ])('words %s', async (_label, status, body, expected) => {
    await renderPage(LOCAL, 'en', [['POST', '/api/auth/change-password', () => jsonResponse(body, status)]]);
    const [current, next, confirm] = qa<HTMLInputElement>('input[type="password"]');
    await setInput(current!, 'old-secret');
    await setInput(next!, 'Str0ng!pass');
    await setInput(confirm!, 'Str0ng!pass');
    await click(buttonByText('Change password'));
    await settle(30);
    expect(q('[role="alert"]')?.textContent).toBe(expected);
  });

  it('renders in Turkish', async () => {
    await renderPage(LOCAL, 'tr');
    expect(text()).toContain('Hesabım');
    expect(text()).toContain('Parola');
    expect(text()).toContain('API token\'larını aç');
    expect(text()).not.toContain('My account');
  });
});

describe('a directory account', () => {
  const LDAP = { ...LOCAL, authProvider: 'ldap', canChangePassword: false, managedFields: ['name', 'email', 'password'] };

  it('locks the name, says who manages it and offers no way to save', async () => {
    await renderPage(LDAP);
    expect(q('[data-testid="managed-note"]')?.textContent).toContain('Managed by LDAP');
    expect(q<HTMLInputElement>('[data-testid="name-locked"]')?.disabled).toBe(true);
    expect(q('[data-testid="name-input"]')).toBeNull();
    expect(buttonByText('Save changes')).toBeUndefined();
  });

  it('does not offer a password form: it says where the password lives', async () => {
    await renderPage(LDAP);
    expect(qa('input[type="password"]')).toHaveLength(0);
    expect(q('[data-testid="password-managed"]')?.textContent).toContain('signs in through LDAP');
    expect(buttonByText('Change password')).toBeUndefined();
  });

  it('names single sign-on providers', async () => {
    await renderPage({ ...LDAP, authProvider: 'oidc' });
    expect(q('[data-testid="managed-note"]')?.textContent).toContain('Managed by SSO (OIDC)');
  });
});

describe('a service account', () => {
  it('has no password to change, and says why', async () => {
    await renderPage({ ...LOCAL, canLogin: false, canChangePassword: false });
    expect(qa('input[type="password"]')).toHaveLength(0);
    expect(q('[data-testid="password-service"]')?.textContent).toContain('service account');
  });
});

describe('when the account cannot be loaded', () => {
  it('shows an error with a retry that asks again', async () => {
    let fail = true;
    await renderPage(() => (fail ? jsonResponse({ error: 'boom' }, 500) : LOCAL));
    expect(text()).toContain('Your account could not be loaded');
    fail = false;
    await click(buttonByText('Try again'));
    await settle(30);
    expect(q('[data-testid="name-input"]')).not.toBeNull();
    expect(api.to('GET', '/api/auth/me')).toHaveLength(2);
  });
});
