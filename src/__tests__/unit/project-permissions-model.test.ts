/**
 * The model behind the project permission editor: a service is either inherited
 * (nothing stored: the member's workspace level stands) or limited to an explicit
 * level - "no access" included. A project level only ever narrows; it is never
 * rendered as "None" when unset and only explicit choices are saved.
 */

import { describe, expect, it } from 'vitest';
import { RBAC_SERVICE_DEFINITIONS } from '@/lib/security/rbac';
import {
  changedServices,
  effectiveLevel,
  exceedsWorkspace,
  GRANTABLE_SERVICES,
  ignoredEntries,
  inferIgnoredNone,
  limitCount,
  PROJECT_CHOICES,
  readStored,
  summarizeStored,
  toPermissions,
} from '@/components/projects/projectPermissionsModel';

const RETIRED = RBAC_SERVICE_DEFINITIONS.find((s) => s.deprecated);

describe('what the editor offers', () => {
  it('offers Inherit first and then the four levels', () => {
    expect(PROJECT_CHOICES).toEqual(['inherit', 'none', 'read', 'write', 'admin']);
  });

  it('does not offer a retired service, but the definition still exists', () => {
    expect(GRANTABLE_SERVICES.length).toBeGreaterThan(30);
    expect(GRANTABLE_SERVICES.every((s) => !s.deprecated)).toBe(true);
    if (RETIRED) expect(GRANTABLE_SERVICES.map((s) => s.id)).not.toContain(RETIRED.id);
  });
});

describe('readStored', () => {
  it('reads nothing stored as Inherit for every service - never as "None"', () => {
    for (const stored of [undefined, null, {}, 'junk', []]) {
      const { choices, kept } = readStored(stored);
      expect(Object.values(choices).every((c) => c === 'inherit')).toBe(true);
      expect(Object.keys(choices)).toHaveLength(GRANTABLE_SERVICES.length);
      expect(kept).toEqual({});
    }
  });

  it('reads an explicit level - an explicit "no access" included - as that choice', () => {
    const { choices } = readStored({ models: 'read', agents: 'none', tools: 'admin' });
    expect(choices.models).toBe('read');
    expect(choices.agents).toBe('none');
    expect(choices.tools).toBe('admin');
    expect(choices.prompts).toBe('inherit');
  });

  it('shows the "no access" the engine ignores (an old setting) as Inherit, but keeps every real level', () => {
    const { choices } = readStored({ models: 'none', agents: 'none', tools: 'read' }, ['models']);
    expect(choices.models).toBe('inherit'); // ignored: saved before project levels were enforced
    expect(choices.agents).toBe('none'); // an explicit "no access" the engine honours
    expect(choices.tools).toBe('read');
    // an ignored name never hides a real level
    expect(readStored({ models: 'write' }, ['models']).choices.models).toBe('write');
  });

  it('drops unknown services and levels', () => {
    const { choices, kept } = readStored({ nonsense: 'admin', models: 'superuser' });
    expect(choices.models).toBe('inherit');
    expect(kept).toEqual({});
  });

  it('carries an entry of a retired service through untouched', () => {
    if (!RETIRED) return;
    const { kept, choices } = readStored({ [RETIRED.id]: 'read', models: 'write' });
    expect(kept).toEqual({ [RETIRED.id]: 'read' });
    expect(choices[RETIRED.id]).toBeUndefined();
    expect(toPermissions(choices, kept)).toEqual({ [RETIRED.id]: 'read', models: 'write' });
  });
});

describe('toPermissions', () => {
  it('saves only explicit choices: Inherit removes the key', () => {
    const { choices } = readStored({ models: 'read', agents: 'none' });
    expect(toPermissions(choices)).toEqual({ models: 'read', agents: 'none' });
    expect(toPermissions({ ...choices, models: 'inherit' })).toEqual({ agents: 'none' });
    expect(toPermissions({ ...choices, models: 'inherit', agents: 'inherit' })).toEqual({});
  });

  it('a service touched and put back to Inherit saves as nothing - not as an explicit "no access"', () => {
    const initial = readStored({}).choices;
    const touched = { ...initial, models: 'read' as const };
    const putBack = { ...touched, models: 'inherit' as const };
    expect(toPermissions(putBack)).toEqual({});
  });

  it('drops the ignored "no access" on save (the engine did not read it anyway)', () => {
    const { choices, kept } = readStored({ models: 'none', agents: 'read' }, ['models']);
    expect(toPermissions(choices, kept)).toEqual({ agents: 'read' });
  });
});

