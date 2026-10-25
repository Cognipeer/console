/**
 * Reading a PATCH body into an update that names only the fields the body carries.
 *
 * An absent key has to stay absent all the way to the store: a Mongo `$set` of
 * `undefined` is stored as `null`, so copying `body.x as string | undefined`
 * into an update wipes every field the caller did not mention. These readers
 * copy a field across only when the body has it, and they say what it may hold:
 * a required field, when sent, is non-empty text (it is never cleared), and a
 * clearable one takes `null` to clear it.
 *
 * Each returns the sentence for the 400, or null when the field was fine (or
 * absent), so a route chains them with `??`.
 */

type Body = Record<string, unknown>;

/** A field that cannot be cleared: when the body sends it, it must be non-empty text; stored trimmed. */
export function readRequiredText<K extends string>(body: Body, key: K, into: { [P in K]?: string }): string | null {
  const value = body[key];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) return `${key} must be a non-empty string`;
  into[key] = value.trim();
  return null;
}

/**
 * An optional text field: `null` clears it, text replaces it. With
 * `blankClears` (a model key, where an empty string means "none") blank text
 * clears too and anything else is stored trimmed.
 */
export function readClearableText<K extends string>(
  body: Body,
  key: K,
  into: { [P in K]?: string | null },
  options: { blankClears?: boolean } = {},
): string | null {
  const value = body[key];
  if (value === undefined) return null;
  if (value === null) {
    into[key] = null;
    return null;
  }
  if (typeof value !== 'string') return `${key} must be a string or null`;
  const text = options.blankClears ? value.trim() : value;
  into[key] = options.blankClears && !text ? null : text;
  return null;
}
