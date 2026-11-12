/**
 * The pieces the dashboard and client provider routes share: reading a request body, mapping a create body to the
 * service input, and finding the provider a request names (404 cases: another tenant, a project it is not assigned to).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getProviderConfigById = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/providers/providerService', () => ({ getProviderConfigById }));

import {
  assertCreateProviderPayload,
  buildCreateProviderInput,
  isAssignedToProject,
  isRecord,
  loadScopedProvider,
  parseProviderStatus,
  sanitizeProviderUpdatePayload,
} from '@/server/api/providerRoutes';

const FULL_BODY = {
  key: 'azure-eu',
  type: 'model',
  driver: 'openai',
  label: 'Azure EU',
  credentials: { apiKey: 'sk-1' },
  createdBy: 'user-1',
};

describe('isRecord / parseProviderStatus', () => {
  it('takes objects (arrays included, as before) and refuses null and primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it('knows the three statuses and nothing else', () => {
    expect(parseProviderStatus('active')).toBe('active');
    expect(parseProviderStatus('disabled')).toBe('disabled');
    expect(parseProviderStatus('errored')).toBe('errored');
    expect(parseProviderStatus('ACTIVE')).toBeUndefined();
    expect(parseProviderStatus('')).toBeUndefined();
    expect(parseProviderStatus(undefined)).toBeUndefined();
  });
});

describe('assertCreateProviderPayload', () => {
  it('accepts a body with every required field', () => {
    expect(() => assertCreateProviderPayload(FULL_BODY)).not.toThrow();
  });

  it.each([null, undefined, 'text', 5])('refuses %s as "Invalid payload"', (body) => {
    expect(() => assertCreateProviderPayload(body)).toThrow('Invalid payload');
  });

  it.each(['key', 'type', 'driver', 'label', 'credentials', 'createdBy'])('names the missing %s', (field) => {
    for (const empty of [undefined, null, '']) {
      expect(() => assertCreateProviderPayload({ ...FULL_BODY, [field]: empty })).toThrow(`${field} is required`);
    }
  });

  it('reports the first missing field in the fixed order', () => {
    expect(() => assertCreateProviderPayload({})).toThrow('key is required');
    expect(() => assertCreateProviderPayload({ key: 'k' })).toThrow('type is required');
  });
});

describe('sanitizeProviderUpdatePayload', () => {
  it('is empty for anything that is not an object', () => {
    expect(sanitizeProviderUpdatePayload(null)).toEqual({});
    expect(sanitizeProviderUpdatePayload('x')).toEqual({});
    expect(sanitizeProviderUpdatePayload(undefined)).toEqual({});
  });

  it('keeps each field of the right shape', () => {
    const body = {
      label: 'New',
      description: 'About',
      status: 'disabled',
      settings: { a: 1 },
      metadata: { b: 2 },
      credentials: { apiKey: 'x' },
      projectIds: ['p1', 'p2'],
      capabilitiesOverride: ['chat'],
    };
    expect(sanitizeProviderUpdatePayload(body)).toEqual(body);
  });

  it('turns a null description into undefined (a clear) and drops fields of the wrong shape', () => {
    const payload = sanitizeProviderUpdatePayload({
      label: 5,
      description: null,
      status: 'paused',
      settings: 'x',
      metadata: null,
      credentials: 7,
      projectIds: ['p1', 2],
      capabilitiesOverride: 'chat',
      key: 'ignored',
      tenantId: 'ignored',
    });
    expect(payload).toEqual({ description: undefined });
    expect('description' in payload).toBe(true);
    expect('label' in payload).toBe(false);
    expect('key' in payload).toBe(false);
  });
});

describe('buildCreateProviderInput', () => {
  const body = {
    ...FULL_BODY,
    description: 'About',
    settings: { region: 'eu' },
    metadata: { team: 'x' },
    status: 'active',
    capabilitiesOverride: ['chat'],
    projectIds: ['ignored'],
    tenantId: 'ignored',
  };

  it('maps the body fields and takes createdBy and allowHostPaths from the caller, not the body', () => {
    expect(buildCreateProviderInput(body, { createdBy: 'session-user', scope: {}, allowHostPaths: true })).toEqual({
      capabilitiesOverride: ['chat'],
      createdBy: 'session-user',
      credentials: { apiKey: 'sk-1' },
      description: 'About',
      driver: 'openai',
      key: 'azure-eu',
      label: 'Azure EU',
      metadata: { team: 'x' },
      settings: { region: 'eu' },
      status: 'active',
      type: 'model',
      allowHostPaths: true,
    });
  });

  it('leaves out nothing it maps: optional fields are present as undefined', () => {
    const input = buildCreateProviderInput(FULL_BODY, { createdBy: 'u', scope: {}, allowHostPaths: false });
    for (const field of ['capabilitiesOverride', 'description', 'metadata', 'settings', 'status']) {
      expect(field in input).toBe(true);
      expect((input as unknown as Record<string, unknown>)[field]).toBeUndefined();
    }
    expect(input.allowHostPaths).toBe(false);
  });

  it('scope {} sets no project key (tenant scope, unassigned)', () => {
    const input = buildCreateProviderInput(body, { createdBy: 'u', scope: {}, allowHostPaths: false });
    expect('projectId' in input).toBe(false);
    expect('projectIds' in input).toBe(false);
  });

  it('scope {projectId} assigns one project', () => {
    const input = buildCreateProviderInput(body, { createdBy: 'u', scope: { projectId: 'p1' }, allowHostPaths: true });
    expect(input.projectId).toBe('p1');
    expect('projectIds' in input).toBe(false);
  });

  it('scope {projectIds} assigns the resolved list, and an undefined list stays an undefined key', () => {
    expect(buildCreateProviderInput(body, { createdBy: 'u', scope: { projectIds: ['p1', 'p2'] }, allowHostPaths: true }).projectIds)
      .toEqual(['p1', 'p2']);
    const none = buildCreateProviderInput(body, { createdBy: 'u', scope: { projectIds: undefined }, allowHostPaths: true });
    expect('projectIds' in none).toBe(true);
    expect(none.projectIds).toBeUndefined();
    expect('projectId' in none).toBe(false);
  });
});

describe('isAssignedToProject', () => {
  it('matches the direct project or any of projectIds, comparing as strings', () => {
    expect(isAssignedToProject({ projectId: 'p1' }, 'p1')).toBe(true);
    expect(isAssignedToProject({ projectId: { toString: () => 'p1' } }, 'p1')).toBe(true);
    expect(isAssignedToProject({ projectIds: ['p2', 'p1'] }, 'p1')).toBe(true);
    expect(isAssignedToProject({ projectId: 'p2', projectIds: ['p3'] }, 'p1')).toBe(false);
    expect(isAssignedToProject({}, 'p1')).toBe(false);
    expect(isAssignedToProject({ projectIds: 'p1' }, 'p1')).toBe(false);
  });
});

describe('loadScopedProvider', () => {
  beforeEach(() => {
    getProviderConfigById.mockReset();
  });

  it('is null for a missing provider and for one of another tenant, in both scopes', async () => {
    getProviderConfigById.mockResolvedValueOnce(null);
    expect(await loadScopedProvider('db', 'tenant-1', 'x', { scope: 'tenant' })).toBeNull();
    getProviderConfigById.mockResolvedValueOnce({ _id: 'x', tenantId: 'tenant-2', projectId: 'p1' });
    expect(await loadScopedProvider('db', 'tenant-1', 'x', { scope: 'tenant' })).toBeNull();
    getProviderConfigById.mockResolvedValueOnce({ _id: 'x', tenantId: 'tenant-2', projectId: 'p1' });
    expect(await loadScopedProvider('db', 'tenant-1', 'x', { scope: 'project', projectId: 'p1' })).toBeNull();
  });

  it('tenant scope opens any provider of the tenant, assigned or not', async () => {
    const provider = { _id: 'x', tenantId: 'tenant-1' };
    getProviderConfigById.mockResolvedValue(provider);
    expect(await loadScopedProvider('db', 'tenant-1', 'x', { scope: 'tenant' })).toBe(provider);
    expect(getProviderConfigById).toHaveBeenCalledWith('db', 'x');
  });

  it('project scope opens a provider assigned to the project, directly or by projectIds', async () => {
    const direct = { _id: 'x', tenantId: 'tenant-1', projectId: 'p1' };
    const listed = { _id: 'y', tenantId: 'tenant-1', projectIds: ['p9', 'p1'] };
    getProviderConfigById.mockResolvedValueOnce(direct).mockResolvedValueOnce(listed);
    expect(await loadScopedProvider('db', 'tenant-1', 'x', { scope: 'project', projectId: 'p1' })).toBe(direct);
    expect(await loadScopedProvider('db', 'tenant-1', 'y', { scope: 'project', projectId: 'p1' })).toBe(listed);
  });

  it('project scope is null for a provider of another project, and without a project at all', async () => {
    getProviderConfigById.mockResolvedValue({ _id: 'x', tenantId: 'tenant-1', projectId: 'p2', projectIds: ['p3'] });
    expect(await loadScopedProvider('db', 'tenant-1', 'x', { scope: 'project', projectId: 'p1' })).toBeNull();
    getProviderConfigById.mockResolvedValue({ _id: 'x', tenantId: 'tenant-1', projectId: 'p1' });
    expect(await loadScopedProvider('db', 'tenant-1', 'x', { scope: 'project' })).toBeNull();
    expect(await loadScopedProvider('db', 'tenant-1', 'x', { scope: 'project', projectId: '' })).toBeNull();
  });

  it('asks for the stored credential field names only when told to', async () => {
    getProviderConfigById.mockResolvedValue({ _id: 'x', tenantId: 'tenant-1' });
    await loadScopedProvider('db', 'tenant-1', 'x', { scope: 'tenant', credentialFields: true });
    expect(getProviderConfigById).toHaveBeenCalledWith('db', 'x', { credentialFields: true });
  });
});
