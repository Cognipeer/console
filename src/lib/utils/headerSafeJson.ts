/**
 * JSON for an HTTP header value.
 *
 * A header value is ASCII (Node rejects anything above Latin-1 with `ERR_INVALID_CHAR`, and proxies mangle the rest),
 * but JSON text carries whatever the data holds: a file whose metadata says "Şirket Bütçesi İçin" or "報告書" or an
 * emoji would fail the whole response. Every character outside printable ASCII (0x20-0x7E) is written as a `\uXXXX`
 * escape instead, a UTF-16 code unit at a time, so an astral character becomes its surrogate pair of escapes. The
 * result is still valid JSON and `JSON.parse` returns the original value.
 *
 * Throws what `JSON.stringify` throws (a circular structure, a BigInt) and a `TypeError` for a value that has no JSON
 * text (`undefined`, a function, a symbol): callers that must not fail the response catch it and leave the header out.
 */
export function toHeaderSafeJson(value: unknown): string {
  const json = JSON.stringify(value) as string | undefined;
  if (json === undefined) {
    throw new TypeError('The value has no JSON representation.');
  }
  return json.replace(/[^ -~]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
