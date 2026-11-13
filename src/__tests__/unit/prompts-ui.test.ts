// @vitest-environment jsdom
/**
 * The Prompt Studio screens against a mocked `fetch`: the list (with its stat tiles and filter), the create flow of the
 * editor, the detail page (prompt, versions, comments), adding and deleting a comment, and the states for a prompt
 * that cannot be loaded. The screens read and write through React Query (`src/lib/api/queries/prompts.ts`); these
 * tests pin what a person sees, so they hold whichever way the data is fetched.
 */

import { createElement as h } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  q,
  qa,
  setInput,
  settle,
  text,
  type ApiMock,
} from '../helpers/iamCenterUi';
import { renderWithQuery, type RenderedWithQuery } from '../helpers/renderWithQuery';

const nav = vi.hoisted(() => ({ id: 'p1' }));
const push = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/prompts',
  useParams: () => ({ id: nav.id }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));
vi.mock('@/components/playground', () => ({ Playground: () => null }));

import PromptsPage from '@/app/dashboard/prompts/page';
import PromptDetailPage from '@/app/dashboard/prompts/[id]/page';

let rendered: RenderedWithQuery;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => {
  nav.id = 'p1';
  push.mockClear();
  notify.show.mockClear();
});
afterEach(async () => {
  await rendered?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/* ── Fixtures ────────────────────────────────────────────────────────────── */

function promptView(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    tenantId: 't1',
    projectId: 'proj1',
    name: 'Support tone',
    key: 'support-tone',
    description: 'How support answers',
    template: 'Hello {{name}}, how can I help?',
    currentVersion: 2,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...over,
  };
}

const STATS = {
  overview: { totalPrompts: 2, totalVersions: 7, totalVariablePrompts: 1, avgVersionsPerPrompt: 3.5 },
  recentlyUpdated: [],
  versionDistribution: [],
};

function versionView(over: Record<string, unknown> = {}) {
  return {
    id: 'v2',
    promptId: 'p1',
    version: 2,
    isLatest: true,
    template: 'Hello {{name}}, how can I help?',
    comment: 'second draft',
    createdAt: '2026-11-01T10:00:00.000Z',
    ...over,
  };
}

function commentView(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    promptId: 'p1',
    content: 'Looks good to me',
    authorEmail: 'ada@example.com',
    createdAt: '2026-11-02T10:00:00.000Z',
    ...over,
  };
}

/** A server with a prompt list that creates and edits what it is sent. */
function mockPromptServer(initial = [promptView({ id: 'p1' }), promptView({ id: 'p2', name: 'Sales pitch', key: 'sales-pitch', description: '' })]) {
  const prompts = [...initial];
  const comments = [commentView()];
  const mock = installApiMock([
    ['GET', '/api/prompts', () => ({ prompts })],
    ['GET', '/api/prompts/stats', () => STATS],
    [
      'POST',
      '/api/prompts',
      (call) => {
        const body = call.body as { name: string; template: string; key?: string };
        const created = promptView({ id: 'p3', name: body.name, key: body.key ?? 'new-prompt', template: body.template, currentVersion: 1 });
        prompts.unshift(created);
        return jsonResponse({ prompt: created }, 201);
      },
    ],
    ['GET', '/api/prompts/p1', () => ({ prompt: prompts.find((p) => p.id === 'p1') })],
    ['GET', '/api/prompts/p1/versions', () => ({ versions: [versionView()] })],
    ['GET', '/api/prompts/p1/comments', () => ({ comments })],
    [
      'POST',
      '/api/prompts/p1/comments',
      (call) => {
        const created = commentView({ id: 'c2', content: (call.body as { content: string }).content });
        comments.unshift(created);
        return jsonResponse({ comment: created }, 201);
      },
    ],
    [
      'DELETE',
      '/api/prompts/p1/comments/c1',
      () => {
        comments.splice(0, comments.length, ...comments.filter((c) => c.id !== 'c1'));
        return { success: true };
      },
    ],
    [
      'PATCH',
      '/api/prompts/p1',
      (call) => {
        const body = call.body as { name: string; template: string };
        const index = prompts.findIndex((p) => p.id === 'p1');
        prompts[index] = { ...prompts[index], ...body, currentVersion: 3 };
        return jsonResponse({ prompt: prompts[index] });
      },
    ],
  ]);
  return { mock, prompts, comments };
}

