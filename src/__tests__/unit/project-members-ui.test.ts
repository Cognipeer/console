// @vitest-environment jsdom
/**
 * The project members screen and its permission editor, rendered for real
 * (jsdom). Project levels are enforced now: each service is either Inherit (the
 * member's workspace level stands) or an explicit level, "No access" included.
 * The editor never shows an unset service as "None", shows the member's
 * workspace level next to the choice and saves only what was chosen.
 */

import { act, createElement, Fragment } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Notifications } from '@mantine/notifications';
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

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/projects/proj-a',
}));

import ProjectMembersManager from '@/components/projects/ProjectMembersManager';

let api: ApiMock;
let mounted: Mounted;

beforeAll(() => installDomStubs());

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// These render whole component trees (jsdom + Mantine); on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ALL = {
  canAssignMembers: true,
  canInviteMembers: true,
  canManagePermissions: true,
  canManageRoles: true,
  canRemoveMembers: true,
  isProjectAdmin: false,
  isTenantAdmin: true,
};

const MEMBERS = [
  { userId: 'u-owner', email: 'olive@example.com', name: 'Olive Owner', role: 'owner', projectRole: null, servicePermissions: null, implicit: true },
  // two limits: Read on Model Hub, an explicit "No access" on Agents
  { userId: 'u-ann', email: 'ann@example.com', name: 'Ann Lee', role: 'user', projectRole: 'member', servicePermissions: { models: 'read', agents: 'none' }, implicit: false },
  // an old "No access" on Agent Tools (the engine reads it as not set) next to a real one on Prompt Studio
  { userId: 'u-bob', email: 'bob@example.com', name: 'Bob Ray', role: 'user', projectRole: 'member', servicePermissions: { tools: 'none', prompts: 'none' }, ignoredServices: ['tools'], implicit: false },
  // nothing stored
  { userId: 'u-cy', email: 'cy@example.com', name: 'Cy Dunn', role: 'user', projectRole: 'project_admin', servicePermissions: {}, implicit: false },
  // "No access" on two services and nothing said about which of them the engine ignores (the members API does not say)
  { userId: 'u-dee', email: 'dee@example.com', name: 'Dee Fox', role: 'user', projectRole: 'member', servicePermissions: { tools: 'none', prompts: 'none', models: 'read' }, implicit: false },
];

/** The workspace level of a member, as the IAM center's principal view reports it. */
interface EffectiveRow {
  service: string;
  level: string;
  sources: Array<{ kind: string; label: string; level: string }>;
}
const workspaceDetail = (levels: Record<string, string>) => ({
  principal: { type: 'user', id: 'u', label: 'U' },
  effective: Object.entries(levels).map(([service, level]): EffectiveRow => ({ service, level, sources: [] })),
  groups: [],
  projects: [],
  policies: [],
});

function routes(extra: Array<[string, string | RegExp, RouteHandler]> = [], capabilities = ALL): Array<[string, string | RegExp, RouteHandler]> {
  return [
    ['GET', '/api/projects/proj-a/members', () => ({ capabilities, members: MEMBERS })],
    [
      'GET',
      /^\/api\/iam\/principals\/user\/u-ann$/,
      (c) => {
        const detail = workspaceDetail({ models: 'write', agents: 'write', tools: 'write', prompts: 'read' });
        // in the project, both of Ann's limits bite: the engine names the project as the source of the narrower level
        if (c.query.projectId === 'proj-a') {
          detail.effective = [
            { service: 'models', level: 'read', sources: [{ kind: 'role', label: 'user', level: 'write' }, { kind: 'project', label: 'Alpha', level: 'read' }] },
            { service: 'agents', level: 'none', sources: [{ kind: 'role', label: 'user', level: 'write' }, { kind: 'project', label: 'Alpha', level: 'none' }] },
            { service: 'tools', level: 'write', sources: [] },
            { service: 'prompts', level: 'read', sources: [] },
          ];
        }
        return detail;
      },
    ],
    ['GET', /^\/api\/iam\/principals\/user\/u-bob$/, () => workspaceDetail({ tools: 'write', prompts: 'write', models: 'write' })],
    ['GET', /^\/api\/iam\/principals\/user\/u-cy$/, () => workspaceDetail({ models: 'write' })],
    [
      'GET',
      /^\/api\/iam\/principals\/user\/u-dee$/,
      (c) => {
        const levels = { tools: 'write', prompts: 'write', models: 'write' };
        const detail = workspaceDetail(levels);
        // in the project, only the prompts "No access" narrows anything: the one on tools is not enforced
        if (c.query.projectId === 'proj-a') {
          detail.effective = [
            { service: 'tools', level: 'write', sources: [{ kind: 'role', label: 'user', level: 'write' }] },
            { service: 'prompts', level: 'none', sources: [{ kind: 'role', label: 'user', level: 'write' }, { kind: 'project', label: 'Alpha', level: 'none' }] },
            { service: 'models', level: 'read', sources: [{ kind: 'project', label: 'Alpha', level: 'read' }] },
          ];
        }
        return detail;
      },
    ],
    ['PATCH', '/api/projects/proj-a/members/permissions', () => ({ userProject: {} })],
    ...extra,
  ];
}

