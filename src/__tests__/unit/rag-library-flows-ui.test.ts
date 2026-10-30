// @vitest-environment jsdom
/**
 * The three folder forms of the Documents tab, mounted on their own against a mocked `fetch`: a new folder, a rename
 * and a move of folders and documents. What each one sends, what keeps it from sending, and how it reports a refusal
 * of the server (in the form, in the server's own words).
 */

import { act, createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import RagFolderForm, { type FolderFlow } from '@/components/rag/library/RagFolderForm';
import type { MoveItems } from '@/components/rag/library/libraryModel';
import type { RagFolderView } from '@/components/rag/access/ragAccessApi';
import { buttonByText, click, installDomStubs, jsonResponse, mount, q, qa, setInput, text, wait, type ApiMock, type Mounted } from '../helpers/iamCenterUi';
import { until } from '../helpers/filesUploadDetailHarness';
import { ALL_FOLDERS, ARCHIVE, HANDBOOK, LEAVE, LEAVE_DOC, ONBOARDING, POLICIES, installKbApi } from '../helpers/ragLibraryFixtures';

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));

const onClose = vi.fn();
const onChanged = vi.fn(async () => undefined);

let mounted: Mounted | null = null;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  notify.show.mockClear();
  onClose.mockClear();
  onChanged.mockClear();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FOLDERS = '/api/rag/modules/kb/folders';
const MOVE = '/api/rag/modules/kb/documents/move';

async function open(flow: FolderFlow | null, options: { folders?: RagFolderView[]; accessEnabled?: boolean } = {}) {
  mounted = await mount(
    h(RagFolderForm, {
      flow,
      moduleKey: 'kb',
      moduleName: 'HR Policies',
      folders: options.folders ?? ALL_FOLDERS,
      accessEnabled: options.accessEnabled ?? false,
      onClose,
      onChanged,
    }),
  );
  if (flow) await until(() => Boolean(q('.form-overlay')), 'the form');
}

const overlay = () => q('.form-overlay')!;
const field = (label: string) => q<HTMLInputElement>(`input[aria-label="${label}"]`, overlay())!;
const primary = (label: string) => buttonByText(label, overlay())!;
/** A button that says why it is off is only marked, not disabled. */
const isOff = (button: HTMLElement) => button.getAttribute('aria-disabled') === 'true';