const placeholder = (value: string) => q<HTMLInputElement | HTMLTextAreaElement>(`[placeholder="${value}"]`);

/* ── List ────────────────────────────────────────────────────────────────── */

describe('Prompt Studio list', () => {
  it('shows the prompts and the stat tiles', async () => {
    ({ mock: api } = mockPromptServer());
    rendered = await renderWithQuery(h(PromptsPage));
    await settle(50);

    expect(text()).toContain('Support tone');
    expect(text()).toContain('Sales pitch');
    expect(text()).toContain('support-tone');
    expect(text()).toContain('Showing 2 of 2 prompts');
    // The tiles: total versions and variable prompts come from the stats call.
    expect(text()).toContain('7');
    expect(api.to('GET', '/api/prompts')).toHaveLength(1);
    expect(api.to('GET', '/api/prompts/stats')).toHaveLength(1);
  });

  it('narrows the list by the filter box', async () => {
    mockPromptServer();
    rendered = await renderWithQuery(h(PromptsPage));
    await settle(50);

    await setInput(placeholder('Filter by name, key, or description…')!, 'sales');
    await settle(50);

    expect(text()).toContain('Sales pitch');
    expect(text()).not.toContain('Support tone');
    expect(text()).toContain('Showing 1 of 2 prompts');
  });

  it('shows the empty state when the list cannot be loaded', async () => {
    installApiMock([
      ['GET', '/api/prompts', () => jsonResponse({ error: 'boom' }, 500)],
      ['GET', '/api/prompts/stats', () => jsonResponse({ error: 'boom' }, 500)],
    ]);
    rendered = await renderWithQuery(h(PromptsPage));
    await settle(50);

    expect(text()).toContain('No prompts yet');
  });

  it('creates a prompt from the editor and shows it in the list', async () => {
    ({ mock: api } = mockPromptServer());
    rendered = await renderWithQuery(h(PromptsPage));
    await settle(50);

    await click(buttonByText('Create prompt'));
    await settle(50);
    await setInput(placeholder('Enter a prompt name') as HTMLInputElement, 'Greeting');
    await setInput(placeholder('Write your prompt template') as HTMLTextAreaElement, 'Hi {{who}}');
    const submit = qa<HTMLButtonElement>('button').filter((b) => b.textContent?.trim() === 'Create prompt').pop();
    await click(submit);
    await settle(100);

    const posts = api.to('POST', '/api/prompts');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ name: 'Greeting', template: 'Hi {{who}}' });
    expect(text()).toContain('Greeting');
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Prompt saved' }));
  });

  it('refreshes the list and the tiles from the refresh button', async () => {
    ({ mock: api } = mockPromptServer());
    rendered = await renderWithQuery(h(PromptsPage));
    await settle(50);

    const refresh = qa<HTMLButtonElement>('button').find((b) => /refresh/i.test(b.getAttribute('aria-label') ?? b.title ?? ''));
    expect(refresh, 'a refresh button').toBeDefined();
    await click(refresh);
    await settle(50);

    expect(api.to('GET', '/api/prompts')).toHaveLength(2);
    expect(api.to('GET', '/api/prompts/stats')).toHaveLength(2);
  });
});

/* ── Detail ──────────────────────────────────────────────────────────────── */

