/**
 * The "Create bucket" screen as pure functions: the key a name turns into, what the form accepts, where the files
 * will be stored, the request it sends, and what a refused request is about.
 *
 * These are the form's hints, so a mistake shows while the person is typing. The server decides: whatever it
 * refuses comes back and is shown on the field it is about (see `classifyCreateFailure`).
 */

import { isFilesApiError, type CreateBucketInput, type FileProviderListItem } from '../filesApi';
import { isLocalDiskProvider } from '../list/providerModel';
import { bucketDescriptionFault, bucketNameFault, bucketPrefixFault, normalizeBucketPrefix } from '../shared/bucketRules';

// The limits and the prefix rules are shared with the bucket's Settings tab (`shared/bucketRules.ts`).
export { BUCKET_DESCRIPTION_MAX, BUCKET_NAME_MAX, BUCKET_PREFIX_MAX, normalizeBucketPrefix } from '../shared/bucketRules';

/** The longest key a bucket is created with. */
export const BUCKET_KEY_MAX = 64;
/** The longest key the name alone turns into; a key typed by hand may be longer, up to `BUCKET_KEY_MAX`. */
export const BUCKET_AUTO_KEY_MAX = 40;

/* ── The key ─────────────────────────────────────────────────────────────── */

/** Letters whose accent is not a combining mark, so the accent-stripping below would leave them as they are. */
const SPECIAL_LETTERS: Readonly<Record<string, string>> = {
  İ: 'i',
  ı: 'i',
  ß: 'ss',
  Æ: 'ae',
  æ: 'ae',
  Œ: 'oe',
  œ: 'oe',
  Ø: 'o',
  ø: 'o',
  Đ: 'd',
  đ: 'd',
  Ł: 'l',
  ł: 'l',
};

/**
 * What a name turns into as a key: lowercase letters and digits, words joined by one hyphen, accents dropped
 * ("Doküman Arşivi" → "dokuman-arsivi"). Empty when the name has nothing a key can be made of.
 */
export function slugifyBucketKey(name: string, max: number = BUCKET_AUTO_KEY_MAX): string {
  const plain = name
    .replace(/[İıßÆæŒœØøĐđŁł]/g, (letter) => SPECIAL_LETTERS[letter] ?? letter)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return plain
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** The key field takes lowercase and hyphens for spaces; anything else the person types stays and is flagged. */
export function normalizeKeyInput(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, '-');
}

/* ── What the form accepts ───────────────────────────────────────────────── */

export type NameIssue = 'required' | 'tooLong';
export type DescriptionIssue = 'tooLong';
export type KeyIssue = 'required' | 'invalid' | 'tooLong';
export type PrefixIssue = 'invalid' | 'tooLong';

export function bucketNameIssue(name: string): NameIssue | null {
  return bucketNameFault(name);
}

export function bucketDescriptionIssue(description: string): DescriptionIssue | null {
  return bucketDescriptionFault(description);
}

export function bucketKeyIssue(key: string): KeyIssue | null {
  const trimmed = key.trim();
  if (!trimmed) return 'required';
  if (/[^a-z0-9_-]/.test(trimmed)) return 'invalid';
  if (trimmed.length > BUCKET_KEY_MAX) return 'tooLong';
  return null;
}

/** A prefix is a path inside the provider: it cannot climb out of it, use backslashes or carry control characters. */
export function bucketPrefixIssue(raw: string): PrefixIssue | null {
  const fault = bucketPrefixFault(raw);
  if (fault === null) return null;
  return fault === 'tooLong' ? 'tooLong' : 'invalid';
}

/**
 * The folder the files of the bucket go in, inside the provider: the prefix typed, or - left empty - the key, which is
 * what the server does when a bucket is created without one.
 */
export function effectiveBucketPrefix(rawPrefix: string, key: string): string {
  return normalizeBucketPrefix(rawPrefix) || key.trim();
}

/* ── Where the files go ──────────────────────────────────────────────────── */

