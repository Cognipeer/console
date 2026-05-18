/**
 * Test fixture factories.
 *
 * Goals:
 *   - One canonical shape per entity, used across unit/api/integration tests.
 *   - Deterministic by default (stable IDs, fixed clock) so snapshots and
 *     "toHaveBeenCalledWith" assertions don't flake.
 *   - Override-friendly: every factory takes a partial to tweak fields.
 *
 * Add a new factory when you find yourself repeating the same `{ _id, ... }`
 * literal in more than two tests.
 */

import type {
  IApiToken,
  IModel,
  IProject,
  ITenant,
  IUser,
  IUserProject,
} from '@/lib/database/provider/types.base';
import { hashApiToken } from '@/lib/services/apiTokens/tokenHashing';

export const FIXED_CLOCK = new Date('2026-01-01T00:00:00.000Z');

let idCounter = 0;
/** Deterministic-but-unique id. Reset between tests by calling `resetIds()`. */
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${String(idCounter).padStart(4, '0')}`;
}
export function resetIds(): void {
  idCounter = 0;
}

// ── Tenant ────────────────────────────────────────────────────────────────────

export function tenantFixture(overrides: Partial<ITenant> = {}): ITenant {
  return {
    _id: 'tenant-acme',
    companyName: 'Acme Corp',
    slug: 'acme',
    dbName: 'tenant_acme',
    licenseType: 'FREE',
    licenseId: 'FREE',
    licenseStatus: 'free',
    ownerId: 'user-alice',
    createdAt: FIXED_CLOCK,
    ...overrides,
  };
}

// ── User ──────────────────────────────────────────────────────────────────────

export function userFixture(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: 'user-alice',
    tenantId: 'tenant-acme',
    email: 'alice@acme.com',
    name: 'Alice',
    role: 'owner',
    password: '$2b$10$hashed',
    licenseId: 'FREE',
    features: [],
    createdAt: FIXED_CLOCK,
    ...overrides,
  } as IUser;
}

// ── Project ───────────────────────────────────────────────────────────────────

export function projectFixture(overrides: Partial<IProject> = {}): IProject {
  return {
    _id: 'proj-default',
    tenantId: 'tenant-acme',
    key: '__default__',
    name: 'Default Project',
    createdBy: 'user-alice',
    createdAt: FIXED_CLOCK,
    ...overrides,
  };
}

export function userProjectFixture(overrides: Partial<IUserProject> = {}): IUserProject {
  return {
    _id: 'user-project-1',
    tenantId: 'tenant-acme',
    userId: 'user-alice',
    projectId: 'proj-default',
    role: 'project_admin',
    servicePermissions: {},
    createdAt: FIXED_CLOCK,
    ...overrides,
  } as IUserProject;
}

// ── API Token ─────────────────────────────────────────────────────────────────

export function apiTokenFixture(overrides: Partial<IApiToken> = {}): IApiToken {
  const rawToken = 'sk-test-valid-token-abc123';
  return {
    _id: 'token-1',
    tenantId: 'tenant-acme',
    userId: 'user-alice',
    projectId: 'proj-default',
    name: 'Test Token',
    tokenHash: hashApiToken(rawToken),
    tokenPrefix: rawToken.slice(0, 14),
    createdAt: FIXED_CLOCK,
    ...overrides,
  } as IApiToken;
}

// ── Model ─────────────────────────────────────────────────────────────────────

export function modelFixture(overrides: Partial<IModel> = {}): IModel {
  return {
    _id: 'model-gpt4',
    tenantId: 'tenant-acme',
    projectId: 'proj-default',
    key: 'gpt-4',
    name: 'GPT-4',
    provider: 'openai',
    providerKey: 'openai-default',
    category: 'llm',
    modelName: 'gpt-4',
    status: 'active',
    createdBy: 'user-alice',
    createdAt: FIXED_CLOCK,
    ...overrides,
  } as IModel;
}

// ── Headers for Fastify test app ─────────────────────────────────────────────

/**
 * Standard `x-*` context headers required by `withApiRequestContext`.
 * Use in `app.inject({ headers: contextHeaders(...) })`.
 */
export function contextHeaders(
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  return {
    'x-license-type': 'FREE',
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': 'tenant-acme',
    'x-tenant-slug': 'acme',
    'x-user-id': 'user-alice',
    'x-user-email': 'alice@acme.com',
    'x-user-role': 'owner',
    'x-request-id': 'test-request',
    ...overrides,
  };
}
