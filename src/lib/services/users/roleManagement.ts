/**
 * Whose role is decided by a directory: the people screens show it as "Managed by
 * your directory" and the role endpoint refuses to change it (`directory_managed`).
 *
 * An account's role is the directory's when its sign-in provider is a directory
 * whose connection syncs roles right now (`@/enterprise/directory-role-sync`, which
 * the enterprise overlay answers from the live connection settings). The owner is
 * never role-managed: the owner role is immutable and no directory can set or
 * take it away.
 *
 * One lookup answers for a whole page of people, and it is only made when the page
 * has an account that comes from a directory at all, so a workspace of local
 * accounts (and the community edition) pays nothing.
 */

import { resolveDirectoryRoleSyncProviders } from '@/enterprise/directory-role-sync';
import { isDirectoryManaged, providerOf } from '@/lib/iam/identity';

export interface RoleManagementTenant {
  tenantDbName: string;
  tenantId: string;
}

type PersonFacts = { role?: unknown; authProvider?: unknown };

const never = (): boolean => false;

/** A predicate telling whether the role of a given person of this workspace follows the directory. */
export async function roleManagedPredicate(
  tenant: RoleManagementTenant,
  people: readonly PersonFacts[],
): Promise<(person: PersonFacts) => boolean> {
  if (!people.some((person) => isDirectoryManaged(person))) return never;
  const providers = await resolveDirectoryRoleSyncProviders(tenant);
  if (providers.size === 0) return never;
  return (person) => person.role !== 'owner' && providers.has(providerOf(person));
}

/** Whether the role of this one person follows the directory. */
export async function isRoleManagedByDirectory(tenant: RoleManagementTenant, person: PersonFacts): Promise<boolean> {
  return (await roleManagedPredicate(tenant, [person]))(person);
}
