/**
 * Config references: an env variable or secret that takes its value from a Config item (or every item of a
 * Config group) instead of a typed value.
 *
 * What is stored is the reference (ids, never a value): `IConfigValueRef` per variable, `IConfigGroupRef` per
 * bound group. A write sends either the stored shape or a key to look up; `normalizeConfigValueRefs` /
 * `normalizeConfigGroupRefs` turn both into the stored shape and refuse what cannot be used. The value is read
 * only when it is used (`resolveConfigRefs`), so a value changed in Config reaches the next agent run or
 * sandbox launch.
 *
 * Rules:
 *  - a reference resolves by id, and only to an item of the project it is used in (an item key is unique only
 *    within its group, and a key lookup without a project would search every project);
 *  - a bound group gives one variable per item, named after the item key (`envNameFromConfigKey`); a name set
 *    explicitly (a typed value or a single-item reference) wins, and between two items of the bound groups
 *    that end up with the same name the first one (group order, then key order) wins;
 *  - every secret value read here is written to the config audit log as a `read` by `performedBy`.
 */

import {
  getDatabase,
  type DatabaseProvider,
  type IConfigGroup,
  type IConfigGroupRef,
  type IConfigItem,
  type IConfigValueRef,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  CONFIG_ENV_NAME_RE,
  MAX_CONFIG_GROUP_REFS,
  MAX_CONFIG_VALUE_REFS,
  envNameFromConfigKey,
} from '@/lib/config/configRefShared';
import { openConfigItemValue } from './configService';

const logger = createLogger('config:refs');

// ── Write side ───────────────────────────────────────────────────────────

/** Why a reference in a write cannot be stored. `field` is the path of the offending entry. */
export interface ConfigRefIssue {
  field: string;
  message: string;
}

/** The project's groups and items, loaded once per write (a project holds few of them). */
export interface ProjectConfigIndex {
  projectId: string;
  groups: IConfigGroup[];
  items: IConfigItem[];
}

export async function loadProjectConfigIndex(db: DatabaseProvider, projectId: string): Promise<ProjectConfigIndex> {
  const [groups, items] = await Promise.all([
    db.listConfigGroups({ projectId }),
    db.listConfigItems({ projectId }),
  ]);
  return { projectId, groups, items };
}

/** A row belongs to the project when it carries the project's id (rows from before projects carry none). */
function inProject(row: { projectId?: string | null }, projectId: string): boolean {
  return !row.projectId || row.projectId === projectId;
}

const idOf = (row: { _id?: unknown }): string => String(row._id ?? '');

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * A map of variable name -> reference from a write, in the stored shape. `undefined` input stays `undefined`
 * (the field was not sent); `null` or `{}` give `{}`.
 *
 * `allowSecret: false` refuses secret items (a plain environment variable is set on the machine itself, where
 * anything printed shows it): the agent's `envRefs`. Everything else allows them.
 */