describe('what changed', () => {
  it('lists the services whose choice differs, in the editor\'s order, and counts the limits', () => {
    const before = readStored({ models: 'read' }).choices;
    const after = { ...before, models: 'inherit' as const, agents: 'none' as const, tools: 'write' as const };
    const changed = changedServices(before, after);
    expect(changed).toEqual(GRANTABLE_SERVICES.map((s) => s.id).filter((id) => ['models', 'agents', 'tools'].includes(id)));
    expect(changedServices(before, before)).toEqual([]);
    expect(limitCount(before)).toBe(1);
    expect(limitCount(after)).toBe(2);
    expect(limitCount(readStored({}).choices)).toBe(0);
  });
});

describe('the level a member ends up with', () => {
  it('is the lower of the workspace level and the project level', () => {
    expect(effectiveLevel('write', 'read')).toBe('read');
    expect(effectiveLevel('read', 'write')).toBe('read'); // a project level never widens
    expect(effectiveLevel('admin', 'none')).toBe('none');
    expect(effectiveLevel('none', 'admin')).toBe('none');
  });

  it('is the workspace level when the project says nothing', () => {
    expect(effectiveLevel('write', 'inherit')).toBe('write');
    expect(effectiveLevel('none', 'inherit')).toBe('none');
  });

  it('can only say the explicit choice while the workspace level is unknown', () => {
    expect(effectiveLevel(null, 'inherit')).toBeNull();
    expect(effectiveLevel(null, 'read')).toBe('read');
  });

  it('notices a level above the workspace level, which changes nothing', () => {
    expect(exceedsWorkspace('read', 'write')).toBe(true);
    expect(exceedsWorkspace('read', 'read')).toBe(false);
    expect(exceedsWorkspace('write', 'read')).toBe(false);
    expect(exceedsWorkspace('read', 'inherit')).toBe(false);
    expect(exceedsWorkspace(null, 'admin')).toBe(false);
  });
});

describe('summarizeStored (the "project limits" cell of the members table)', () => {
  it('says nothing is limited when nothing is stored', () => {
    expect(summarizeStored(null)).toEqual({ kind: 'inherits' });
    expect(summarizeStored({})).toEqual({ kind: 'inherits' });
  });

  it('names a single limit, an explicit "no access" included', () => {
    expect(summarizeStored({ models: 'read' })).toEqual({ kind: 'one', service: 'models', level: 'read' });
    expect(summarizeStored({ agents: 'none' })).toEqual({ kind: 'one', service: 'agents', level: 'none' });
  });

  it('counts several', () => {
    const summary = summarizeStored({ models: 'read', agents: 'none', tools: 'write' });
    expect(summary).toMatchObject({ kind: 'many', count: 3 });
    expect((summary as { entries: unknown[] }).entries).toHaveLength(3);
  });

  it('does not count the old "no access" the engine ignores', () => {
    expect(summarizeStored({ models: 'none', agents: 'none' }, ['models', 'agents'])).toEqual({ kind: 'inherits' });
    expect(summarizeStored({ models: 'none', agents: 'read' }, ['models'])).toEqual({ kind: 'one', service: 'agents', level: 'read' });
  });
});

describe('"no access" entries that have no effect', () => {
  it('names the stored entries a save drops', () => {
    expect(ignoredEntries({ models: 'none', agents: 'none', tools: 'read' }, ['models', 'tools'])).toEqual(['models']);
    expect(ignoredEntries({ models: 'none' }, [])).toEqual([]);
    expect(ignoredEntries(null, ['models'])).toEqual([]);
  });

  it('judges an entry from what the member can do: reached in the workspace and not narrowed by the project means not enforced', () => {
    const workspace = { models: 'write', agents: 'write', tools: 'none', prompts: 'read' };
    // models: the project narrows it (the entry bites); agents: no project setting narrows it (dead entry);
    // tools: the member does not reach it anyway (nothing to tell); prompts: reached and not narrowed (dead)
    expect(inferIgnoredNone(['models', 'agents', 'tools', 'prompts'], workspace, new Set(['models']))).toEqual(['agents', 'prompts']);
    expect(inferIgnoredNone([], workspace, new Set())).toEqual([]);
    // a service the workspace view does not name at all reads as not reached
    expect(inferIgnoredNone(['files'], workspace, new Set())).toEqual([]);
  });
});