async function render(options: { extra?: Array<[string, string | RegExp, RouteHandler]>; capabilities?: typeof ALL; openMemberId?: string; readOnly?: boolean; locale?: string } = {}) {
  api = installApiMock(routes(options.extra, options.capabilities));
  mounted = await mount(
    createElement(
      Fragment,
      null,
      createElement(Notifications, null),
      createElement(ProjectMembersManager, { projectId: 'proj-a', openMemberId: options.openMemberId, readOnly: options.readOnly }),
    ),
    options.locale ?? 'en',
  );
  await settle(200);
}

const rowOf = (name: string) => qa('tr').find((r) => r.textContent?.includes(name))!;

async function openEditor(name: string) {
  const row = rowOf(name);
  const buttons = qa<HTMLButtonElement>('button', row);
  await click(buttons[buttons.length - 1]);
  await click(qa('[role="menuitem"]').find((m) => m.textContent === 'Project service permissions'));
  await settle(250);
}

const editorRow = (serviceId: string) => q(`.form-overlay tr[data-service="${serviceId}"]`)!;
const choiceOf = (serviceId: string): string | undefined =>
  qa<HTMLInputElement>('input[type="radio"]', editorRow(serviceId)).find((r) => r.checked)?.value;
async function choose(serviceId: string, choice: 'inherit' | 'none' | 'read' | 'write' | 'admin') {
  const radio = qa<HTMLInputElement>('input[type="radio"]', editorRow(serviceId)).find((r) => r.value === choice);
  expect(radio, `${serviceId} ${choice}`).toBeTruthy();
  await click(radio);
}

describe('the members table', () => {
  it('says what a project limits for each member, in plain words', async () => {
    await render();
    const cell = (name: string) => rowOf(name).textContent ?? '';
    // workspace owners and admins are never limited by a project
    expect(cell('Olive Owner')).toContain('Inherited from workspace role');
    expect(cell('Ann Lee')).toContain('2 project limits');
    // an old "No access" the engine ignores is not a limit; the real one is
    expect(cell('Bob Ray')).toContain('Prompt Studio: No access');
    expect(cell('Bob Ray')).not.toContain('Agent Tools');
    // nothing stored: the workspace level stands
    expect(cell('Cy Dunn')).toContain('Same as the workspace level');
    // columns speak of the workspace, not the tenant
    const headers = qa('th').map((h) => h.textContent?.trim());
    expect(headers).toEqual(expect.arrayContaining(['Member', 'Workspace role', 'Project role', 'Project limits']));
    expect(text()).not.toMatch(/Tenant/);
  });

  it('never offers the permission editor for a workspace owner or admin, whoever is looking', async () => {
    await render();
    // an owner is not limited by projects: no row menu at all
    expect(qa<HTMLButtonElement>('button', rowOf('Olive Owner'))).toHaveLength(0);
    // an ordinary member has the menu, with the editor in it
    const row = rowOf('Ann Lee');
    const buttons = qa<HTMLButtonElement>('button', row);
    await click(buttons[buttons.length - 1]);
    expect(qa('[role="menuitem"]').map((m) => m.textContent)).toContain('Project service permissions');
  });

  it('only offers the permission editor to people who may edit permissions', async () => {
    await render({ capabilities: { ...ALL, canManagePermissions: false } });
    const row = rowOf('Ann Lee');
    const buttons = qa<HTMLButtonElement>('button', row);
    await click(buttons[buttons.length - 1]);
    expect(qa('[role="menuitem"]').map((m) => m.textContent)).not.toContain('Project service permissions');
  });
});

