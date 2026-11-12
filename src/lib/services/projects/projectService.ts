import slugify from 'slugify';
import { runWithTenantScope, type IProject, type IUser } from '@/lib/database';

const SLUG_OPTIONS = {
  lower: true,
  strict: true,
  trim: true,
};

export const DEFAULT_PROJECT_KEY = 'default';
export const DEFAULT_PROJECT_NAME = 'Default Project';

export async function ensureDefaultProject(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
): Promise<IProject> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const existing = await db.findProjectByKey(tenantId, DEFAULT_PROJECT_KEY);
    if (existing) {
      return existing;
    }

    const created = await db.createProject({
      tenantId,
      key: DEFAULT_PROJECT_KEY,
      name: DEFAULT_PROJECT_NAME,
      description: 'Automatically created project',
      createdBy,
      updatedBy: createdBy,
    });

    return created;
  });
}

export async function listAccessibleProjects(
  tenantDbName: string,
  tenantId: string,
  user: Pick<IUser, 'role' | 'projectIds'>,
): Promise<IProject[]> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const projects = await db.listProjects(tenantId);
    if (user.role === 'owner' || user.role === 'admin') {
      return projects;
    }

    const allowed = new Set((user.projectIds ?? []).map(String));
    return projects.filter((project) => {
      const id = project._id ? String(project._id) : '';
      return allowed.has(id);
    });
  });
}

export function normalizeProjectKey(input: string): string {
  const raw = input.trim();
  if (!raw) {
    return DEFAULT_PROJECT_KEY;
  }
  return slugify(raw, SLUG_OPTIONS);
}

export async function generateUniqueProjectKey(
  tenantDbName: string,
  tenantId: string,
  desiredKey: string,
): Promise<string> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const base = normalizeProjectKey(desiredKey);
    let attempt = 0;
    let candidate = base;

    while (attempt < 50) {
      const existing = await db.findProjectByKey(tenantId, candidate);
      if (!existing) return candidate;
      attempt += 1;
      candidate = `${base}-${attempt + 1}`;
    }

    throw new Error('Could not generate unique project key');
  });
}