export async function normalizeConfigValueRefs(
  db: DatabaseProvider,
  index: ProjectConfigIndex,
  input: unknown,
  field: string,
  opts: { allowSecret: boolean },
): Promise<{ refs: Record<string, IConfigValueRef> | undefined; issues: ConfigRefIssue[] }> {
  if (input === undefined) return { refs: undefined, issues: [] };
  if (input === null) return { refs: {}, issues: [] };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { refs: undefined, issues: [{ field, message: 'must be an object of variable name -> config reference' }] };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_CONFIG_VALUE_REFS) {
    return { refs: undefined, issues: [{ field, message: `at most ${MAX_CONFIG_VALUE_REFS} variables can take a config value` }] };
  }
  const refs: Record<string, IConfigValueRef> = {};
  const issues: ConfigRefIssue[] = [];
  for (const [name, raw] of entries) {
    const at = `${field}.${name}`;
    if (!CONFIG_ENV_NAME_RE.test(name)) {
      issues.push({ field: at, message: `invalid variable name "${name}": use letters, digits and underscore, not starting with a digit (max 128)` });
      continue;
    }
    const ref = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const configId = asString(ref.configId);
    const configKey = asString(ref.configKey) ?? (configId ? undefined : asString(ref.key));
    let item: IConfigItem | undefined;
    if (configId) {
      item = index.items.find((candidate) => idOf(candidate) === configId);
      if (!item) {
        const found = await db.findConfigItemById(configId).catch(() => null);
        if (found && inProject(found, index.projectId)) {
          item = found;
        } else {
          issues.push({
            field: at,
            message: found
              ? `config item "${found.key}" belongs to another project`
              : `config item ${configId} was not found`,
          });
          continue;
        }
      }
    } else if (configKey) {
      const matches = index.items.filter((candidate) => candidate.key === configKey);
      if (matches.length === 0) {
        issues.push({ field: at, message: `no config item with key "${configKey}" in this project` });
        continue;
      }
      if (matches.length > 1) {
        issues.push({ field: at, message: `more than one config item has the key "${configKey}" (in different groups): send its configId` });
        continue;
      }
      item = matches[0];
    } else {
      issues.push({ field: at, message: 'a config reference needs a configId or a configKey' });
      continue;
    }
    if (!opts.allowSecret && item.isSecret) {
      issues.push({
        field: at,
        message: `config item "${item.key}" is a secret: add it under secrets, where its value is passed per command and masked in output`,
      });
      continue;
    }
    refs[name] = { configId: idOf(item), key: item.key, ...(item.groupId ? { groupId: String(item.groupId) } : {}) };
  }
  return { refs, issues };
}

/**
 * A list of bound groups from a write, in the stored shape, without duplicates. `undefined` stays `undefined`;
 * `null` gives `[]`.
 */
export async function normalizeConfigGroupRefs(
  db: DatabaseProvider,
  index: ProjectConfigIndex,
  input: unknown,
  field: string,
): Promise<{ refs: IConfigGroupRef[] | undefined; issues: ConfigRefIssue[] }> {
  if (input === undefined) return { refs: undefined, issues: [] };
  if (input === null) return { refs: [], issues: [] };
  if (!Array.isArray(input)) {
    return { refs: undefined, issues: [{ field, message: 'must be a list of config group references' }] };
  }
  if (input.length > MAX_CONFIG_GROUP_REFS) {
    return { refs: undefined, issues: [{ field, message: `at most ${MAX_CONFIG_GROUP_REFS} config groups can be bound` }] };
  }
  const refs: IConfigGroupRef[] = [];
  const issues: ConfigRefIssue[] = [];
  const seen = new Set<string>();
  for (const [position, raw] of input.entries()) {
    const at = `${field}[${position}]`;
    const ref = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const groupId = asString(ref.groupId);
    const groupKey = asString(ref.groupKey) ?? (groupId ? undefined : asString(ref.key));
    let group: IConfigGroup | undefined;
    if (groupId) {
      group = index.groups.find((candidate) => idOf(candidate) === groupId);
      if (!group) {
        const found = await db.findConfigGroupById(groupId).catch(() => null);
        if (found && inProject(found, index.projectId)) {
          group = found;
        } else {
          issues.push({
            field: at,
            message: found ? `config group "${found.key}" belongs to another project` : `config group ${groupId} was not found`,
          });
          continue;
        }
      }
    } else if (groupKey) {
      group = index.groups.find((candidate) => candidate.key === groupKey);
      if (!group) {
        issues.push({ field: at, message: `no config group with key "${groupKey}" in this project` });
        continue;
      }
    } else {
      issues.push({ field: at, message: 'a config group reference needs a groupId or a groupKey' });
      continue;
    }
    const id = idOf(group);
    if (seen.has(id)) continue;
    seen.add(id);
    refs.push({ groupId: id, key: group.key });
  }
  return { refs, issues };
}

/**
 * Every config item and group a set of references points at (`item:<id>`, `group:<id>`). A write that points
 * at one its stored version did not needs Config read access; re-saving what is stored asks nothing.
 */
