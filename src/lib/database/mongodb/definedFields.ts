/**
 * The fields of a partial update that may go into a `$set`.
 *
 * The driver stores an explicit `undefined` as `null`, so spreading a partial
 * `data` into `$set` wipes every field the caller left out. Only keys that hold
 * a value are kept; `null` is a value (it clears the field). The SQLite mixins
 * read `undefined` as "leave it alone" as well, and the two providers must not
 * disagree about that.
 */
export function definedFields(data: object): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key !== '_id' && value !== undefined) fields[key] = value;
  }
  return fields;
}
