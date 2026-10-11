/**
 * People's names for the user ids a record carries (`uploadedBy`, owners, …), so a
 * screen can say "Ada Lovelace" instead of a 24-character id.
 *
 * Best effort and read-only: an id that is not a user (a system actor such as
 * `system:cron`, a deleted account, a malformed id) simply has no entry and the
 * caller shows what it has. A lookup that fails never fails the page it decorates.
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { DatabaseProvider } from '@/lib/database';

const logger = createLogger('user-display-names');

/** A page lists at most a few dozen people; this only bounds a pathological caller. */
const MAX_LOOKUPS = 100;

/** The name a person goes by: their name, else their e-mail address, else nothing. */
export function displayNameOf(user: { name?: string; email?: string } | null | undefined): string | undefined {
    const name = user?.name?.trim();
    if (name) return name;
    const email = user?.email?.trim();
    return email || undefined;
}

/** `id → display name` for the ids that belong to users of the tenant. */
export async function resolveUserDisplayNames(
    tenantDbName: string,
    ids: Iterable<string | null | undefined>,
    options: { db?: Pick<DatabaseProvider, 'findUserById'> & Partial<Pick<DatabaseProvider, 'switchToTenant'>> } = {},
): Promise<Map<string, string>> {
    const unique = [...new Set([...ids].filter((id): id is string => typeof id === 'string' && id.length > 0 && !id.includes(':')))]
        .slice(0, MAX_LOOKUPS);
    const names = new Map<string, string>();
    if (unique.length === 0) return names;
    try {
        const db = options.db ?? await getDatabase();
        if (!options.db && typeof db.switchToTenant === 'function') await db.switchToTenant(tenantDbName);
        await Promise.all(unique.map(async (id) => {
            try {
                const name = displayNameOf(await db.findUserById(id));
                if (name) names.set(id, name);
            } catch {
                // not a user id (or not loadable): no name for it
            }
        }));
    } catch (error) {
        logger.warn('Could not resolve user names', { error: error instanceof Error ? error.message : String(error) });
    }
    return names;
}

/** Each record with `uploadedByName` when its `uploadedBy` is a known user. */
export async function withUploaderNames<T extends { uploadedBy?: string }>(
    tenantDbName: string,
    records: T[],
    options?: Parameters<typeof resolveUserDisplayNames>[2],
): Promise<Array<T & { uploadedByName?: string }>> {
    const names = await resolveUserDisplayNames(tenantDbName, records.map((record) => record.uploadedBy), options);
    if (names.size === 0) return records;
    return records.map((record) => {
        const name = record.uploadedBy ? names.get(record.uploadedBy) : undefined;
        return name ? { ...record, uploadedByName: name } : record;
    });
}