describe('the permission editor', () => {
  it('is a full-screen form with a choice per service: Inherit, No access, Read, Write, Admin', async () => {
    await render();
    await openEditor('Ann Lee');
    const overlay = q('.form-overlay')!;
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Project permissions: Ann Lee');
    expect(overlay.textContent).toContain('Project levels are enforced');
    expect(overlay.textContent).toContain('never widens it');
    const labels = qa('label', editorRow('models')).map((l) => l.textContent);
    expect(labels).toEqual(['Inherit', 'No access', 'Read', 'Write', 'Admin']);
  });

  it('never shows an unset service as "None": it reads Inherit, and stored levels read as what they are', async () => {
    await render();
    await openEditor('Ann Lee');
    expect(choiceOf('models')).toBe('read');
    expect(choiceOf('agents')).toBe('none'); // an explicit "No access"
    expect(choiceOf('prompts')).toBe('inherit'); // not stored: not "None"
    expect(choiceOf('tools')).toBe('inherit');
  });

  it('shows the member\'s workspace level next to the choice, and the level they end up with', async () => {
    await render();
    await openEditor('Ann Lee');
    expect(api.to('GET', '/api/iam/principals/user/u-ann').length).toBeGreaterThan(0);
    // the badges of the cell, left to right: the workspace level and, when the project narrows it, the level here
    const level = (id: string) => qa('.mantine-Badge-label', q('[data-testid="level-cell"]', editorRow(id))!).map((b) => b.textContent);
    // Model Hub: workspace Write, limited to Read here -> Read
    expect(level('models')).toEqual(['Write', 'Read']);
    // Agents: workspace Write, "No access" here -> No access
    expect(level('agents')).toEqual(['Write', 'No access']);
    // Prompt Studio: workspace Read, inherited: just Read
    expect(level('prompts')).toEqual(['Read']);
    // above the workspace level: changes nothing, and says so
    await choose('prompts', 'write');
    expect(level('prompts')).toEqual(['Read']);
    expect(q('[data-testid="level-cell"]', editorRow('prompts'))!.textContent).toContain('no effect');
    expect(q('[data-testid="no-effect"]', editorRow('prompts'))).not.toBeNull();
    // back to Inherit: the note goes
    await choose('prompts', 'inherit');
    expect(q('[data-testid="no-effect"]', editorRow('prompts'))).toBeNull();
  });

  it('saves only the explicit choices - a service put back to Inherit is not sent', async () => {
    await render();
    await openEditor('Ann Lee');
    await choose('models', 'inherit'); // was Read
    await choose('tools', 'write'); // new
    await click(buttonByText('Save permissions', q('.form-footer')!));
    await settle(150);
    const patches = api.to('PATCH', '/api/projects/proj-a/members/permissions');
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ userId: 'u-ann', servicePermissions: { agents: 'none', tools: 'write' } });
    // the editor closed and the list was reloaded
    expect(q('.form-overlay')).toBeNull();
    expect(api.to('GET', '/api/projects/proj-a/members').length).toBeGreaterThan(1);
  });

  it('a service touched and put back to Inherit saves as nothing, not as an explicit "No access"', async () => {
    await render();
    await openEditor('Cy Dunn');
    await choose('models', 'none');
    await choose('models', 'inherit');
    // nothing differs from what is stored: nothing to save
    expect(buttonByText('Save permissions', q('.form-footer')!)!.hasAttribute('disabled')).toBe(true);
    await choose('prompts', 'read');
    await click(buttonByText('Save permissions', q('.form-footer')!));
    await settle(150);
    expect(api.to('PATCH', '/api/projects/proj-a/members/permissions')[0].body).toEqual({ userId: 'u-cy', servicePermissions: { prompts: 'read' } });
  });

  it('shows an old "No access" the engine ignores as Inherit and drops it on save', async () => {
    await render();
    await openEditor('Bob Ray');
    expect(choiceOf('tools')).toBe('inherit'); // stored as none, but not enforced
    expect(choiceOf('prompts')).toBe('none'); // enforced
    await choose('models', 'read');
    await click(buttonByText('Save permissions', q('.form-footer')!));
    await settle(150);
    expect(api.to('PATCH', '/api/projects/proj-a/members/permissions')[0].body).toEqual({
      userId: 'u-bob',
      servicePermissions: { prompts: 'none', models: 'read' },
    });
  });

  it('summarizes the limits and the unsaved changes in the side pane', async () => {
    await render();
    await openEditor('Ann Lee');
    const pane = () => q('.form-summary')!.textContent ?? '';
    expect(pane()).toContain('Model Hub');
    expect(pane()).toContain('No changes yet.');
    await choose('tools', 'admin');
    expect(pane()).toContain('Agent Tools: Inherit → Admin');
    expect(q('.form-footer')!.textContent).toContain('3 service(s) limited in this project');
  });

  it('filters the services by name, and to the ones limited here', async () => {
    await render();
    await openEditor('Ann Lee');
    const rows = () => qa('.form-overlay tbody tr').length;
    const total = rows();
    expect(total).toBeGreaterThan(30);
    await setInput(q<HTMLInputElement>('.form-overlay input[placeholder="Search services"]')!, 'model hub');
    expect(rows()).toBe(1);
    await setInput(q<HTMLInputElement>('.form-overlay input[placeholder="Search services"]')!, '');
    await click(qa<HTMLLabelElement>('.form-overlay label').find((l) => l.textContent?.startsWith('Limited here')));
    expect(rows()).toBe(2); // Model Hub and Agents
  });

  it('asks before throwing unsaved changes away', async () => {
    await render();
    await openEditor('Ann Lee');
    await click(buttonByText('Cancel', q('.form-footer')!)); // untouched: closes at once
    await settle(30);
    expect(q('.form-overlay')).toBeNull();
    await openEditor('Ann Lee');
    await choose('tools', 'read');
    await click(buttonByText('Cancel', q('.form-footer')!));
    await settle(30);
    expect(text()).toContain('Discard your changes?');
    await click(buttonByText('Keep editing', q('[role="dialog"]')!));
    await settle(30);
    expect(q('.form-overlay')).not.toBeNull();
    expect(choiceOf('tools')).toBe('read');
  });

  it('works without the workspace levels for somebody who cannot read the IAM center', async () => {
    await render({ extra: [['GET', /^\/api\/iam\/principals\/user\/u-ann$/, () => jsonResponse({ error: 'Forbidden', code: 'forbidden' }, 403)]] });
    await openEditor('Ann Lee');
    expect(q('[data-testid="workspace-unavailable"]')).not.toBeNull();
    // no workspace column: just the choice
    expect(qa('.form-overlay th').map((h) => h.textContent)).toEqual(['Service', 'In this project']);
    expect(choiceOf('models')).toBe('read');
    await choose('tools', 'read');
    await click(buttonByText('Save permissions', q('.form-footer')!));
    await settle(150);
    expect(api.to('PATCH', '/api/projects/proj-a/members/permissions')[0].body).toEqual({
      userId: 'u-ann',
      servicePermissions: { models: 'read', agents: 'none', tools: 'read' },
    });
  });

  it('shows the error when saving fails and keeps the editor open', async () => {
    await render({ extra: [['PATCH', '/api/projects/proj-a/members/permissions', () => jsonResponse({ error: 'Membership not found' }, 404)]] });
    await openEditor('Ann Lee');
    await choose('tools', 'read');
    await click(buttonByText('Save permissions', q('.form-footer')!));
    await settle(150);
    expect(q('.form-overlay')).not.toBeNull();
    expect(text()).toContain('Membership not found');
  });
});

