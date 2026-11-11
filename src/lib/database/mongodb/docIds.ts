import { ObjectId } from 'mongodb';

/**
 * Lenient document-id helpers shared by the Mongo mixins.
 *
 * Not the same as `objectIds.ts` (strict hex check, null on invalid input):
 * `toObjectIdOrThrow` constructs an ObjectId directly and throws on malformed
 * input, and `toIdString` maps a missing value to an empty string.
 */

/** The string form of a stored id; an empty string when there is none. */
export function toIdString(value: ObjectId | string | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : value.toString();
}

/** An ObjectId from its string form; throws when the string is not a valid id. */
export function toObjectIdOrThrow(id: string): ObjectId {
  return new ObjectId(id);
}