export function configRefTargets(input: {
  refs?: Array<Record<string, IConfigValueRef> | null | undefined>;
  groupRefs?: Array<IConfigGroupRef[] | null | undefined>;
}): Set<string> {
  const targets = new Set<string>();
  for (const map of input.refs ?? []) {
    for (const ref of Object.values(map ?? {})) if (ref?.configId) targets.add(`item:${ref.configId}`);
  }
  for (const list of input.groupRefs ?? []) {
    for (const ref of list ?? []) if (ref?.groupId) targets.add(`group:${ref.groupId}`);
  }
  return targets;
}

/** True when `next` points at a config item or group that `previous` does not. */
export function addsConfigTargets(next: Set<string>, previous: Set<string>): boolean {
  for (const target of next) if (!previous.has(target)) return true;
  return false;
}

// ── Use side ─────────────────────────────────────────────────────────────

export type ConfigRefProblemReason =
  /** The item or group no longer exists. */
  | 'missing'
  /** It exists, but not in the project the reference is used in. */
  | 'other_project'
  /** A secret whose value cannot be decrypted (the encryption key changed). */
  | 'unreadable'
  /** Used where there is no project to resolve in. */
  | 'no_project'
  /** An item of a bound group whose key gives no usable variable name. */
  | 'invalid_name'
  /** Two items of the bound groups give the same variable name; the first one is used. */
  | 'name_collision';

export interface ConfigRefProblem {
  reason: ConfigRefProblemReason;
  /** The variable, when the problem is about one. */
  name?: string;
  /** The item or group key (or id when the key is unknown). */
  source: string;
  message: string;
}

export interface ResolvedConfigVar {
  value: string;
  isSecret: boolean;
  /** Item key the value came from. */
  source: string;
  /** Item id the value came from. */
  configId: string;
}

export interface ResolveConfigRefsInput {
  tenantDbName: string;
  tenantId: string;
  /** The project the references are used in; `null` resolves nothing (each reference is a `no_project` problem). */
  projectId: string | null;
  refs?: Record<string, IConfigValueRef> | null;
  groupRefs?: IConfigGroupRef[] | null;
  /** Names set explicitly beside these references (typed values): a bound group never overrides them. */
  reservedNames?: Iterable<string>;
  /** Who reads, for the config audit log: `agent:<agentKey>`, `sandbox:<instanceId>`. */
  performedBy: string;
  /** An already switched tenant database; otherwise one is opened for `tenantDbName`. */
  db?: DatabaseProvider;
}

/** Problems that leave a variable out (as opposed to a name collision, where one value is still used). */
export function blockingConfigRefProblems(problems: ConfigRefProblem[]): ConfigRefProblem[] {
  return problems.filter((problem) => problem.reason !== 'name_collision');
}

/** One sentence per problem, for an error, a warning or the note the model gets. */
export function describeConfigRefProblems(problems: ConfigRefProblem[]): string {
  return problems.map((problem) => problem.message).join(' ');
}

const hasAny = (input: ResolveConfigRefsInput) =>
  Object.keys(input.refs ?? {}).length > 0 || (input.groupRefs ?? []).length > 0;

/**
 * The variables a set of references gives, read now. Explicit references win over bound groups. Never throws
 * for a reference that cannot be used: it is left out and reported in `problems` (the caller decides whether a
 * missing variable stops a launch or only warns).
 */
