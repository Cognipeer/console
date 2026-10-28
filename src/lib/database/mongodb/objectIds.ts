/**
 * ObjectId strings as the Knowledge Engine mixins hand them around: 24 hex
 * characters, the form every document / folder / link id is stored and returned
 * in. `new ObjectId(x)` throws on anything else (and quietly accepts any
 * 12-character string), so a lookup by a malformed id goes through here and
 * simply finds nothing, as it does on SQLite.
 */

import { ObjectId } from 'mongodb';

export const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/** The ObjectId named by `id`, or null when `id` is not one. */
export function toObjectId(id: unknown): ObjectId | null {
  return typeof id === 'string' && OBJECT_ID_HEX.test(id) ? new ObjectId(id) : null;
}

/** The distinct ObjectIds among `ids`; strings that are not one cannot name a record and are skipped. */
export function toObjectIds(ids: readonly unknown[]): ObjectId[] {
  const hex = ids.filter((id): id is string => typeof id === 'string' && OBJECT_ID_HEX.test(id));
  return [...new Set(hex.map((id) => id.toLowerCase()))].map((id) => new ObjectId(id));
}
