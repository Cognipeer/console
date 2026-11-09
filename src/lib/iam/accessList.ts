/**
 * Access lists of shared resources (`IResourceAccessList`): who may USE a project's MCP server or skill in an agent run.
 *
 * The list is stored on the record and is the record's built-in policy: its entity carries `mode`, `allowedUsers` and
 * `allowedGroups` (the portal's own `accessAttrs`, so the typed-reference rule and the slicing of a long list to the
 * requester are the same code) and the managed `access` rules (managedPolicies.ts) read them. The decision is asked by
 * the agent runtime for the PERSON a run is made for (`authorizeResourceForPerson`, resourceAuthz.ts).
 *
 * Reading is lenient where it must be and strict where it matters:
 *  - no list at all (a record from before this field, or one that never set it) is `all`, so nothing changes for it;
 *  - a list that is there but cannot be read admits nobody (`selected`, empty), never everybody.
 */

import type { IResourceAccessList } from '@/lib/database';
import { ACCESS_LIST_RESOURCES, type AccessListResourceType } from './accessListCatalog';
import type { IamChannel } from './context';
import type { IamResource } from './entities';
import { accessAttrs, type PortalRequester } from './portalEntities';

/** The most people + groups one list may name; a larger audience belongs in a group. */
export const MAX_ACCESS_LIST_ENTRIES = 500;
const MAX_ID_LENGTH = 128;

export function openAccessList(): IResourceAccessList {
  return { mode: 'all', userIds: [], groupIds: [] };
}

const ids = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id && id.length <= MAX_ID_LENGTH && !out.includes(id)) out.push(id);
  }
  return out;
};

/** The stored list as the runtime and the views read it (see the header for absent and unreadable lists). */
export function readAccessList(value: unknown): IResourceAccessList {
  if (value === null || value === undefined) return openAccessList();
  if (typeof value !== 'object' || Array.isArray(value)) return { mode: 'selected', userIds: [], groupIds: [] };
  const raw = value as Record<string, unknown>;
  return {
    mode: raw.mode === 'all' ? 'all' : 'selected',
    userIds: ids(raw.userIds),
    groupIds: ids(raw.groupIds),
  };
}

/** True when the list lets everyone who can run the agent use the resource. */
export function isOpenAccessList(value: unknown): boolean {
  return readAccessList(value).mode === 'all';
}

export type AccessListInputResult =
  | { ok: true; access: IResourceAccessList }
  | { ok: false; error: string };

/**
 * An `access` field of a create / update body. Strict: a typo must never quietly open a resource or empty its list.
 * The people and groups a `mode: 'all'` list names are kept, so switching back to `selected` restores them.
 */
export function parseAccessListInput(value: unknown): AccessListInputResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'access must be an object { mode, userIds, groupIds }' };
  }
  const raw = value as Record<string, unknown>;
  if (raw.mode !== 'all' && raw.mode !== 'selected') {
    return { ok: false, error: 'access.mode must be "all" or "selected"' };
  }
  for (const field of ['userIds', 'groupIds'] as const) {
    const list = raw[field];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.trim() === '' || item.length > MAX_ID_LENGTH)) {
      return { ok: false, error: `access.${field} must be an array of ids` };
    }
  }
  const access: IResourceAccessList = { mode: raw.mode, userIds: ids(raw.userIds), groupIds: ids(raw.groupIds) };
  if (access.userIds.length + access.groupIds.length > MAX_ACCESS_LIST_ENTRIES) {
    return { ok: false, error: `access may name at most ${MAX_ACCESS_LIST_ENTRIES} people and groups` };
  }
  return { ok: true, access };
}

export interface AccessListSubject {
  type: AccessListResourceType;
  /** The registry id of the record (its `_id`). */
  id: string;
  projectId?: string | null;
  key?: string;
  access: unknown;
}

/** The resource of `<type>.use`: the record, with its access list as attributes. */
export function accessListResource(subject: AccessListSubject, requester?: PortalRequester): IamResource {
  const access = readAccessList(subject.access);
  return {
    kind: 'resource',
    type: subject.type,
    id: subject.id,
    service: ACCESS_LIST_RESOURCES[subject.type].service,
    projectId: subject.projectId ?? null,
    ...(subject.key ? { key: subject.key } : {}),
    attrs: accessAttrs({ mode: access.mode, userIds: access.userIds, groupIds: access.groupIds }, requester),
  };
}

/**
 * The IAM channel of an agent run, from the source its runtime context was stamped with: what a custom rule that
 * names a channel (`context.channel == "portal"`) sees. A run with no recognisable source is a dashboard one.
 */
export function iamChannelOfRunSource(source: unknown): IamChannel {
  switch (source) {
    case 'portal':
      return 'portal';
    case 'messaging':
      return 'messaging';
    case 'api':
    case 'a2a':
    case 'mcp':
    case 'realtime':
      return 'api';
    default:
      return 'dashboard';
  }
}
