/**
 * Channel library references, resolved at dispatch time.
 *
 * A rule lists `{ type: 'library', libraryId }` next to its inline channels.
 * Right before delivery each reference is swapped for the stored library
 * channel, so editing a library entry rotates every rule that uses it. A
 * reference whose entry is gone (or unreadable) is reported, never thrown.
 */

import { getTenantDatabase } from '@/lib/database';
import type { IAlertChannel, IAlertChannelLibraryEntry } from '@/lib/database';

export const CHANNEL_MISSING = 'channel_missing';

export type LibraryRef = Extract<IAlertChannel, { type: 'library' }>;

export function isLibraryRef(channel: IAlertChannel | undefined | null): channel is LibraryRef {
  return Boolean(channel) && channel!.type === 'library';
}

export type ResolvedChannel =
  | { ref: IAlertChannel; channel: IAlertChannel; entry?: undefined; missing?: undefined }
  | { ref: LibraryRef; channel: IAlertChannel; entry: IAlertChannelLibraryEntry; missing?: undefined }
  | { ref: LibraryRef; missing: true; channel?: undefined; entry?: undefined };

/**
 * Positionally aligned with the input: inline channels pass through, a
 * resolvable reference becomes its library channel (keeping the rule-local
 * channel id so delivery records stay stable), the rest are `missing`.
 */
export async function resolveLibraryChannels(
  channels: IAlertChannel[],
  scope: { tenantDbName: string; tenantId: string },
): Promise<ResolvedChannel[]> {
  const list = channels ?? [];
  const ids = [...new Set(list.filter(isLibraryRef).map((ref) => ref.libraryId))];
  const entries = new Map<string, IAlertChannelLibraryEntry>();
  if (ids.length > 0) {
    try {
      const db = await getTenantDatabase(scope.tenantDbName);
      await Promise.all(
        ids.map(async (id) => {
          const entry = await db.findAlertChannelLibraryEntry(id);
          if (entry && entry.tenantId === scope.tenantId) entries.set(id, entry);
        }),
      );
    } catch {
      // unreadable library: every reference reads as missing
    }
  }
  return list.map((channel): ResolvedChannel => {
    if (!isLibraryRef(channel)) return { ref: channel, channel };
    const entry = entries.get(channel.libraryId);
    if (!entry) return { ref: channel, missing: true };
    return { ref: channel, entry, channel: { ...entry.config, id: channel.id ?? entry.config.id } as IAlertChannel };
  });
}
