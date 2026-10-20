/**
 * What a bucket's name, description and prefix may be, as the forms hint it while the person types. The server
 * decides (`src/lib/services/files/bucketRules.ts` holds the rules, and a test keeps these limits and checks equal to
 * its): whatever it refuses comes back as a 400 `invalid_request` that names the field. Pure functions, no DOM.
 */

/** The longest bucket name, after trimming. */
export const BUCKET_NAME_MAX = 120;
/** The longest description, after trimming. */
export const BUCKET_DESCRIPTION_MAX = 1000;
/** The longest prefix, after the blanks and the slashes around it are dropped. */
export const BUCKET_PREFIX_MAX = 200;

/**
 * The prefix as the server keeps it: no blanks around it, no leading or trailing slash. A doubled slash inside is
 * taken for one (the server refuses an empty folder name, so the form quietly fixes what it can).
 */
export function normalizeBucketPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * What is wrong with a prefix, in the order the server checks:
 * - `tooLong`: more than `BUCKET_PREFIX_MAX` characters;
 * - `control`: a backslash or a control character;
 * - `dots`: a `.` folder, or `..` anywhere (a prefix cannot climb out of its folder).
 */
export type BucketPrefixFault = 'tooLong' | 'control' | 'dots';

export function bucketPrefixFault(raw: string): BucketPrefixFault | null {
  const prefix = normalizeBucketPrefix(raw);
  if (prefix === '') return null;
  if (prefix.length > BUCKET_PREFIX_MAX) return 'tooLong';
  if (/[\\\u0000-\u001f\u007f]/.test(prefix)) return 'control';
  if (prefix.includes('..') || prefix.split('/').some((folder) => folder === '.')) return 'dots';
  return null;
}

export type BucketNameFault = 'required' | 'tooLong';

export function bucketNameFault(raw: string): BucketNameFault | null {
  const name = raw.trim();
  if (!name) return 'required';
  return name.length > BUCKET_NAME_MAX ? 'tooLong' : null;
}

export type BucketDescriptionFault = 'tooLong';

export function bucketDescriptionFault(raw: string): BucketDescriptionFault | null {
  return raw.trim().length > BUCKET_DESCRIPTION_MAX ? 'tooLong' : null;
}
