/**
 * Unit tests — ProjectService
 * Tests: normalizeProjectKey (pure), ensureDefaultProject, listAccessibleProjects, generateUniqueProjectKey
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import {
  normalizeProjectKey,
  ensureDefaultProject,
  listAccessibleProjects,
  generateUniqueProjectKey,
  DEFAULT_PROJECT_KEY,
  DEFAULT_PROJECT_NAME,
} from '@/lib/services/projects/projectService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const CREATED_BY = 'user-1';

const MOCK_DEFAULT_PROJECT = {
  _id: 'proj-default',
  tenantId: TENANT_ID,
  key: DEFAULT_PROJECT_KEY,
  name: DEFAULT_PROJECT_NAME,
  description: 'Automatically created project',
  createdBy: CREATED_BY,
  updatedBy: CREATED_BY,
};

// ── normalizeProjectKey (pure function) ───────────────────────────────────────

describe('normalizeProjectKey', () => {
  it('lowercases input', () => {
    expect(normalizeProjectKey('MyProject')).toBe('myproject');
  });

  it('replaces spaces with hyphens', () => {
    expect(normalizeProjectKey('my project name')).toBe('my-project-name');
  });

  it('strips special characters', () => {
    expect(normalizeProjectKey('Hello World!')).toBe('hello-world');
  });

  it('returns default key for empty string', () => {
    expect(normalizeProjectKey('')).toBe(DEFAULT_PROJECT_KEY);
  });

  it('returns default key for whitespace-only string', () => {
    expect(normalizeProjectKey('   ')).toBe(DEFAULT_PROJECT_KEY);
  });

  it('handles already-valid slug', () => {
    expect(normalizeProjectKey('my-project')).toBe('my-project');
  });

  it('collapses multiple spaces to single hyphen', () => {
    expect(normalizeProjectKey('a   b   c')).toBe('a-b-c');
  });
});

// ── ensureDefaultProject ──────────────────────────────────────────────────────

describe('ensureDefaultProject', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns existing project when it already exists', async () => {
    db.findProjectByKey.mockResolvedValue(MOCK_DEFAULT_PROJECT);

    const result = await ensureDefaultProject(TENANT_DB, TENANT_ID, CREATED_BY);

    expect(db.createProject).not.toHaveBeenCalled();
    expect(result.key).toBe(DEFAULT_PROJECT_KEY);
  });

  it('calls assignProjectIdToLegacyRecords when existing project has _id', async () => {
    db.findProjectByKey.mockResolvedValue(MOCK_DEFAULT_PROJECT);

    await ensureDefaultProject(TENANT_DB, TENANT_ID, CREATED_BY);

    expect(db.assignProjectIdToLegacyRecords).toHaveBeenCalledWith(
      TENANT_ID,
      MOCK_DEFAULT_PROJECT._id,
    );
  });

  it('creates default project when it does not exist', async () => {
    db.findProjectByKey.mockResolvedValue(null);
    db.createProject.mockResolvedValue(MOCK_DEFAULT_PROJECT);

    const result = await ensureDefaultProject(TENANT_DB, TENANT_ID, CREATED_BY);

    expect(db.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        key: DEFAULT_PROJECT_KEY,
        name: DEFAULT_PROJECT_NAME,
        createdBy: CREATED_BY,
      }),
    );
    expect(result.key).toBe(DEFAULT_PROJECT_KEY);
  });

  it('switches to correct tenant DB', async () => {
    db.findProjectByKey.mockResolvedValue(MOCK_DEFAULT_PROJECT);

    await ensureDefaultProject(TENANT_DB, TENANT_ID, CREATED_BY);

    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
  });
});

// ── listAccessibleProjects ────────────────────────────────────────────────────

describe('listAccessibleProjects', () => {
  let db: ReturnType<typeof createMockDb>;

  const ALL_PROJECTS = [
    { _id: 'proj-1', tenantId: TENANT_ID, key: 'default', name: 'Default', createdBy: 'u1', updatedBy: 'u1' },
    { _id: 'proj-2', tenantId: TENANT_ID, key: 'research', name: 'Research', createdBy: 'u1', updatedBy: 'u1' },
    { _id: 'proj-3', tenantId: TENANT_ID, key: 'prod', name: 'Production', createdBy: 'u1', updatedBy: 'u1' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listProjects.mockResolvedValue(ALL_PROJECTS);
  });

  it('returns all projects for owner role', async () => {
    const projects = await listAccessibleProjects(TENANT_DB, TENANT_ID, {
      role: 'owner',
      projectIds: [],
    });
    expect(projects).toHaveLength(3);
  });

  it('returns all projects for admin role', async () => {
    const projects = await listAccessibleProjects(TENANT_DB, TENANT_ID, {
      role: 'admin',
      projectIds: [],
    });
    expect(projects).toHaveLength(3);
  });

  it('filters projects by projectIds for regular user', async () => {
    const projects = await listAccessibleProjects(TENANT_DB, TENANT_ID, {
      role: 'user',
      projectIds: ['proj-1', 'proj-3'],
    });
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p._id)).toEqual(['proj-1', 'proj-3']);
  });

  it('returns empty array when user has no project access', async () => {
    const projects = await listAccessibleProjects(TENANT_DB, TENANT_ID, {
      role: 'user',
      projectIds: [],
    });
    expect(projects).toHaveLength(0);
  });

  it('returns empty array when user projectIds do not match any existing projects', async () => {
    const projects = await listAccessibleProjects(TENANT_DB, TENANT_ID, {
      role: 'user',
      projectIds: ['nonexistent-id'],
    });
    expect(projects).toHaveLength(0);
  });
});

// ── generateUniqueProjectKey ──────────────────────────────────────────────────

describe('generateUniqueProjectKey', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns the base key when no project exists with that key', async () => {
    db.findProjectByKey.mockResolvedValue(null);

    const key = await generateUniqueProjectKey(TENANT_DB, TENANT_ID, 'My Project');

    expect(key).toBe('my-project');
    expect(db.findProjectByKey).toHaveBeenCalledTimes(1);
  });

  it('appends a numeric suffix when base key is already taken', async () => {
    db.findProjectByKey
      .mockResolvedValueOnce(MOCK_DEFAULT_PROJECT) // 'my-project' taken
      .mockResolvedValueOnce(null);                 // 'my-project-2' free

    const key = await generateUniqueProjectKey(TENANT_DB, TENANT_ID, 'My Project');

    expect(key).toMatch(/^my-project-\d+$/);
    expect(db.findProjectByKey).toHaveBeenCalledTimes(2);
  });
});
