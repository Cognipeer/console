// @vitest-environment jsdom
/**
 * The prompt version history modal against a mocked `fetch`: the versions and deployments it reads when it opens,
 * restoring a version, a deployment action, and the message of a refused one. The reads and writes go through
 * `src/lib/api/queries/promptVersions.ts`; these tests pin what a person sees.
 */

import { act, createElement as h } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonByText, click, installApiMock, installDomStubs, jsonResponse, qa, settle, text, type ApiMock } from '../helpers/iamCenterUi';
import { renderWithQuery, type RenderedWithQuery } from '../helpers/renderWithQuery';

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));

import PromptVersionHistoryModal from '@/components/prompts/PromptVersionHistoryModal';
import { promptsKeys, useUpdatePrompt } from '@/lib/api/queries/prompts';
import { promptVersionKeys, usePromptVersionHistory } from '@/lib/api/queries/promptVersions';
import type { PromptView } from '@/lib/services/prompts';

let rendered: RenderedWithQuery;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => notify.show.mockClear());
afterEach(async () => {
  await rendered?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const PROMPT = { id: 'p1', name: 'Greeter' } as unknown as PromptView;

function version(id: string, n: number, latest: boolean) {
  return { id, version: n, isLatest: latest, name: 'Greeter', template: `template ${n}`, createdAt: '2026-01-01T00:00:00.000Z', comment: `comment ${n}` };
}

let versions: ReturnType<typeof version>[];

function mockApi(extra: Array<[string, string, (call: never) => unknown]> = []) {
  api = installApiMock([
    ['GET', '/api/prompts/p1/versions', () => ({ versions })],
    ['GET', '/api/prompts/p1/deployments', () => ({ deployments: { dev: { rolloutStatus: 'active', activeVersionId: 'v2' } }, history: [] })],
    ...(extra as never[]),
  ]);
}

async function open(props: Record<string, unknown> = {}) {
  rendered = await renderWithQuery(h(PromptVersionHistoryModal, { opened: true, onClose: () => {}, prompt: PROMPT, ...props }));
  await settle(50);
}

describe('PromptVersionHistoryModal', () => {
  beforeEach(() => {
    versions = [version('v2', 2, true), version('v1', 1, false)];
  });

  it('reads the versions and the deployments when it opens, and selects the latest version', async () => {
    mockApi();
    await open();
    expect(api.to('GET', '/api/prompts/p1/versions')).toHaveLength(1);
    expect(api.to('GET', '/api/prompts/p1/deployments')).toHaveLength(1);
    expect(text()).toContain('Version History - Greeter');
    expect(text()).toContain('Version 2');
    expect(text()).toContain('Current Version');
  });

  it('asks for nothing while it is closed', async () => {
    mockApi();
    await open({ opened: false });
    expect(api.calls).toHaveLength(0);
  });

  it('restores an earlier version, reloads the history and tells the page', async () => {
    mockApi([['POST', '/api/prompts/p1/versions', () => { versions = [version('v3', 3, true), version('v2', 2, false), version('v1', 1, false)]; return { prompt: {} }; }]]);
    const onVersionRestored = vi.fn();
    await open({ onVersionRestored });
    await click(document.querySelector<HTMLElement>('[aria-label="Select version 1"]')!);
    await click(buttonByText('Set as Latest'));
    await settle(50);
    expect(api.to('POST', '/api/prompts/p1/versions')[0]?.body).toEqual({ versionId: 'v1' });
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Version restored', message: 'Restored to version 1' }));
    expect(onVersionRestored).toHaveBeenCalledTimes(1);
    expect(api.to('GET', '/api/prompts/p1/versions')).toHaveLength(2);
    expect(api.to('GET', '/api/prompts/p1/deployments')).toHaveLength(2);
    // the new latest version is selected again
    expect(text()).toContain('Version 3');
  });

  it('shows the server message when a version cannot be restored', async () => {
    mockApi([['POST', '/api/prompts/p1/versions', () => jsonResponse({ error: 'Version is locked' }, 409)]]);
    const onVersionRestored = vi.fn();
    await open({ onVersionRestored });
    await click(document.querySelector<HTMLElement>('[aria-label="Select version 1"]')!);
    await click(buttonByText('Set as Latest'));
    await settle(50);
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Unable to restore version', message: 'Version is locked', color: 'red' }));
    expect(onVersionRestored).not.toHaveBeenCalled();
  });

  it('promotes the selected version to an environment and reloads versions and deployments', async () => {
    mockApi([['POST', '/api/prompts/p1/deployments', () => ({ ok: true })]]);
    await open();
    await click(buttonByText('Promote'));
    await settle(50);
    expect(api.to('POST', '/api/prompts/p1/deployments')[0]?.body).toEqual({ action: 'promote', environment: 'dev', versionId: 'v2' });
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Deployment updated', message: 'promote completed for dev.' }));
    expect(api.to('GET', '/api/prompts/p1/versions')).toHaveLength(2);
    expect(api.to('GET', '/api/prompts/p1/deployments')).toHaveLength(2);
  });

  it('shows the server message when a deployment action is refused', async () => {
    mockApi([['POST', '/api/prompts/p1/deployments', () => jsonResponse({ error: 'Nothing to roll back' }, 400)]]);
    await open();
    await click(buttonByText('Rollback'));
    await settle(50);
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Deployment action failed', message: 'Nothing to roll back', color: 'red' }));
  });

  it('compares the selected version with another and shows the result', async () => {
    mockApi([
      [
        'GET',
        '/api/prompts/p1/compare',
        () => ({
          comparison: {
            fromVersion: { version: 2 },
            toVersion: { version: 1 },
            templateDiff: [{ type: 'added', line: 'hello' }, { type: 'removed', line: 'bye' }],
            deploymentHistory: [],
            comments: [],
          },
        }),
      ],
    ]);
    await open();
    const compareInput = document.querySelector<HTMLInputElement>('input[placeholder="Select another version"]')!;
    await click(compareInput);
    await settle(20);
    await click(qa('[role="option"]').find((o) => o.textContent?.startsWith('v1'))!);
    await click(buttonByText('Compare'));
    await settle(50);
    expect(api.to('GET', '/api/prompts/p1/compare')[0]?.query).toEqual({ fromVersionId: 'v2', toVersionId: 'v1' });
    expect(text()).toContain('v2 ↔ v1');
    expect(text()).toContain('No deployment history for selected versions.');
  });

  it('says why a comparison failed', async () => {
    mockApi([['GET', '/api/prompts/p1/compare', () => jsonResponse({ error: 'Versions belong to another prompt' }, 400)]]);
    await open();
    await click(document.querySelector<HTMLInputElement>('input[placeholder="Select another version"]')!);
    await settle(20);
    await click(qa('[role="option"]').find((o) => o.textContent?.startsWith('v1'))!);
    await click(buttonByText('Compare'));
    await settle(50);
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Compare failed', message: 'Versions belong to another prompt' }));
  });
});

describe('the version history keys', () => {
  it('sit under the prompt keys, so the prompt mutations that reread or drop a prompt reach them', async () => {
    const project = 'project:0';
    const detail = promptsKeys.detail(project, 'p1');
    expect(promptVersionKeys.history(project, 'p1').slice(0, promptsKeys.versions(project, 'p1').length)).toEqual([...promptsKeys.versions(project, 'p1')]);
    expect(promptVersionKeys.deployments(project, 'p1').slice(0, detail.length)).toEqual([...detail]);

    mockApiOnly();
    const probe = { current: undefined as unknown as { history: ReturnType<typeof usePromptVersionHistory>; update: ReturnType<typeof useUpdatePrompt> } };
    function Probe() {
      probe.current = { history: usePromptVersionHistory('p1', true), update: useUpdatePrompt() };
      return null;
    }
    rendered = await renderWithQuery(h(Probe));
    await settle(50);
    expect(api.to('GET', '/api/prompts/p1/versions')).toHaveLength(1);
    // saving a prompt edit rereads the versions of that prompt, the history the modal shows included
    await act(async () => {
      await probe.current.update.mutateAsync({ id: 'p1', name: 'Greeter', template: 't' });
    });
    await settle(50);
    expect(api.to('GET', '/api/prompts/p1/versions')).toHaveLength(2);
  });
});

function mockApiOnly() {
  api = installApiMock([
    ['GET', '/api/prompts/p1/versions', () => ({ versions: [version('v1', 1, true)] })],
    ['PATCH', '/api/prompts/p1', () => ({ prompt: { id: 'p1', name: 'Greeter' } })],
  ]);
}
