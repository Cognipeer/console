/**
 * The pure models behind the people-and-access forms: the permission matrix,
 * what each form sends, the bulk helpers and how failures are worded.
 */
import { describe, expect, it } from 'vitest';
import {
  changedServices,
  LEVEL_ORDER,
  MATRIX_SERVICES,
  matrixLevel,
  overrideCount,
  overrideEffects,
  readDraft,
  resetDraft,
  roleDefaultLevel,
  sameDraft,
  toPermissions,
} from '@/components/iam/principals/permissionModel';
import {
  needsTypedConfirmation,
  problems,
  reasonCounts,
  runChunked,
  selectedIds,
  TYPED_CONFIRMATION_ABOVE,
} from '@/components/iam/principals/bulkModel';
import { parseBulkResult, type BulkResult } from '@/components/iam/principals/directoryApi';
import { decisionOf, describeError, isKnownErrorCode, KNOWN_ERROR_CODES } from '@/components/iam/principals/errors';
import { DirectoryApiError } from '@/components/iam/principals/directoryApi';
import { IamApiError } from '@/components/iam/principals/client';
import { draftKey } from '@/components/iam/principals/useAccessPreview';
import { guessCapabilities } from '@/components/iam/principals/usePeopleCapabilities';
import { profilePatch } from '@/components/iam/principals/EditProfileShell';
import { groupPatch, type GroupEditTarget } from '@/components/iam/principals/GroupShell';
import { splitChanges } from '@/components/iam/principals/ChangeRoleShell';
import { countCsvRows } from '@/components/iam/principals/ImportPeopleShell';
import { tokenExtraBody } from '@/components/iam/principals/NewTokenShell';
import { PEOPLE_ERROR_CODES } from '@/lib/iam/identity';

describe('the permission matrix', () => {
  it('offers every service but the retired ones', () => {
    const ids = MATRIX_SERVICES.map((s) => s.id as string);
    expect(ids).toContain('models');
    expect(ids).toContain('iam');
    expect(ids).not.toContain('aegis');
  });

  it('reads nothing stored as "role default" - never as "no access"', () => {
    const draft = readDraft({});
    expect(Object.values(draft.choices).every((c) => c === 'inherit')).toBe(true);
    expect(toPermissions(draft)).toEqual({});
    expect(overrideCount(draft.choices)).toBe(0);
  });

  it('stores only explicit choices, an explicit "no access" included', () => {
    const draft = readDraft({ models: 'read', agents: 'none' });
    expect(draft.choices.models).toBe('read');
    expect(draft.choices.agents).toBe('none');
    expect(draft.choices.prompts).toBe('inherit');
    expect(toPermissions(draft)).toEqual({ models: 'read', agents: 'none' });
    // putting a service back to "role default" removes the key
    const back = { ...draft, choices: { ...draft.choices, agents: 'inherit' as const } };
    expect(toPermissions(back)).toEqual({ models: 'read' });
  });

  it('carries a stored entry of a retired service through a save untouched', () => {
    const draft = readDraft({ aegis: 'admin', models: 'read', bogus: 'write' });
    expect(draft.kept).toEqual({ aegis: 'admin' });
    expect(toPermissions({ ...draft, choices: { ...draft.choices, models: 'inherit' } })).toEqual({ aegis: 'admin' });
    expect(toPermissions(resetDraft(draft))).toEqual({ aegis: 'admin' });
  });

  it('lists what changed against the stored state, in the matrix order', () => {
    const before = readDraft({ models: 'read' });
    const after = { ...before, choices: { ...before.choices, models: 'write' as const, agents: 'admin' as const } };
    const changed = changedServices(before.choices, after.choices);
    expect(changed).toEqual(MATRIX_SERVICES.map((s) => s.id as string).filter((id) => id === 'models' || id === 'agents'));
    expect(sameDraft(before, before)).toBe(true);
    expect(sameDraft(before, after)).toBe(false);
  });

  it('shows what the role gives by default, and what an override yields', () => {
    expect(roleDefaultLevel('user', 'models')).toBe('write');
    expect(roleDefaultLevel('user', 'iam')).toBe('none'); // an administration service
    expect(roleDefaultLevel('admin', 'iam')).toBe('admin');
    expect(roleDefaultLevel(null, 'models')).toBe('none'); // a group without a role gives nothing by default
    expect(matrixLevel('user', 'inherit', 'models')).toBe('write');
    expect(matrixLevel('user', 'read', 'models')).toBe('read');
    expect(matrixLevel('user', 'none', 'models')).toBe('none');
  });

  it('names the services an override raises or lowers against the role default', () => {
    const draft = readDraft({ models: 'read', iam: 'read', agents: 'write' });
    const effects = overrideEffects('user', draft.choices);
    expect(effects).toEqual(
      expect.arrayContaining([
        { service: 'models', from: 'write', to: 'read' },
        { service: 'iam', from: 'none', to: 'read' },
      ]),
    );
    // "write" on agents is what the role gives anyway: no effect to report
    expect(effects.find((e) => e.service === 'agents')).toBeUndefined();
    expect(LEVEL_ORDER.admin).toBeGreaterThan(LEVEL_ORDER.read);
  });
});