async function pressEnter(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

/** Opens a select of the form and picks an option by its label. */
async function choose(label: string, option: string) {
  await click(field(label));
  await wait(30);
  await click(qa('[role="option"]').find((o) => o.textContent?.trim() === option));
  await wait(30);
}

const optionLabels = () => qa('[role="option"]').map((o) => o.textContent?.trim());

describe('a form that is not asked for', () => {
  it('draws nothing while there is no flow', async () => {
    api = installKbApi();
    await open(null);
    expect(q('.form-overlay')).toBeNull();
    expect(api.calls).toHaveLength(0);
  });
});

describe('a new folder', () => {
  it('creates a folder at the top level, then asks the library to read again and closes', async () => {
    api = installKbApi();
    await open({ kind: 'create', parentId: null });
    expect(text()).toContain('New folder');
    expect(text()).toContain('HR Policies');
    expect(field('Location').value).toBe('Top level');
    // Nothing is typed yet: the button is off.
    expect(isOff(primary('Create folder'))).toBe(true);

    await setInput(field('Folder name'), '  Contracts  ');
    expect(isOff(primary('Create folder'))).toBe(false);
    await click(primary('Create folder'));
    await until(() => onClose.mock.calls.length === 1, 'the form to close');

    expect(api.to('POST', FOLDERS)).toHaveLength(1);
    // The name is trimmed, and the top level is a null parent.
    expect(api.to('POST', FOLDERS)[0]!.body).toEqual({ name: 'Contracts', parentId: null });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ color: 'green', title: 'Folder created' }));
  });

  it('starts in the folder it was opened from, and can be pointed at another place', async () => {
    api = installKbApi();
    await open({ kind: 'create', parentId: 'f-policies' });
    expect(field('Location').value).toBe('Policies');

    await choose('Location', 'Policies / Leave');
    expect(field('Location').value).toBe('Policies / Leave');
    await setInput(field('Folder name'), 'Sick leave');
    await click(primary('Create folder'));
    await until(() => api.to('POST', FOLDERS).length === 1, 'the request');
    expect(api.to('POST', FOLDERS)[0]!.body).toEqual({ name: 'Sick leave', parentId: 'f-leave' });
  });

  it('offers every folder as a place, and none that is only a name to the viewer', async () => {
    api = installKbApi();
    const folders = [...ALL_FOLDERS, { ...ARCHIVE, _id: 'f-legal', name: 'Legal', path: 'Legal', pathOnly: true as const }];
    await open({ kind: 'create', parentId: null }, { folders });
    await click(field('Location'));
    await wait(30);
    // Synced folders are places too: a new folder in one is allowed by the form (the server decides).
    expect(optionLabels()).toEqual(['Top level', 'Archive', 'HR Site', 'Onboarding', 'Policies', 'Policies / Leave']);
  });

  it('falls back to the top level when the folder it was opened from is gone', async () => {
    api = installKbApi();
    await open({ kind: 'create', parentId: 'deleted-folder' });
    expect(field('Location').value).toBe('Top level');
  });

  it('keeps names the server would refuse from being sent', async () => {
    api = installKbApi();
    await open({ kind: 'create', parentId: null });
    for (const bad of ['a/b', 'x'.repeat(201), '..', '.', '   ']) {
      await setInput(field('Folder name'), bad);
      expect(isOff(primary('Create folder')), JSON.stringify(bad)).toBe(true);
      await click(primary('Create folder'));
      await pressEnter(field('Folder name'));
    }
    await wait(50);
    expect(api.to('POST', FOLDERS)).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    // A name that is allowed turns it on again.
    await setInput(field('Folder name'), 'Plain name');
    expect(isOff(primary('Create folder'))).toBe(false);
  });

  it('saves on Enter in the name field', async () => {
    api = installKbApi();
    await open({ kind: 'create', parentId: null });
    await setInput(field('Folder name'), 'Quick folder');
    await pressEnter(field('Folder name'));
    await until(() => api.to('POST', FOLDERS).length === 1, 'the request');
    expect(api.to('POST', FOLDERS)[0]!.body).toEqual({ name: 'Quick folder', parentId: null });
  });

  it('shows the refusal of the server in the form, stays open, and clears it on the next try', async () => {
    api = installKbApi();
    api.on('POST', FOLDERS, () => jsonResponse({ error: 'A folder with this name already exists here' }, 409));
    await open({ kind: 'create', parentId: null });
    await setInput(field('Folder name'), 'Policies');
    await click(primary('Create folder'));
    await until(() => text().includes('A folder with this name already exists here'), 'the refusal');

    expect(onClose).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(notify.show).not.toHaveBeenCalled();
    expect(q('.form-overlay')).not.toBeNull();
    // The button works again.
    expect(isOff(primary('Create folder'))).toBe(false);

    api.on('POST', FOLDERS, () => jsonResponse({ folder: { _id: 'f-new', name: 'Policies 2026', path: 'Policies 2026', aclMode: 'inherit' } }, 201));
    await setInput(field('Folder name'), 'Policies 2026');
    await click(primary('Create folder'));
    await until(() => onClose.mock.calls.length === 1, 'the form to close');
    expect(text()).not.toContain('already exists here');
  });

  it('says a new folder follows its location\'s permissions only while access control is on', async () => {
    const hint = 'A new folder takes the permissions of its location until you give it its own.';
    api = installKbApi();
    await open({ kind: 'create', parentId: null }, { accessEnabled: true });
    expect(text()).toContain(hint);
    await mounted!.unmount();
    mounted = null;

    await open({ kind: 'create', parentId: null }, { accessEnabled: false });
    expect(text()).not.toContain(hint);
  });

  it('closes on Cancel without sending anything', async () => {
    api = installKbApi();
    await open({ kind: 'create', parentId: null });
    await setInput(field('Folder name'), 'Never saved');
    await click(buttonByText('Cancel', overlay()));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.to('POST', FOLDERS)).toHaveLength(0);
  });
});

