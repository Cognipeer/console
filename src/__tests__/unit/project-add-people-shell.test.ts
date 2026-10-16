// @vitest-environment jsdom
/**
 * The "Add people" form of a project: whose list it searches (the project's own candidate list for a project
 * admin, who cannot read the workspace's IAM directory; the directory for owners and admins), what it says
 * while the search is too short or fails, and that a person who cannot be picked stays readable with a reason.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
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
import { PEOPLE } from '../helpers/iamDirectoryFixtures';
import AddProjectMembersShell from '@/components/projects/AddProjectMembersShell';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/projects/p-1',
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

const NONE = { userIds: new Set<string>(), groupIds: new Set<string>(), adminIds: new Set<string>() };

async function show(props: { canAddGroups: boolean; existing?: typeof NONE }, routes: Route[]) {
  api = installApiMock(routes);
  mounted = await mount(
    createElement(AddProjectMembersShell, {
      open: true,
      projectId: 'p-1',
      projectName: 'Alpha',
      existing: props.existing ?? NONE,
      canAddGroups: props.canAddGroups,
      onClose: vi.fn(),
      onDone: vi.fn(),
    }),
  );
  await settle(80);
}

const shell = () => q('.form-overlay')!;
const search = () => q<HTMLInputElement>('input[aria-label="Search"]', shell())!;
const checkbox = (label: string) => qa<HTMLInputElement>('input[type="checkbox"]', shell()).find((c) => c.getAttribute('aria-label') === label);
const candidatesCalls = () => api.to('GET', '/api/projects/p-1/member-candidates');
const ANN = { _id: 'u-ann', email: 'ann@example.com', name: 'Ann Lee' };

describe('AddProjectMembersShell for a project admin', () => {
  it('searches the project candidate list from two letters on, never the IAM directory', async () => {
    await show({ canAddGroups: false }, [['GET', '/api/projects/p-1/member-candidates', () => ({ users: [ANN] })]]);

    // nothing typed: say what to do, ask nothing
    expect(q('[data-testid="find-empty"]', shell())?.textContent).toBe('Type at least 2 letters to search.');
    expect(candidatesCalls()).toHaveLength(0);

    await setInput(search(), 'a');
    await settle(700);
    expect(candidatesCalls()).toHaveLength(0);
    expect(q('[data-testid="find-empty"]', shell())?.textContent).toBe('Type at least 2 letters to search.');

    await setInput(search(), 'an');
    await settle(700);
    expect(candidatesCalls().map((c) => c.query.q)).toEqual(['an']);
    expect(api.to('GET', '/api/iam/principals')).toHaveLength(0);
    const ann = checkbox('Ann Lee');
    expect(ann).toBeTruthy();
    expect(ann!.disabled).toBe(false);
    expect(text()).toContain('ann@example.com');
  });

  it('adds the person found, with the default role', async () => {
    await show({ canAddGroups: false }, [
      ['GET', '/api/projects/p-1/member-candidates', () => ({ users: [ANN] })],
      ['POST', '/api/projects/p-1/members/bulk', () => ({ added: 1, removed: 0, updated: 0, warnings: [] })],
    ]);
    await setInput(search(), 'ann');
    await settle(700);
    await click(checkbox('Ann Lee'));
    await click(qa<HTMLButtonElement>('button', shell()).find((b) => b.textContent?.trim() === 'Add 1'));
    await settle(80);
    expect(api.to('POST', '/api/projects/p-1/members/bulk')[0]?.body).toEqual({ add: [{ userId: 'u-ann', role: 'member' }] });
  });

  it('says so when the search is refused, instead of an empty list', async () => {
    await show({ canAddGroups: false }, [['GET', '/api/projects/p-1/member-candidates', () => jsonResponse({ error: 'Forbidden' }, 403)]]);
    await setInput(search(), 'ann');
    await settle(700);
    const empty = q('[data-testid="find-empty"]', shell())!;
    expect(empty.textContent).toBe('Forbidden');
  });

  it('falls back to a plain sentence when the server gives no reason', async () => {
    await show({ canAddGroups: false }, [['GET', '/api/projects/p-1/member-candidates', () => jsonResponse({}, 500)]]);
    await setInput(search(), 'ann');
    await settle(700);
    expect(q('[data-testid="find-empty"]', shell())?.textContent).toBe('The search failed. Try again.');
  });

  it('says nobody matched when the list is empty', async () => {
    await show({ canAddGroups: false }, [['GET', '/api/projects/p-1/member-candidates', () => ({ users: [] })]]);
    await setInput(search(), 'zz');
    await settle(700);
    expect(candidatesCalls()).toHaveLength(1);
    expect(q('[data-testid="find-empty"]', shell())?.textContent).not.toBe('Type at least 2 letters to search.');
    expect(q('[data-testid="find-empty"]', shell())?.textContent).not.toBe('');
  });
});

describe('AddProjectMembersShell for an owner or admin', () => {
  const [owner, admin, ann] = [PEOPLE[0], PEOPLE[1], PEOPLE[2]];

  it('searches the IAM directory and keeps the people who cannot be picked readable, with the reason', async () => {
    await show(
      {
        canAddGroups: true,
        existing: { userIds: new Set(['u-ann']), groupIds: new Set<string>(), adminIds: new Set(['u-admin', 'u-owner']) },
      },
      [['GET', '/api/iam/principals', () => ({ items: [owner, admin, ann, PEOPLE[3]], nextCursor: null })]],
    );
    await settle(700);
    expect(api.to('GET', '/api/iam/principals').length).toBeGreaterThan(0);
    expect(candidatesCalls()).toHaveLength(0);

    const locked = qa('[data-testid="locked-person"]', shell());
    expect(locked.map((row) => q('input[type="checkbox"]', row)?.getAttribute('aria-label'))).toEqual(['Olive Owner', 'Ada Admin', 'Ann Lee']);
    for (const row of locked) {
      expect(q<HTMLInputElement>('input[type="checkbox"]', row)!.disabled).toBe(true);
      // the row is not dimmed as a whole: the name stays as readable as any other
      expect((row as HTMLElement).style.opacity).toBe('');
    }
    expect(locked[0]!.textContent).toContain('Implicit access (admin)');
    expect(locked[2]!.textContent).toContain('Already in the project');

    // the invited person is free to pick
    expect(checkbox('Ivy Invited')!.disabled).toBe(false);
    expect(qa('[data-testid="locked-person"]', shell())).toHaveLength(3);
  });
});