describe('Prompt detail page', () => {
  it('shows the prompt, and asks for its versions and comments', async () => {
    ({ mock: api } = mockPromptServer());
    rendered = await renderWithQuery(h(PromptDetailPage));
    await settle(50);

    expect(text()).toContain('Support tone');
    expect(text()).toContain('Hello {{name}}, how can I help?');
    expect(api.to('GET', '/api/prompts/p1')).toHaveLength(1);
    expect(api.to('GET', '/api/prompts/p1/versions')).toHaveLength(1);
    expect(api.to('GET', '/api/prompts/p1/comments')).toHaveLength(1);
  });

  it('says so when the prompt does not exist', async () => {
    installApiMock([
      ['GET', '/api/prompts/p1', () => jsonResponse({ error: 'Prompt not found' }, 404)],
      ['GET', '/api/prompts/p1/versions', () => jsonResponse({ error: 'Prompt not found' }, 404)],
      ['GET', '/api/prompts/p1/comments', () => jsonResponse({ error: 'Prompt not found' }, 404)],
    ]);
    rendered = await renderWithQuery(h(PromptDetailPage));
    await settle(50);

    expect(text()).toContain('This prompt could not be found.');
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Unable to load prompt', color: 'red' }));
  });

  it('keeps the page when only versions and comments fail', async () => {
    mockPromptServer();
    api = installApiMock([
      ['GET', '/api/prompts/p1', () => ({ prompt: promptView() })],
      ['GET', '/api/prompts/p1/versions', () => jsonResponse({ error: 'x' }, 500)],
      ['GET', '/api/prompts/p1/comments', () => jsonResponse({ error: 'x' }, 500)],
    ]);
    rendered = await renderWithQuery(h(PromptDetailPage));
    await settle(50);

    expect(text()).toContain('Support tone');
    expect(text()).not.toContain('This prompt could not be found.');
  });

  it('adds a comment and shows it', async () => {
    ({ mock: api } = mockPromptServer());
    rendered = await renderWithQuery(h(PromptDetailPage));
    await settle(50);

    await setInput(placeholder('Add a comment about this prompt...') as HTMLTextAreaElement, '  Ship it  ');
    await click(buttonByText('Add Comment'));
    await settle(100);

    const posts = api.to('POST', '/api/prompts/p1/comments');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ content: 'Ship it' });
    expect(text()).toContain('Ship it');
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Comment added' }));
  });

  it('tells the person when a comment could not be saved', async () => {
    ({ mock: api } = mockPromptServer());
    api.on('POST', '/api/prompts/p1/comments', () => jsonResponse({ error: 'nope' }, 500));
    rendered = await renderWithQuery(h(PromptDetailPage));
    await settle(50);

    await setInput(placeholder('Add a comment about this prompt...') as HTMLTextAreaElement, 'Ship it');
    await click(buttonByText('Add Comment'));
    await settle(100);

    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to add comment', color: 'red' }));
  });

  it('deletes a comment after confirmation', async () => {
    ({ mock: api } = mockPromptServer());
    rendered = await renderWithQuery(h(PromptDetailPage));
    await settle(50);
    expect(text()).toContain('Looks good to me');

    const trash = q('.tabler-icon-trash')?.closest('button');
    expect(trash, 'the delete button of the comment').toBeTruthy();
    await click(trash);
    await settle(50);
    await click(buttonByText('Delete'));
    await settle(100);

    expect(api.to('DELETE', '/api/prompts/p1/comments/c1')).toHaveLength(1);
    expect(text()).not.toContain('Looks good to me');
  });

  it('refreshes all three reads from the refresh button', async () => {
    ({ mock: api } = mockPromptServer());
    rendered = await renderWithQuery(h(PromptDetailPage));
    await settle(50);

    await click(buttonByText('Refresh'));
    await settle(100);

    expect(api.to('GET', '/api/prompts/p1')).toHaveLength(2);
    expect(api.to('GET', '/api/prompts/p1/versions')).toHaveLength(2);
    expect(api.to('GET', '/api/prompts/p1/comments')).toHaveLength(2);
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Data refreshed' }));
  });

  it('saves an edit from the editor and shows the new name', async () => {
    ({ mock: api } = mockPromptServer());
    rendered = await renderWithQuery(h(PromptDetailPage));
    await settle(50);

    await click(buttonByText('Edit prompt'));
    await settle(50);
    await setInput(placeholder('Enter a prompt name') as HTMLInputElement, 'Support voice');
    await click(buttonByText('Save changes'));
    await settle(150);

    const patches = api.to('PATCH', '/api/prompts/p1');
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ name: 'Support voice' });
    expect(text()).toContain('Support voice');
  });
});