describe('renaming a folder', () => {
  it('sends only the new name and says where the folder is', async () => {
    api = installKbApi();
    await open({ kind: 'rename', folder: LEAVE });
    expect(text()).toContain('Rename folder');
    // The subtitle is the whole path, so a folder is not mistaken for one of the same name elsewhere.
    expect(text()).toContain('Policies / Leave');
    expect(field('Folder name').value).toBe('Leave');
    expect(isOff(primary('Rename'))).toBe(true);

    // Only blanks around the same name: still nothing to save.
    await setInput(field('Folder name'), ' Leave ');
    expect(isOff(primary('Rename'))).toBe(true);

    await setInput(field('Folder name'), ' Time off ');
    expect(isOff(primary('Rename'))).toBe(false);
    await click(primary('Rename'));
    await until(() => onClose.mock.calls.length === 1, 'the form to close');

    const patches = api.to('PATCH', '/api/rag/modules/kb/folders/f-leave');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ name: 'Time off' });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ color: 'green', title: 'Folder renamed' }));
  });

  it('keeps an empty or forbidden name from being sent', async () => {
    api = installKbApi();
    await open({ kind: 'rename', folder: ARCHIVE });
    for (const bad of ['', 'Old/files', 'x'.repeat(201)]) {
      await setInput(field('Folder name'), bad);
      expect(isOff(primary('Rename')), JSON.stringify(bad)).toBe(true);
      await click(primary('Rename'));
    }
    await wait(50);
    expect(api.to('PATCH', '/api/rag/modules/kb/folders/f-archive')).toHaveLength(0);
  });

  it('saves on Enter, and shows a refusal in the form', async () => {
    api = installKbApi();
    api.on('PATCH', /^\/api\/rag\/modules\/kb\/folders\/[^/]+$/, () => jsonResponse({ error: 'A folder with this name already exists here' }, 409));
    await open({ kind: 'rename', folder: ARCHIVE });
    await setInput(field('Folder name'), 'Onboarding');
    await pressEnter(field('Folder name'));
    await until(() => text().includes('A folder with this name already exists here'), 'the refusal');
    expect(onClose).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('moving folders and documents', () => {
  const move = (over: Partial<MoveItems> = {}): FolderFlow => ({
    kind: 'move',
    items: { folders: [ONBOARDING], documents: [HANDBOOK], skipped: 0, ...over },
  });

  it('names what moves, offers the places it can go, and starts with no place chosen', async () => {
    api = installKbApi();
    await open(move());
    expect(text()).toContain('Move 2 items');
    expect(text()).toContain('Onboarding, employee-handbook-2026.pdf');
    expect(field('Destination').value).toBe('');
    expect(isOff(primary('Move'))).toBe(true);
    expect(text()).toContain('2 items will move.');

    await click(field('Destination'));
    await wait(30);
    // Not the moved folder itself, and not the folder a connected source owns.
    expect(optionLabels()).toEqual(['Top level', 'Archive', 'Policies', 'Policies / Leave']);
  });

  it('moves folders one by one, then the documents together, and closes', async () => {
    api = installKbApi();
    await open(move());
    await choose('Destination', 'Policies');
    expect(isOff(primary('Move'))).toBe(false);
    await click(primary('Move'));
    await until(() => onClose.mock.calls.length === 1, 'the form to close');

    const patches = api.to('PATCH', '/api/rag/modules/kb/folders/f-onboarding');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ parentId: 'f-policies' });
    const moves = api.to('POST', MOVE);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.body).toEqual({ documentIds: ['d-handbook'], folderId: 'f-policies' });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ color: 'green', title: 'Moved', message: '2 items moved.' }));
  });

  it('moves to the top level with a null folder', async () => {
    api = installKbApi();
    await open(move({ folders: [], documents: [LEAVE_DOC] }));
    await choose('Destination', 'Top level');
    // The document sits in Leave, so the top level is a real move.
    expect(isOff(primary('Move'))).toBe(false);
    await click(primary('Move'));
    await until(() => api.to('POST', MOVE).length === 1, 'the request');
    expect(api.to('POST', MOVE)[0]!.body).toEqual({ documentIds: ['d-leave'], folderId: null });
    expect(api.to('PATCH', /folders/)).toHaveLength(0);
  });

  it('will not move items to where they all are already', async () => {
    api = installKbApi();
    // Both sit at the top level.
    await open(move());
    await choose('Destination', 'Top level');
    expect(isOff(primary('Move'))).toBe(true);
    await click(primary('Move'));
    await wait(50);
    expect(api.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
    // Another place is a move.
    await choose('Destination', 'Archive');
    expect(isOff(primary('Move'))).toBe(false);
  });

  it('will not move a folder to the folder it is in', async () => {
    api = installKbApi();
    await open(move({ folders: [LEAVE], documents: [] }));
    await choose('Destination', 'Policies');
    expect(isOff(primary('Move'))).toBe(true);
    await choose('Destination', 'Top level');
    expect(isOff(primary('Move'))).toBe(false);
  });

  it('leaves out the places below a moved folder', async () => {
    api = installKbApi();
    await open(move({ folders: [POLICIES], documents: [] }));
    await click(field('Destination'));
    await wait(30);
    // Policies moves, so neither it nor Leave below it is a place.
    expect(optionLabels()).toEqual(['Top level', 'Archive', 'Onboarding']);
  });

  it('says how many selected items a connected source keeps, and moves the rest', async () => {
    api = installKbApi();
    await open(move({ skipped: 2 }));
    expect(text()).toContain('2 selected items from a connected source are left out: they change only in the source.');
    await mounted!.unmount();
    mounted = null;

    await open(move({ skipped: 1 }));
    expect(text()).toContain('1 selected item from a connected source is left out: it changes only in the source.');
    await choose('Destination', 'Archive');
    await click(primary('Move'));
    await until(() => api.to('POST', MOVE).length === 1, 'the request');
  });

  it('has nothing to move when everything selected belongs to a source', async () => {
    api = installKbApi();
    await open(move({ folders: [], documents: [], skipped: 1 }));
    expect(text()).toContain('Move items');
    expect(text()).toContain('Nothing will move.');
    expect(isOff(primary('Move'))).toBe(true);
    await click(primary('Move'));
    await wait(50);
    expect(api.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  it('says moved items take the permissions of their new folder only while access control is on', async () => {
    const hint = 'Items that inherit take the permissions of their new folder.';
    api = installKbApi();
    await open(move(), { accessEnabled: true });
    expect(text()).toContain(hint);
    await mounted!.unmount();
    mounted = null;

    await open(move(), { accessEnabled: false });
    expect(text()).not.toContain(hint);
  });

  it('stops at the first refusal, says how much had moved, and has the library read again', async () => {
    api = installKbApi();
    api.on('PATCH', '/api/rag/modules/kb/folders/f-archive', () => jsonResponse({ error: 'A folder with this name already exists here' }, 409));
    await open(move({ folders: [ONBOARDING, ARCHIVE], documents: [HANDBOOK] }));
    await choose('Destination', 'Policies');
    await click(primary('Move'));
    await until(() => text().includes('had moved before it'), 'the refusal');

    expect(text()).toContain('A folder with this name already exists here 1 of 3 items had moved before it.');
    expect(onClose).not.toHaveBeenCalled();
    // Onboarding moved before Archive was refused: the lists show the truth.
    expect(onChanged).toHaveBeenCalledTimes(1);
    // Documents go after folders, so nothing was sent for them.
    expect(api.to('POST', MOVE)).toHaveLength(0);
    expect(notify.show).not.toHaveBeenCalled();
  });

  it('does not read the lists again when the first request was refused', async () => {
    api = installKbApi();
    api.on('PATCH', '/api/rag/modules/kb/folders/f-onboarding', () => jsonResponse({ error: 'Folders can be nested at most 8 levels deep' }, 400));
    await open(move());
    await choose('Destination', 'Policies');
    await click(primary('Move'));
    await until(() => text().includes('nested at most 8 levels deep'), 'the refusal');

    expect(text()).not.toContain('had moved before it');
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
