import { ProviderSettingsError } from '@/lib/providers/errors';
import { validateStorageTlsSettings } from '@/lib/security/storageTransport';
import { normalizeS3Endpoint, settingText, type S3CompatibleSettings, type S3Credentials } from './s3Helpers';

/**
 * The strict, save-time check of an S3 provider (`ProviderContract.validateSettings` of both S3 contracts): what is
 * typed into the form is refused with a message that names the field and says what to change. A runtime never repeats
 * these checks for a row that is already stored (see `s3Helpers.ts`), so a provider that works keeps working.
 *
 * Messages use the labels of the form and never echo a value that may be a credential.
 */

/** A region a custom endpoint is signed with: the store decides what it accepts, so dots and underscores pass. */
const REGION_FOR_CUSTOM_ENDPOINT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** Amazon S3 builds its host name from the region, so it has to be a plain host label. */
const REGION_FOR_AMAZON = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Anything but printable ASCII, and the characters that mean something in a URL or a path. */
const BUCKET_UNSAFE = /[^\x21-\x7e]|[/\\?#%]/;

/** A key or token with a space or a line break inside is a paste gone wrong, and Node refuses it as a header value. */
const BLANK_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;

function requireCredential(field: 'accessKeyId' | 'secretAccessKey', label: string, value: unknown): void {
  const text = settingText(value);
  if (!text) throw new ProviderSettingsError(field, `${label} is required.`);
  if (BLANK_OR_CONTROL.test(text)) throw new ProviderSettingsError(field, `${label} must not contain spaces or line breaks.`);
}

function checkSessionToken(value: unknown): void {
  if (value === undefined || value === null) return;
  const text = settingText(value);
  if (text && BLANK_OR_CONTROL.test(text)) {
    throw new ProviderSettingsError('sessionToken', 'Session token must not contain spaces or line breaks.');
  }
}

function checkRegion(raw: unknown, customEndpoint: boolean): void {
  const value = settingText(raw);
  if (!value) {
    if (customEndpoint) return;
    throw new ProviderSettingsError('region', 'Region is required for Amazon S3 (for example eu-central-1).');
  }
  if (!(customEndpoint ? REGION_FOR_CUSTOM_ENDPOINT : REGION_FOR_AMAZON).test(value)) {
    throw new ProviderSettingsError('region', 'Region must be a plain name such as us-east-1 or auto.');
  }
}

/** Structural check only: the store itself decides about upper case, underscores and dots. */
function checkBucket(raw: unknown): void {
  const value = settingText(raw);
  if (!value) throw new ProviderSettingsError('bucket', 'Bucket name is required.');
  if (value.includes('://') || BUCKET_UNSAFE.test(value)) {
    throw new ProviderSettingsError('bucket', 'Bucket name must be the bucket name only (no s3:// or https:// prefix, slashes, spaces or URL characters).');
  }
  if (value.length < 3 || value.length > 63) {
    throw new ProviderSettingsError('bucket', 'Bucket name must be 3-63 characters long.');
  }
}

function checkFlag(field: 'usePathStyleEndpoint' | 'createBucketIfMissing', label: string, value: unknown): void {
  if (value !== undefined && value !== null && typeof value !== 'boolean') {
    throw new ProviderSettingsError(field, `${label} must be true or false.`);
  }
}

export interface S3SettingsCheck {
  credentials: Partial<S3Credentials>;
  settings: Partial<S3CompatibleSettings>;
  /** S3-compatible storage has no regional endpoint to fall back on, so it needs one; Amazon S3 does not. */
  requireEndpoint: boolean;
}

/** Throws `ProviderSettingsError(field, message)` for the first problem found. */
export function validateS3Settings({ credentials, settings, requireEndpoint }: S3SettingsCheck): void {
  requireCredential('accessKeyId', 'Access key ID', credentials.accessKeyId);
  requireCredential('secretAccessKey', 'Secret access key', credentials.secretAccessKey);
  checkSessionToken(credentials.sessionToken);

  const endpoint = settingText(settings.endpoint);
  if (endpoint) {
    // Plain http is the provider's own choice on every deployment; the network policy applies to it either way.
    normalizeS3Endpoint(endpoint, { strict: true });
  } else if (requireEndpoint) {
    throw new ProviderSettingsError('endpoint', 'Endpoint URL is required (for example https://minio.internal:9000).');
  }
  checkRegion(settings.region, Boolean(endpoint));
  checkFlag('usePathStyleEndpoint', 'Use path-style addressing', settings.usePathStyleEndpoint);

  checkBucket(settings.bucket);
  if (settings.prefix !== undefined && settings.prefix !== null && typeof settings.prefix !== 'string') {
    throw new ProviderSettingsError('prefix', 'Bucket prefix must be text.');
  }
  checkFlag('createBucketIfMissing', 'Create bucket if missing', settings.createBucketIfMissing);

  validateStorageTlsSettings({
    caCertificate: settings.caCertificate,
    allowInsecureTls: settings.allowInsecureTls,
  });
}