describe('what the forms send', () => {
  it('a profile edit sends only the fields that changed', () => {
    const stored = { name: 'Ann Lee', email: 'ann@example.com' };
    expect(profilePatch(stored, { name: ' Ann Lee ', email: 'ann@example.com' })).toEqual({});
    expect(profilePatch(stored, { name: 'Ann L.', email: 'ann@example.com' })).toEqual({ name: 'Ann L.' });
    expect(profilePatch(stored, { name: 'Ann Lee', email: ' ann@corp.example ' })).toEqual({ email: 'ann@corp.example' });
    expect(profilePatch(stored, { name: 'A B', email: 'x@y.zz' })).toEqual({ name: 'A B', email: 'x@y.zz' });
  });

  it('a group edit sends only what changed, never a grants map it could not load', () => {
    const stored: GroupEditTarget = {
      id: 'g1',
      name: 'Eng',
      description: 'Engineers',
      tenantRole: 'user',
      servicePermissions: { models: 'read' },
      source: 'local',
      memberCount: 4,
    };
    const matrix = readDraft({ models: 'read' });
    const same = { name: 'Eng', description: 'Engineers', tenantRole: 'user' as const, matrix };
    expect(groupPatch(stored, same, matrix)).toEqual({});

    expect(groupPatch(stored, { ...same, name: 'Platform', tenantRole: '' }, matrix)).toEqual({ name: 'Platform', tenantRole: null });
    const changedMatrix = { ...matrix, choices: { ...matrix.choices, models: 'write' as const } };
    expect(groupPatch(stored, { ...same, matrix: changedMatrix }, matrix)).toEqual({ servicePermissions: { models: 'write' } });

    // the grants were not loaded (baseline null): they are never written
    expect(groupPatch({ ...stored, servicePermissions: null }, { ...same, matrix: changedMatrix }, null)).toEqual({});

    // a directory group keeps its name
    expect(groupPatch({ ...stored, source: 'ldap' }, { ...same, name: 'Renamed' }, matrix)).toEqual({});
  });

  it('a token for somebody else names the owner; for yourself it does not; the project is always named', () => {
    const me = { userId: 'u-me' };
    expect(tokenExtraBody({ id: 'u-ann' }, me, 'p1')).toEqual({ userId: 'u-ann', projectId: 'p1' });
    expect(tokenExtraBody({ id: 'u-me' }, me, 'p1')).toEqual({ projectId: 'p1' });
    expect(tokenExtraBody(null, me, null)).toEqual({});
  });

  it('counts the rows of a CSV, blank lines aside', () => {
    expect(countCsvRows('a\n\n b \r\nc')).toBe(3);
    expect(countCsvRows('   ')).toBe(0);
  });

  it('keys a preview by what it would evaluate, not by object identity', () => {
    expect(draftKey(null)).toBe('');
    expect(draftKey({ role: 'admin' })).toBe(draftKey({ role: 'admin' }));
    expect(draftKey({ role: 'admin' })).not.toBe(draftKey({ role: 'user' }));
    expect(draftKey({ servicePermissions: { models: 'read', agents: 'write' } })).toBe(
      draftKey({ servicePermissions: { agents: 'write', models: 'read' } }),
    );
  });

  it('splits a preview into services that gain and services that lose', () => {
    const { gained, lost } = splitChanges({
      effective: [],
      projects: null,
      changes: [
        { service: 'models', from: 'read', to: 'write' },
        { service: 'agents', from: 'admin', to: 'none' },
        { service: 'tools', from: 'read', to: 'read' },
      ],
    });
    expect(gained.map((c) => c.service)).toEqual(['models']);
    expect(lost.map((c) => c.service)).toEqual(['agents']);
    expect(splitChanges(null)).toEqual({ gained: [], lost: [] });
  });
});