describe('the permission editor (Escape)', () => {
  const escape = async (target: Element) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await settle(60);
  };

  it('closes an untouched editor', async () => {
    await render();
    await openEditor('Ann Lee');
    expect(q('.form-overlay')).not.toBeNull();
    await escape(document.body);
    expect(q('.form-overlay')).toBeNull();
  });

  it('asks before leaving with unsaved changes, and Escape on that question does not ask again', async () => {
    await render();
    await openEditor('Ann Lee');
    await choose('tools', 'read');
    await escape(document.body);
    expect(qa('[role="dialog"]').filter((d) => d.textContent?.includes('Discard your changes?'))).toHaveLength(1);
    await escape(q('[role="dialog"]')!);
    expect(qa('[role="dialog"]').filter((d) => d.textContent?.includes('Discard your changes?'))).toHaveLength(0);
    expect(q('.form-overlay')).not.toBeNull();
    expect(choiceOf('tools')).toBe('read');
  });
});

describe('a "No access" saved before project levels were enforced', () => {
  const principalCalls = (id: string) => api.to('GET', new RegExp(`^/api/iam/principals/user/${id}$`));

  it('shows as Inherit when the effective permissions say no project setting narrows that service - and is dropped on save', async () => {
    await render();
    await openEditor('Dee Fox');
    // the workspace view and the view of this project, to tell the setting that bites from the one that does not
    expect(principalCalls('u-dee').map((c) => c.query.projectId ?? '').sort()).toEqual(['', 'proj-a']);
    expect(choiceOf('tools')).toBe('inherit'); // stored as none, not enforced
    expect(choiceOf('prompts')).toBe('none'); // enforced: the project narrows it
    expect(choiceOf('models')).toBe('read');
    expect(q('[data-testid="ignored-note"]')!.textContent).toContain('1 older "No access" setting(s)');
    // nothing was changed by hand, yet the stored map still carries the dead entry: saving cleans it up
    const save = buttonByText('Save permissions', q('.form-footer')!)!;
    expect(save.hasAttribute('disabled')).toBe(false);
    expect(q('.form-summary')!.textContent).toContain('No changes yet.');
    await click(save);
    await settle(150);
    expect(api.to('PATCH', '/api/projects/proj-a/members/permissions')[0].body).toEqual({
      userId: 'u-dee',
      servicePermissions: { prompts: 'none', models: 'read' },
    });
  });

  it('leaves a choice alone that was changed by hand before the answer arrived', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await render({
      extra: [
        [
          'GET',
          /^\/api\/iam\/principals\/user\/u-dee$/,
          async (c) => {
            if (c.query.projectId === 'proj-a') await gate; // the project view is slow
            return {
              ...workspaceDetail({ tools: 'write', prompts: 'write', models: 'write' }),
              effective:
                c.query.projectId === 'proj-a'
                  ? [{ service: 'tools', level: 'write', sources: [] }, { service: 'prompts', level: 'none', sources: [{ kind: 'project', label: 'Alpha', level: 'none' }] }]
                  : [{ service: 'tools', level: 'write', sources: [] }, { service: 'prompts', level: 'write', sources: [] }, { service: 'models', level: 'write', sources: [] }],
            };
          },
        ],
      ],
    });
    await openEditor('Dee Fox');
    expect(choiceOf('tools')).toBe('none'); // as stored, until the project view says it has no effect
    await choose('tools', 'read'); // touched by hand first
    release();
    await settle(300);
    expect(choiceOf('tools')).toBe('read');
    // the other dead entry (none here) is not affected: prompts is enforced
    expect(choiceOf('prompts')).toBe('none');
  });

  it('is left as stored on a service the member does not reach anyway (it changes nothing either way)', async () => {
    await render({
      extra: [
        [
          'GET',
          /^\/api\/iam\/principals\/user\/u-dee$/,
          (c) => ({
            ...workspaceDetail({}),
            effective: c.query.projectId === 'proj-a' ? [] : [{ service: 'tools', level: 'none', sources: [] }, { service: 'prompts', level: 'write', sources: [] }],
          }),
        ],
      ],
    });
    await openEditor('Dee Fox');
    expect(choiceOf('tools')).toBe('none'); // workspace level none: nothing to infer from
    expect(choiceOf('prompts')).toBe('inherit'); // reachable in the workspace and not narrowed: not enforced
  });

  it('does not ask for the project view when the members API already says which ones are ignored, or when nothing is stored as none', async () => {
    await render();
    await openEditor('Bob Ray'); // the API declared ignoredServices
    expect(principalCalls('u-bob').filter((c) => c.query.projectId)).toHaveLength(0);
    await click(buttonByText('Cancel', q('.form-footer')!));
    await settle(50);
    await openEditor('Ann Lee'); // two limits, one of them none... but read-only otherwise
    expect(principalCalls('u-ann').filter((c) => c.query.projectId).length).toBe(1);
    await click(buttonByText('Cancel', q('.form-footer')!));
    await settle(50);
    await openEditor('Cy Dunn'); // nothing stored
    expect(principalCalls('u-cy').filter((c) => c.query.projectId)).toHaveLength(0);
  });

  it('shows the entry as stored when the person cannot read the effective permissions (the members API is then the only source)', async () => {
    await render({ extra: [['GET', /^\/api\/iam\/principals\/user\/u-dee$/, () => jsonResponse({ error: 'Forbidden', code: 'forbidden' }, 403)]] });
    await openEditor('Dee Fox');
    expect(choiceOf('tools')).toBe('none');
    expect(q('[data-testid="ignored-note"]')).toBeNull();
  });
});