export type StoragePreview =
  /** No provider chosen yet. */
  | { kind: 'none' }
  /** This server's own disk: there is no address to show. */
  | { kind: 'localDisk' }
  /** The provider did not say where it keeps files. */
  | { kind: 'unknown' }
  /** `path` is the folder (ending in `/`), `example` the same with a file's place named. */
  | { kind: 'path'; path: string; example: string };

/** Where the files of the bucket will physically be, from the provider's location base and the folder. */
export function storagePreview(
  provider: Pick<FileProviderListItem, 'driver' | 'driverCapabilities' | 'storageLocationBase'> | null | undefined,
  folder: string,
  fileKeyLabel: string,
): StoragePreview {
  if (!provider) return { kind: 'none' };
  if (isLocalDiskProvider(provider)) return { kind: 'localDisk' };
  const base = provider.storageLocationBase;
  if (typeof base !== 'string' || !base) return { kind: 'unknown' };
  const root = base.endsWith('/') ? base : `${base}/`;
  const path = folder ? `${root}${folder}/` : root;
  return { kind: 'path', path, example: `${path}${fileKeyLabel}` };
}

/* ── The request ─────────────────────────────────────────────────────────── */

export interface CreateBucketFormValues {
  providerKey: string;
  name: string;
  key: string;
  description: string;
  prefix: string;
  active: boolean;
}

/** The body of the create request. An empty prefix is left out (the server then uses the key). */
export function buildCreateBucketInput(values: CreateBucketFormValues): CreateBucketInput {
  const description = values.description.trim();
  const prefix = normalizeBucketPrefix(values.prefix);
  return {
    key: values.key.trim(),
    name: values.name.trim(),
    providerKey: values.providerKey,
    ...(description ? { description } : {}),
    ...(prefix ? { prefix } : {}),
    status: values.active ? 'active' : 'disabled',
  };
}

/* ── A refused request ───────────────────────────────────────────────────── */

/** The field of the form a refusal is about; `null` = the form as a whole. */
export type FailureField = 'name' | 'key' | 'prefix' | 'provider';

export type CreateFailure =
  /** 409: a bucket with this key exists. `key` is the key that was sent. */
  | { kind: 'duplicateKey'; key: string }
  /** 409 `provider_inactive` / 400 `provider_missing`: the provider chosen cannot take a bucket. */
  | { kind: 'providerUnusable' }
  /** 429: a quota. The server says which one. */
  | { kind: 'quota'; message: string }
  | { kind: 'forbidden' }
  | { kind: 'network' }
  /** 400: the server did not accept a value. `message` is its reason. */
  | { kind: 'invalid'; field: FailureField | null; message: string }
  | { kind: 'other'; message: string | null };

function fieldOfMessage(message: string): FailureField | null {
  const required = /^\s*(\w+)\s+is required/i.exec(message);
  const word = required?.[1]?.toLowerCase();
  if (word === 'providerkey') return 'provider';
  if (word === 'key' || word === 'name') return word;
  if (/\bprefix\b/i.test(message)) return 'prefix';
  if (/\bprovider\b/i.test(message)) return 'provider';
  if (/\bkey\b/i.test(message)) return 'key';
  if (/\bname\b/i.test(message)) return 'name';
  return null;
}

/** What a failed create is about, so the form can say it where it belongs. `sentKey` is the key of the request. */
export function classifyCreateFailure(error: unknown, sentKey: string): CreateFailure {
  if (!isFilesApiError(error)) return { kind: 'other', message: null };
  if (error.status === 0) return { kind: 'network' };
  if (error.status === 403) return { kind: 'forbidden' };
  if (error.code === 'provider_inactive' || error.code === 'provider_missing') return { kind: 'providerUnusable' };
  if (error.status === 409 && (!error.code || error.code === 'duplicate_key')) return { kind: 'duplicateKey', key: sentKey };
  if (error.status === 429) return { kind: 'quota', message: error.message };
  if (error.status === 400) {
    return { kind: 'invalid', field: fieldOfMessage(error.message), message: error.message };
  }
  return { kind: 'other', message: error.message.trim() || null };
}