describe('what the first paint assumes before the server answers', () => {
  it('owners and admins may manage people and tokens; nobody else', () => {
    for (const role of ['owner', 'admin']) {
      expect(guessCapabilities(role)).toMatchObject({ peopleManage: true, grantAdmin: true, tokensManageOthers: true });
      expect(guessCapabilities(role).assignableRoles).toEqual(['admin', 'project_admin', 'user']);
    }
    for (const role of ['project_admin', 'user', undefined]) {
      expect(guessCapabilities(role)).toMatchObject({ peopleManage: false, grantAdmin: false, tokensManageOthers: false, assignableRoles: [] });
    }
  });
});

describe('bulk helpers', () => {
  it('asks for a typed confirmation above 20 targets', () => {
    expect(needsTypedConfirmation(TYPED_CONFIRMATION_ABOVE)).toBe(false);
    expect(needsTypedConfirmation(TYPED_CONFIRMATION_ABOVE + 1)).toBe(true);
  });

  it('counts why items were skipped, most common first', () => {
    const result = parseBulkResult({
      results: [
        { id: 'a', outcome: 'skipped', code: 'already_in_state' },
        { id: 'b', outcome: 'skipped', code: 'self_not_allowed' },
        { id: 'c', outcome: 'skipped', code: 'already_in_state' },
        { id: 'd', outcome: 'failed' },
        { id: 'e', outcome: 'ok' },
      ],
    });
    expect(reasonCounts(result.results, 'skipped')).toEqual([
      { code: 'already_in_state', count: 2 },
      { code: 'self_not_allowed', count: 1 },
    ]);
    expect(reasonCounts(result.results, 'failed')).toEqual([{ code: 'failed', count: 1 }]);
    expect(problems(result).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('runs a selection in requests of at most 100 ids and folds the answers', async () => {
    const ids = Array.from({ length: 230 }, (_, i) => `u${i}`);
    const seen: number[] = [];
    const result = await runChunked(ids, async (chunk) => {
      seen.push(chunk.length);
      return {
        action: 'enable',
        dryRun: false,
        requested: chunk.length,
        ok: chunk.length - 1,
        skipped: 1,
        failed: 0,
        batchId: 'b',
        results: [],
      } satisfies BulkResult;
    });
    expect(seen).toEqual([100, 100, 30]);
    expect(result).toMatchObject({ requested: 230, ok: 227, skipped: 3 });
  });

  it('takes the ids of the selected rows in page order, once', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'b' }];
    expect(selectedIds(rows, new Set(['c', 'b']), (r) => r.id)).toEqual(['b', 'c']);
  });
});

describe('how a failure is worded', () => {
  const t = (key: string) => `T(${key})`;

  it('words every code the people endpoints answer with', () => {
    for (const code of PEOPLE_ERROR_CODES) {
      expect(isKnownErrorCode(code), code).toBe(true);
      expect(describeError(new IamApiError('English', 400, code), t)).toBe(`T(errors.${code})`);
    }
    expect(KNOWN_ERROR_CODES.length).toBeGreaterThanOrEqual(PEOPLE_ERROR_CODES.length);
  });

  it('falls back by status for an unknown code', () => {
    expect(describeError(new IamApiError('Forbidden: x', 403), t)).toBe('T(errors.forbidden)');
    expect(describeError(new IamApiError('nope', 404), t)).toBe('T(errors.notFound)');
    expect(describeError(new IamApiError('HTTP 503', 503), t)).toBe('T(errors.authorization_unavailable)');
    expect(describeError(new IamApiError('Unauthorized', 401), t)).toBe('T(errors.unauthorized)');
  });

  it('a limit without a code says what the server said (the plan\'s user limit); a bare 429 is a rate limit', () => {
    expect(describeError(new IamApiError('User quota exceeded for your plan', 429), t)).toBe('User quota exceeded for your plan');
    expect(describeError(new IamApiError('HTTP 429', 429), t)).toBe('T(errors.rate_limited)');
  });

  it('keeps an unknown server sentence and falls back for the rest', () => {
    expect(describeError(new IamApiError('Something specific', 500), t)).toBe('Something specific');
    expect(describeError(new IamApiError('HTTP 500', 500), t)).toBe('T(errors.generic)');
    expect(describeError(new Error('boom'), t)).toBe('boom');
    expect(describeError('x', t)).toBe('T(errors.generic)');
    expect(describeError(null, t, 'custom')).toBe('custom');
  });

  it('knows the decision of a refusal', () => {
    expect(decisionOf(new DirectoryApiError('Forbidden', 403, 'forbidden', undefined, { decisionId: 'd-9' }))).toBe('d-9');
    expect(decisionOf(new IamApiError('Forbidden', 403))).toBeNull();
    expect(decisionOf(new DirectoryApiError('Forbidden', 403))).toBeNull();
  });
});