export async function resolveConfigRefs(input: ResolveConfigRefsInput): Promise<{
  vars: Record<string, ResolvedConfigVar>;
  problems: ConfigRefProblem[];
}> {
  const vars: Record<string, ResolvedConfigVar> = {};
  const problems: ConfigRefProblem[] = [];
  if (!hasAny(input)) return { vars, problems };

  const projectId = input.projectId;
  if (!projectId) {
    for (const [name, ref] of Object.entries(input.refs ?? {})) {
      problems.push({ reason: 'no_project', name, source: ref.key, message: `${name} (config item "${ref.key}") cannot be resolved without a project.` });
    }
    for (const ref of input.groupRefs ?? []) {
      problems.push({ reason: 'no_project', source: ref.key, message: `Config group "${ref.key}" cannot be resolved without a project.` });
    }
    return { vars, problems };
  }

  let db = input.db;
  if (!db) {
    db = await getDatabase();
    await db.switchToTenant(input.tenantDbName);
  }

  const explicitNames = new Set(Object.keys(input.refs ?? {}));
  const reserved = new Set(input.reservedNames ?? []);
  const audited = new Set<string>();

  const open = async (item: IConfigItem, name: string): Promise<string | null> => {
    try {
      const value = openConfigItemValue(item);
      if (item.isSecret && !audited.has(idOf(item))) {
        audited.add(idOf(item));
        await db!.createConfigAuditLog({
          tenantId: input.tenantId,
          projectId,
          configKey: item.key,
          action: 'read',
          version: item.version,
          performedBy: input.performedBy,
        }).catch((error: unknown) => logger.warn('Could not write the config read audit entry', { key: item.key, error: String(error) }));
      }
      return value;
    } catch {
      logger.error('A referenced config secret cannot be decrypted', { key: item.key });
      problems.push({ reason: 'unreadable', name, source: item.key, message: `${name} (config item "${item.key}") cannot be decrypted; its value has to be entered again in Config.` });
      return null;
    }
  };

  // Bound groups first, so an explicit reference to the same name replaces the group's value.
  const fromGroups = new Map<string, string>();
  for (const ref of input.groupRefs ?? []) {
    const group = await db.findConfigGroupById(ref.groupId).catch(() => null);
    if (!group) {
      problems.push({ reason: 'missing', source: ref.key, message: `Config group "${ref.key}" was deleted.` });
      continue;
    }
    if (!inProject(group, projectId)) {
      problems.push({ reason: 'other_project', source: group.key, message: `Config group "${group.key}" is not in this project.` });
      continue;
    }
    const items = (await db.listConfigItems({ projectId, groupId: idOf(group) }))
      .slice()
      .sort((a, b) => a.key.localeCompare(b.key));
    for (const item of items) {
      const name = envNameFromConfigKey(item.key);
      if (!name) {
        problems.push({ reason: 'invalid_name', source: item.key, message: `Config item "${item.key}" in group "${group.key}" gives no usable variable name and is skipped.` });
        continue;
      }
      if (reserved.has(name) || explicitNames.has(name)) continue;
      const earlier = fromGroups.get(name);
      if (earlier) {
        problems.push({ reason: 'name_collision', name, source: item.key, message: `${name} comes from both "${earlier}" and "${item.key}"; "${earlier}" is used.` });
        continue;
      }
      const value = await open(item, name);
      if (value === null) continue;
      fromGroups.set(name, item.key);
      vars[name] = { value, isSecret: item.isSecret, source: item.key, configId: idOf(item) };
    }
  }

  for (const [name, ref] of Object.entries(input.refs ?? {})) {
    const item = await db.findConfigItemById(ref.configId).catch(() => null);
    if (!item) {
      problems.push({ reason: 'missing', name, source: ref.key, message: `${name} uses config item "${ref.key}", which was deleted.` });
      continue;
    }
    if (!inProject(item, projectId)) {
      problems.push({ reason: 'other_project', name, source: item.key, message: `${name} uses config item "${item.key}", which is not in this project.` });
      continue;
    }
    const value = await open(item, name);
    if (value === null) continue;
    vars[name] = { value, isSecret: item.isSecret, source: item.key, configId: idOf(item) };
  }

  return { vars, problems };
}

/** Plain name -> value map of resolved variables (optionally only the secret or only the non-secret ones). */
export function configVarValues(
  vars: Record<string, ResolvedConfigVar>,
  only?: 'secret' | 'plain',
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, resolved] of Object.entries(vars)) {
    if (only === 'secret' && !resolved.isSecret) continue;
    if (only === 'plain' && resolved.isSecret) continue;
    out[name] = resolved.value;
  }
  return out;
}
