/**
 * Unit tests — promptService
 * Tests: listPrompts, getPromptById, getPromptByKey,
 *        createPrompt, updatePrompt, deletePrompt,
 *        listPromptVersions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import {
  listPrompts,
  getPromptById,
  getPromptByKey,
  createPrompt,
  updatePrompt,
  deletePrompt,
  listPromptVersions,
} from '@/lib/services/prompts/promptService';
import type { IPrompt, IPromptVersion } from '@/lib/database';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';
const PROMPT_ID = 'prompt-1';

function makePrompt(overrides: Partial<IPrompt> = {}): IPrompt {
  return {
    _id: PROMPT_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key: 'my-prompt',
    name: 'My Prompt',
    description: 'A test prompt',
    template: 'Hello, {{name}}!',
    metadata: {},
    currentVersion: 1,
    createdBy: USER_ID,
    updatedBy: USER_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeVersion(overrides: Partial<IPromptVersion> = {}): IPromptVersion {
  return {
    _id: 'version-1',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    promptId: PROMPT_ID,
    version: 1,
    name: 'My Prompt',
    template: 'Hello, {{name}}!',
    metadata: {},
    createdBy: USER_ID,
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ── listPrompts ───────────────────────────────────────────────────────────────

describe('listPrompts', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listPrompts.mockResolvedValue([makePrompt()]);
  });

  it('calls switchToTenant', async () => {
    await listPrompts(TENANT_DB, PROJECT_ID);
    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
  });

  it('returns serialized prompts with id field', async () => {
    const result = await listPrompts(TENANT_DB, PROJECT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(PROMPT_ID);
    expect((result[0] as unknown as Record<string, unknown>)['_id']).toBeUndefined();
  });

  it('returns empty array when no prompts', async () => {
    db.listPrompts.mockResolvedValue([]);
    const result = await listPrompts(TENANT_DB, PROJECT_ID);
    expect(result).toHaveLength(0);
  });

  it('passes search option to db.listPrompts', async () => {
    await listPrompts(TENANT_DB, PROJECT_ID, { search: 'hello' });
    expect(db.listPrompts).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'hello' }),
    );
  });
});

// ── getPromptById ─────────────────────────────────────────────────────────────

describe('getPromptById', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns serialized prompt when found', async () => {
    db.findPromptById.mockResolvedValue(makePrompt());
    const result = await getPromptById(TENANT_DB, PROJECT_ID, PROMPT_ID);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(PROMPT_ID);
  });

  it('returns null when prompt not found', async () => {
    db.findPromptById.mockResolvedValue(null);
    const result = await getPromptById(TENANT_DB, PROJECT_ID, 'missing');
    expect(result).toBeNull();
  });
});

// ── getPromptByKey ────────────────────────────────────────────────────────────

describe('getPromptByKey', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns serialized prompt by key', async () => {
    db.findPromptByKey.mockResolvedValue(makePrompt());
    const result = await getPromptByKey(TENANT_DB, PROJECT_ID, 'my-prompt');
    expect(result!.key).toBe('my-prompt');
  });

  it('returns null when key is not found', async () => {
    db.findPromptByKey.mockResolvedValue(null);
    const result = await getPromptByKey(TENANT_DB, PROJECT_ID, 'unknown');
    expect(result).toBeNull();
  });
});

// ── createPrompt ──────────────────────────────────────────────────────────────

describe('createPrompt', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findPromptByKey.mockResolvedValue(null); // key not taken
    db.createPrompt.mockResolvedValue(makePrompt());
    db.createPromptVersion.mockResolvedValue(makeVersion());
  });

  it('creates a prompt and returns a serialized view', async () => {
    const result = await createPrompt(TENANT_DB, TENANT_ID, PROJECT_ID, USER_ID, {
      name: 'My Prompt',
      template: 'Hello, {{name}}!',
    });

    expect(db.createPrompt).toHaveBeenCalledTimes(1);
    expect(result.id).toBe(PROMPT_ID);
    expect(result.name).toBe('My Prompt');
  });

  it('creates version 1 alongside the prompt', async () => {
    await createPrompt(TENANT_DB, TENANT_ID, PROJECT_ID, USER_ID, {
      name: 'My Prompt',
      template: 'Hello!',
    });

    expect(db.createPromptVersion).toHaveBeenCalledTimes(1);
    const versionCall = db.createPromptVersion.mock.calls[0][0];
    expect(versionCall.version).toBe(1);
  });

  it('uses slugified key when name is provided without explicit key', async () => {
    await createPrompt(TENANT_DB, TENANT_ID, PROJECT_ID, USER_ID, {
      name: 'My Test Prompt',
      template: 'Hi!',
    });

    // key generated from name should be 'my-test-prompt'
    const promptCall = db.createPrompt.mock.calls[0][0];
    expect(promptCall.key).toBe('my-test-prompt');
  });

  it('uses explicit key when provided', async () => {
    await createPrompt(TENANT_DB, TENANT_ID, PROJECT_ID, USER_ID, {
      name: 'Test',
      key: 'custom-key',
      template: 'Hi!',
    });

    const promptCall = db.createPrompt.mock.calls[0][0];
    expect(promptCall.key).toBe('custom-key');
  });

  it('appends numeric suffix when key is already taken', async () => {
    db.findPromptByKey.mockResolvedValueOnce(makePrompt()); // first attempt taken
    db.findPromptByKey.mockResolvedValue(null); // second attempt available

    await createPrompt(TENANT_DB, TENANT_ID, PROJECT_ID, USER_ID, {
      name: 'My Prompt',
      template: 'Hi!',
    });

    const promptCall = db.createPrompt.mock.calls[0][0];
    // key should have a suffix like 'my-prompt-2'
    expect(promptCall.key).toMatch(/^my-prompt-\d+$/);
  });
});

// ── updatePrompt ──────────────────────────────────────────────────────────────

describe('updatePrompt', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns updated view and creates new version', async () => {
    db.findPromptById.mockResolvedValue(makePrompt({ currentVersion: 1 }));
    db.updatePrompt.mockResolvedValue(makePrompt({ name: 'Updated', currentVersion: 2 }));
    db.createPromptVersion.mockResolvedValue(makeVersion({ version: 2 }));

    const result = await updatePrompt(TENANT_DB, PROJECT_ID, PROMPT_ID, {
      name: 'Updated',
      updatedBy: USER_ID,
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe('Updated');
    expect(db.createPromptVersion).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2 }),
    );
  });

  it('returns null when prompt not found', async () => {
    db.findPromptById.mockResolvedValue(null);

    const result = await updatePrompt(TENANT_DB, PROJECT_ID, 'missing', {
      name: 'X',
    });

    expect(result).toBeNull();
  });

  it('returns null when db.updatePrompt returns null', async () => {
    db.findPromptById.mockResolvedValue(makePrompt());
    db.updatePrompt.mockResolvedValue(null);

    const result = await updatePrompt(TENANT_DB, PROJECT_ID, PROMPT_ID, {
      name: 'Nope',
    });

    expect(result).toBeNull();
  });
});

// ── deletePrompt ──────────────────────────────────────────────────────────────

describe('deletePrompt', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.deletePromptVersions.mockResolvedValue(0);
    db.deletePrompt.mockResolvedValue(true);
  });

  it('deletes prompt versions before deleting the prompt', async () => {
    await deletePrompt(TENANT_DB, PROJECT_ID, PROMPT_ID);
    expect(db.deletePromptVersions).toHaveBeenCalledBefore?.(db.deletePrompt);
    expect(db.deletePromptVersions).toHaveBeenCalledTimes(1);
    expect(db.deletePrompt).toHaveBeenCalledTimes(1);
  });

  it('returns true when deletion succeeds', async () => {
    db.deletePrompt.mockResolvedValue(true);
    const result = await deletePrompt(TENANT_DB, PROJECT_ID, PROMPT_ID);
    expect(result).toBe(true);
  });

  it('returns false when prompt was not found', async () => {
    db.deletePrompt.mockResolvedValue(false);
    const result = await deletePrompt(TENANT_DB, PROJECT_ID, 'missing');
    expect(result).toBe(false);
  });
});

// ── listPromptVersions ────────────────────────────────────────────────────────

describe('listPromptVersions', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns empty array when prompt does not exist', async () => {
    db.findPromptById.mockResolvedValue(null);
    const result = await listPromptVersions(TENANT_DB, PROJECT_ID, PROMPT_ID);
    expect(result).toHaveLength(0);
  });

  it('returns serialized versions when prompt exists', async () => {
    db.findPromptById.mockResolvedValue(makePrompt({ currentVersion: 2 }));
    db.listPromptVersions.mockResolvedValue([makeVersion(), makeVersion({ _id: 'v2', version: 2 })]);

    const result = await listPromptVersions(TENANT_DB, PROJECT_ID, PROMPT_ID);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBeDefined();
  });

  it('marks the latest version appropriately', async () => {
    db.findPromptById.mockResolvedValue(makePrompt({ currentVersion: 2 }));
    db.listPromptVersions.mockResolvedValue([
      makeVersion({ version: 1 }),
      makeVersion({ _id: 'v2', version: 2 }),
    ]);

    const result = await listPromptVersions(TENANT_DB, PROJECT_ID, PROMPT_ID);
    const latest = result.find((v) => v.version === 2);
    expect(latest?.isLatest).toBe(true);
    const older = result.find((v) => v.version === 1);
    expect(older?.isLatest).toBe(false);
  });
});
