/**
 * Azure blob metadata is a narrow channel: names must be C# identifiers (no hyphen, no dot, no
 * non-ASCII), values must be ASCII header text, names are case-insensitive, everything together
 * may not exceed 8 KiB, and a newline is dropped silently. S3-style `{ originalName, ...custom }`
 * pass-through therefore fails (or corrupts) on exactly the data users have: Turkish and CJK file
 * names, caller metadata with hyphenated keys, nested values.
 *
 * Three fixed, prefixed ASCII keys are written instead:
 *   cp_checksum  sha256 of the bytes (hex)
 *   cp_name      the original file name, percent-encoded
 *   cp_meta      the caller's metadata as `b64u:` + base64url(JSON), types preserved
 *
 * The database record keeps the caller's metadata as it was given; this only has to carry enough to
 * rebuild a handle from the store alone (listing, importing, a record that was lost).
 */

export const META_CHECKSUM = 'cp_checksum';
export const META_NAME = 'cp_name';
export const META_CUSTOM = 'cp_meta';
const CUSTOM_PREFIX = 'b64u:';
/** Name + value bytes of every metadata pair together; the service limit is 8 KiB. */
export const METADATA_BUDGET_BYTES = 7 * 1024;
const MAX_NAME_CHARS = 255;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export interface BlobMetadataInput {
  checksum?: string;
  name?: string;
  custom?: Record<string, unknown>;
}

export interface BlobMetadataEncoding {
  metadata: Record<string, string>;
  /** Set when the caller's metadata could not be stored on the blob (too large, not serializable). */
  droppedCustom?: 'too-large' | 'unserializable';
}

function pairBytes(key: string, value: string): number {
  return key.length + value.length;
}

export function encodeBlobMetadata(input: BlobMetadataInput): BlobMetadataEncoding {
  const metadata: Record<string, string> = {};
  let used = 0;

  if (input.checksum && /^[a-f0-9]{64}$/i.test(input.checksum)) {
    metadata[META_CHECKSUM] = input.checksum.toLowerCase();
    used += pairBytes(META_CHECKSUM, metadata[META_CHECKSUM]);
  }
  if (input.name) {
    // encodeURIComponent throws on a lone surrogate, and cutting a name at a UTF-16 unit boundary
    // can split an emoji in two: repair first, then truncate by code points.
    const wellFormed = input.name.replace(LONE_SURROGATES, '�');
    const encoded = encodeURIComponent(Array.from(wellFormed).slice(0, MAX_NAME_CHARS).join(''));
    metadata[META_NAME] = encoded;
    used += pairBytes(META_NAME, encoded);
  }

  let droppedCustom: BlobMetadataEncoding['droppedCustom'];
  if (input.custom && Object.keys(input.custom).length > 0) {
    let json: string | undefined;
    try {
      json = JSON.stringify(input.custom);
    } catch {
      droppedCustom = 'unserializable';
    }
    if (json !== undefined) {
      const value = `${CUSTOM_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`;
      if (used + pairBytes(META_CUSTOM, value) > METADATA_BUDGET_BYTES) droppedCustom = 'too-large';
      else metadata[META_CUSTOM] = value;
    }
  }
  return { metadata, droppedCustom };
}

export interface DecodedBlobMetadata {
  checksum?: string;
  name?: string;
  custom?: Record<string, unknown>;
}

function stripForbidden(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!FORBIDDEN_KEYS.has(key)) out[key] = entry;
  }
  return out;
}

/**
 * Reads the keys `encodeBlobMetadata` writes. Anything else on the blob (written by other tools)
 * is ignored. Key case is folded: Azurite lowercases names, the service may keep the case sent.
 */
export function decodeBlobMetadata(raw: Record<string, string> | undefined): DecodedBlobMetadata {
  if (!raw) return {};
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) lowered[key.toLowerCase()] = value;

  const out: DecodedBlobMetadata = {};
  const checksum = lowered[META_CHECKSUM];
  if (checksum && /^[a-f0-9]{64}$/i.test(checksum)) out.checksum = checksum.toLowerCase();

  const name = lowered[META_NAME];
  if (name) {
    try {
      out.name = decodeURIComponent(name);
    } catch {
      out.name = name;
    }
  }

  const custom = lowered[META_CUSTOM];
  if (custom?.startsWith(CUSTOM_PREFIX)) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(custom.slice(CUSTOM_PREFIX.length), 'base64url').toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.custom = stripForbidden(parsed as Record<string, unknown>);
      }
    } catch {
      /* foreign or damaged value: the record in the database is the source of truth */
    }
  }
  return out;
}

/** ADLS Gen2 (hierarchical namespace) accounts list directories as zero-byte blobs carrying this flag. */
export function isDirectoryMarker(metadata: Record<string, string> | undefined, size: number | undefined): boolean {
  if (!metadata || (size ?? 0) !== 0) return false;
  return Object.entries(metadata).some(([key, value]) => key.toLowerCase() === 'hdi_isfolder' && value.toLowerCase() === 'true');
}
