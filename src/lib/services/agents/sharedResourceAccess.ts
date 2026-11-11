/**
 * May this agent run use a shared resource of its project: the tools of an MCP server, a skill?
 *
 * The record's access list (`IResourceAccessList`) is its built-in IAM policy (managed:access:*), asked for the PERSON
 * the run is made for (`ConsoleIdentityCaller.userId`: the signed-in person, an API token's owner, a trigger's
 * accountable person). The answer is used when the run is put together: a resource the person may not use is left out,
 * so the model never sees a tool or a skill it could not call.
 *
 *  - A run made for no person (a public endpoint, a `system:` caller) or one that reads as no one (a flow step, a
 *    shared messaging channel whose answer everyone there reads: `kbReader: 'anonymous'`) gets an open resource and
 *    never a restricted one.
 *  - With a person, the engine decides, so custom deny rules apply to open resources as well.
 *  - When the engine cannot decide, an open resource stays in the run and a restricted one stays out: an outage
 *    neither takes away what everyone had nor hands out what the list keeps from people.
 */

import { createLogger } from '@/lib/core/logger';
import { accessListResource, iamChannelOfRunSource, readAccessList } from '@/lib/iam/accessList';
import { ACCESS_LIST_RESOURCES, type AccessListResourceType } from '@/lib/iam/accessListCatalog';
import type { ConsoleIdentityCaller } from '@/lib/iam/consoleIdentity';
import { authorizeResourceForPerson } from '@/lib/iam/resourceAuthz';

const logger = createLogger('agent:shared-resource-access');

export interface SharedResourceRun {
  tenantDbName: string;
  tenantId: string;
  /** Who the run is made for, as the runtime describes the caller everywhere else. */
  caller?: ConsoleIdentityCaller;
  /** `runtimeContext.source`: the channel a custom rule may name. */
  source?: string;
}

export interface SharedResourceRecord {
  type: AccessListResourceType;
  /** The record's `_id`. */
  id: string;
  key?: string;
  projectId?: string | null;
  access?: unknown;
}

/** The person a run is made for, or undefined when it is made for no one (see the header). */
function personOf(caller: ConsoleIdentityCaller | undefined): string | undefined {
  if (!caller || caller.kbReader === 'anonymous') return undefined;
  const userId = caller.userId;
  if (!userId || userId.startsWith('system:')) return undefined;
  return userId;
}

export async function mayUseSharedResource(run: SharedResourceRun, record: SharedResourceRecord): Promise<boolean> {
  const open = readAccessList(record.access).mode === 'all';
  const person = personOf(run.caller);
  if (!person) return open;
  const result = await authorizeResourceForPerson({
    tenantDbName: run.tenantDbName,
    tenantId: run.tenantId,
    userId: person,
    channel: iamChannelOfRunSource(run.source ?? run.caller?.source),
    action: ACCESS_LIST_RESOURCES[record.type].action,
    resource: (requester) => accessListResource({
      type: record.type,
      id: record.id,
      projectId: record.projectId,
      key: record.key,
      access: record.access,
    }, requester),
    subject: record.key ? { resourceName: record.key } : {},
  });
  if (result.allowed) return true;
  if (result.unavailable) {
    logger.warn('Access to a shared resource could not be decided; open resources stay in the run, restricted ones stay out', {
      type: record.type,
      key: record.key,
      open,
      decisionId: result.decisionId,
    });
    return open;
  }
  return false;
}
