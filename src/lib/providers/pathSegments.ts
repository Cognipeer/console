/**
 * Names that end up as a part of a path on this server's disk: the key of a provider, the id of an organization, a
 * subdirectory a provider keeps its files in. The checks here are the narrowest that keep such a name inside the folder
 * it is joined to; they say nothing about whether a name is pleasant (spaces and dots are fine).
 */

/** A separator, or a character that is not text (NUL and the other control characters). */
const UNSAFE_IN_NAME = /[\\/\u0000-\u001f\u007f]/;

/**
 * One name of a path: text that is not empty, not `.` or `..`, and holds no separator and no control character. Joined to
 * a folder, it names something inside that folder and nothing else.
 */
export function isSafePathSegment(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value !== '.' && value !== '..' && !UNSAFE_IN_NAME.test(value);
}

/**
 * The names of a relative folder path (`a/b`, `a\b`; empty and `.` names are dropped), or undefined when it does not
 * stay inside the folder it is relative to: an absolute path or a drive (`/etc`, `C:\`), a `..`, or a name that is not
 * safe (see `isSafePathSegment`). An empty path is the folder itself: no names.
 */
export function relativeFolderNames(path: string): string[] | undefined {
  if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path)) return undefined;
  const names = path.split(/[\\/]+/).filter((name) => name !== '' && name !== '.');
  return names.every(isSafePathSegment) ? names : undefined;
}
