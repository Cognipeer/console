/**
 * Project-level service permissions and the rule that came with turning the
 * engine on (src/lib/iam/projectLevels.ts, projectMembership.ts):
 *
 *   - an explicit `none` in a membership row whose last save is OLDER than the
 *     moment the workspace was first evaluated reads as "not set";
 *   - `read`, `write` and `admin` entries are always honoured, and so is
 *     everything in a row saved from that moment on;
 *   - the rule looks at the row's own save date, so an unrelated later save of an
 *     old row makes its old `none` count (documented edge case).
 *
 * Pure parts here; the stored moment is exercised on both backends in
 * integration/iam-project-levels.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { effectiveProjectLevels, ignoredProjectLevels, isBeforeActivation } from '@/lib/iam/projectLevels';
import { normalizeServicePermissions } from '@/lib/security/rbac';
import { resolveProjectMembership, type ProjectAssignmentRow } from '@/lib/iam/projectMembership';
import { narrowLevel } from '@/lib/iam/projectNarrowing';

const SINCE = Date.parse('2026-10-01T00:00:00.000Z');
const BEFORE = new Date('2026-09-30T23:59:59.999Z');
const AT = new Date('2026-10-01T00:00:00.000Z');
const AFTER = new Date('2026-10-02T00:00:00.000Z');

describe('isBeforeActivation', () => {
  it('is true for anything saved strictly before the moment', () => {
    expect(isBeforeActivation(BEFORE, SINCE)).toBe(true);
    expect(isBeforeActivation(BEFORE.toISOString(), SINCE)).toBe(true);
    expect(isBeforeActivation(BEFORE.getTime(), SINCE)).toBe(true);
  });

  it('is false at the moment itself and after it', () => {
    expect(isBeforeActivation(AT, SINCE)).toBe(false);
    expect(isBeforeActivation(AT.toISOString(), SINCE)).toBe(false);
    expect(isBeforeActivation(AFTER, SINCE)).toBe(false);
    expect(isBeforeActivation(SINCE + 1, SINCE)).toBe(false);
  });

  it('treats a row without a usable date as older than everything', () => {
    for (const value of [undefined, null, '', 'not a date', new Date('nope'), Number.NaN]) {
      expect(isBeforeActivation(value as never, SINCE), String(value)).toBe(true);
    }
    expect(isBeforeActivation(AFTER, 0)).toBe(false); // a moment of 0 (every row counts) is never "before"
  });
});

describe('effectiveProjectLevels', () => {
  const perms = { agents: 'none', prompts: 'read', models: 'write', rag: 'admin', tools: 'none' } as const;

  it('drops only the explicit `none` of a row saved before the moment', () => {
    expect(effectiveProjectLevels({ servicePermissions: perms, updatedAt: BEFORE }, SINCE)).toEqual({ prompts: 'read', models: 'write', rag: 'admin' });
  });

  it('keeps everything of a row saved at or after the moment, `none` included', () => {
    expect(effectiveProjectLevels({ servicePermissions: perms, updatedAt: AT }, SINCE)).toEqual(perms);
    expect(effectiveProjectLevels({ servicePermissions: perms, updatedAt: AFTER }, SINCE)).toEqual(perms);
  });

  it('a row with no save date counts as old', () => {
    expect(effectiveProjectLevels({ servicePermissions: perms }, SINCE)).toEqual({ prompts: 'read', models: 'write', rag: 'admin' });
    expect(effectiveProjectLevels({ servicePermissions: perms, updatedAt: null }, SINCE)).toEqual({ prompts: 'read', models: 'write', rag: 'admin' });
  });

  it('with a moment of 0 every dated row counts in full (the way a test pins "everything was saved after")', () => {
    expect(effectiveProjectLevels({ servicePermissions: perms, updatedAt: BEFORE }, 0)).toEqual(perms);
    expect(effectiveProjectLevels({ servicePermissions: perms, updatedAt: new Date(0) }, 0)).toEqual(perms);
  });

  it('reads whatever is stored defensively: nothing, garbage and unknown services give no levels', () => {
    expect(effectiveProjectLevels({ servicePermissions: undefined, updatedAt: BEFORE }, SINCE)).toEqual({});
    expect(effectiveProjectLevels({ servicePermissions: null, updatedAt: AFTER }, SINCE)).toEqual({});
    expect(effectiveProjectLevels({ servicePermissions: 'agents', updatedAt: AFTER }, SINCE)).toEqual({});
    expect(effectiveProjectLevels({ servicePermissions: { agents: 'bogus', 'not-a-service': 'admin' }, updatedAt: AFTER }, SINCE)).toEqual({});
  });
});

describe('ignoredProjectLevels', () => {
  const perms = { agents: 'none', prompts: 'read', models: 'write', rag: 'admin', tools: 'none' } as const;

  it('names the explicit `none` entries of a row saved before the moment, and nothing else', () => {
    expect([...ignoredProjectLevels({ servicePermissions: perms, updatedAt: BEFORE }, SINCE)].sort()).toEqual(['agents', 'tools']);
    expect(ignoredProjectLevels({ servicePermissions: { prompts: 'read', models: 'write' }, updatedAt: BEFORE }, SINCE)).toEqual([]);
  });

  it('names nothing for a row saved at or after the moment: every entry counts', () => {
    expect(ignoredProjectLevels({ servicePermissions: perms, updatedAt: AT }, SINCE)).toEqual([]);
    expect(ignoredProjectLevels({ servicePermissions: perms, updatedAt: AFTER }, SINCE)).toEqual([]);
    expect(ignoredProjectLevels({ servicePermissions: perms, updatedAt: BEFORE }, 0)).toEqual([]);
  });

  it('a row with no save date counts as old', () => {
    expect([...ignoredProjectLevels({ servicePermissions: perms }, SINCE)].sort()).toEqual(['agents', 'tools']);
    expect([...ignoredProjectLevels({ servicePermissions: perms, updatedAt: null }, SINCE)].sort()).toEqual(['agents', 'tools']);
  });

  it('reads whatever is stored defensively, like the engine does', () => {
    for (const stored of [undefined, null, 'agents', [], { agents: 'bogus', 'not-a-service': 'none' }]) {
      expect(ignoredProjectLevels({ servicePermissions: stored, updatedAt: BEFORE }, SINCE), JSON.stringify(stored)).toEqual([]);
    }
  });

  it('is exactly what effectiveProjectLevels leaves out of the stored levels', () => {
    for (const updatedAt of [BEFORE, AT, AFTER, null, undefined]) {
      const row = { servicePermissions: perms, updatedAt };
      const effective = effectiveProjectLevels(row, SINCE);
      const left = Object.keys(normalizeServicePermissions(perms)).filter((service) => !(service in effective));
      expect([...ignoredProjectLevels(row, SINCE)].sort(), String(updatedAt)).toEqual(left.sort());
    }
  });
});

describe('resolveProjectMembership', () => {
  const row = (over: Partial<ProjectAssignmentRow> & { projectId: string }): ProjectAssignmentRow => ({
    role: 'member', servicePermissions: {}, updatedAt: AFTER, ...over,
  });
  const input = (over: Partial<Parameters<typeof resolveProjectMembership>[0]> = {}) => ({
    projectId: 'p1', userRole: 'user', userProjects: [], groupProjects: [], since: SINCE, ...over,
  });

  it('is null when nothing makes the user a member of the project', () => {
    expect(resolveProjectMembership(input())).toBeNull();
    expect(resolveProjectMembership(input({ userProjects: [row({ projectId: 'p2' })], groupProjects: [row({ projectId: 'p3', groupId: 'g' })] }))).toBeNull();
    expect(resolveProjectMembership(input({ legacyProjectIds: ['p2'] }))).toBeNull();
  });

  it('a direct row gives its role and levels', () => {
    expect(resolveProjectMembership(input({ userProjects: [row({ projectId: 'p1', role: 'project_admin', servicePermissions: { agents: 'read' } })] })))
      .toEqual({ role: 'project_admin', servicePermissions: { agents: 'read' } });
  });

  it('the legacy project list on the user row makes a plain member (a project admin keeps the role), with no levels', () => {
    expect(resolveProjectMembership(input({ legacyProjectIds: ['p1'] }))).toEqual({ role: 'member', servicePermissions: {} });
    expect(resolveProjectMembership(input({ legacyProjectIds: ['p1'], userRole: 'project_admin' }))).toEqual({ role: 'project_admin', servicePermissions: {} });
  });

  it('a direct row wins over the legacy list: the entry is not counted twice', () => {
    const out = resolveProjectMembership(input({
      legacyProjectIds: ['p1'], userRole: 'project_admin', userProjects: [row({ projectId: 'p1', role: 'member', servicePermissions: { agents: 'read' } })],
    }));
    expect(out).toEqual({ role: 'member', servicePermissions: { agents: 'read' } });
  });

  it('merges the group rows with the direct one: the strongest role, the highest level per service', () => {
    const out = resolveProjectMembership(input({
      userProjects: [row({ projectId: 'p1', role: 'member', servicePermissions: { agents: 'read', prompts: 'write' } })],
      groupProjects: [
        row({ projectId: 'p1', groupId: 'g1', role: 'member', servicePermissions: { agents: 'write' } }),
        row({ projectId: 'p1', groupId: 'g2', role: 'project_admin', servicePermissions: { models: 'read' } }),
        row({ projectId: 'p9', groupId: 'g3', role: 'project_admin', servicePermissions: { rag: 'admin' } }), // another project: ignored
      ],
    }));
    expect(out).toEqual({ role: 'project_admin', servicePermissions: { agents: 'write', prompts: 'write', models: 'read' } });
  });

  it('a user in a project only through a group is a member with that group\'s levels', () => {
    expect(resolveProjectMembership(input({ groupProjects: [row({ projectId: 'p1', groupId: 'g1', servicePermissions: { agents: 'read' } })] })))
      .toEqual({ role: 'member', servicePermissions: { agents: 'read' } });
  });

  it('matches project ids as strings', () => {
    expect(resolveProjectMembership(input({ projectId: '7', userProjects: [row({ projectId: 7 as unknown as string, servicePermissions: { agents: 'read' } })] })))
      .toEqual({ role: 'member', servicePermissions: { agents: 'read' } });
  });

  describe('the project-levels rule', () => {
    const old = (over: Partial<ProjectAssignmentRow> = {}) => row({ projectId: 'p1', updatedAt: BEFORE, ...over });
    const fresh = (over: Partial<ProjectAssignmentRow> = {}) => row({ projectId: 'p1', updatedAt: AFTER, ...over });

    it('an old row\'s `none` is read as not set; its read/write/admin stay', () => {
      const out = resolveProjectMembership(input({ userProjects: [old({ servicePermissions: { agents: 'none', prompts: 'read', models: 'write' } })] }));
      expect(out?.servicePermissions).toEqual({ prompts: 'read', models: 'write' });
      // ... and so the workspace level stands for the service nobody set
      expect(narrowLevel('write', out, 'agents')).toBe('write');
      expect(narrowLevel('write', out, 'prompts')).toBe('read');
    });

    it('a row saved after the moment keeps its `none`, and the service really is cut off', () => {
      const out = resolveProjectMembership(input({ userProjects: [fresh({ servicePermissions: { agents: 'none' } })] }));
      expect(out?.servicePermissions).toEqual({ agents: 'none' });
      expect(narrowLevel('admin', out, 'agents')).toBe('none');
    });

    it('applies to each source on its own date: an old group row and a new direct row', () => {
      const out = resolveProjectMembership(input({
        userProjects: [fresh({ servicePermissions: { prompts: 'none' } })],
        groupProjects: [old({ groupId: 'g1', servicePermissions: { agents: 'none', prompts: 'read' } })],
      }));
      // the old group `none` for agents is ignored; the group's `read` for prompts beats the direct `none` (highest level wins)
      expect(out?.servicePermissions).toEqual({ prompts: 'read' });
    });

    it('a `none` of an old row is dropped even when it is the only thing the row says', () => {
      const out = resolveProjectMembership(input({ userProjects: [old({ servicePermissions: { agents: 'none' } })] }));
      expect(out).toEqual({ role: 'member', servicePermissions: {} });
    });

    it('an unrelated later save of an old row (a role change) makes its old `none` count from then on', () => {
      const saved = { servicePermissions: { agents: 'none' } } as const;
      expect(resolveProjectMembership(input({ userProjects: [old({ role: 'member', ...saved })] }))?.servicePermissions).toEqual({});
      // the member is made project admin; the save carries the permissions along and bumps the row's date
      expect(resolveProjectMembership(input({ userProjects: [fresh({ role: 'project_admin', ...saved })] }))?.servicePermissions).toEqual({ agents: 'none' });
    });

    it('a row with no save date is old; a moment of 0 makes every row count', () => {
      const undated = row({ projectId: 'p1', updatedAt: undefined, servicePermissions: { agents: 'none' } });
      expect(resolveProjectMembership(input({ userProjects: [undated] }))?.servicePermissions).toEqual({});
      const dated = row({ projectId: 'p1', updatedAt: BEFORE, servicePermissions: { agents: 'none' } });
      expect(resolveProjectMembership(input({ userProjects: [dated], since: 0 }))?.servicePermissions).toEqual({ agents: 'none' });
    });
  });
});