describe('the deep link of an access check', () => {
  it('opens the editor of that member as soon as the list has loaded', async () => {
    await render({ openMemberId: 'u-ann' });
    await settle(250);
    expect(q('.form-overlay')!.textContent).toContain('Project permissions: Ann Lee');
  });

  it('does not open an editor for a member who cannot be edited, or when the person may not edit', async () => {
    await render({ openMemberId: 'u-owner' });
    expect(q('.form-overlay')).toBeNull();
    await mounted.unmount();
    await render({ openMemberId: 'u-ann', capabilities: { ...ALL, canManagePermissions: false } });
    expect(q('.form-overlay')).toBeNull();
  });

  it('opens only once: closing it leaves it closed', async () => {
    await render({ openMemberId: 'u-ann' });
    await settle(250);
    await click(buttonByText('Cancel', q('.form-footer')!));
    await settle(80);
    expect(q('.form-overlay')).toBeNull();
  });
});

describe('Turkish', () => {
  it('renders the table and the editor in Turkish with no raw translation keys', async () => {
    await render({ locale: 'tr' });
    expect(text()).toContain('Çalışma alanı rolü');
    expect(text()).toContain('Proje sınırları');
    expect(rowOf('Ann Lee').textContent).toContain('2 proje sınırı');
    expect(rowOf('Cy Dunn').textContent).toContain('Çalışma alanı düzeyiyle aynı');
    const row = rowOf('Ann Lee');
    const buttons = qa<HTMLButtonElement>('button', row);
    await click(buttons[buttons.length - 1]);
    await click(qa('[role="menuitem"]').find((m) => m.textContent === 'Proje servis izinleri'));
    await settle(250);
    const overlay = q('.form-overlay')!.textContent ?? '';
    expect(overlay).toContain('Proje izinleri: Ann Lee');
    expect(overlay).toContain('Proje düzeyleri uygulanır');
    expect(qa('label', editorRow('models')).map((l) => l.textContent)).toEqual(['Devral', 'Erişim yok', 'Okuma', 'Yazma', 'Yönetici']);
    expect(overlay).not.toMatch(/projectMembers\.|iamApi\./);
  });
});
