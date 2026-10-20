/**
 * The credential fields of the storage providers (S3-compatible, Azure Blob) are redacted wherever a
 * settings or credentials object reaches a log line: the app logger and the persisted-log scrubber share
 * one key rule (`SENSITIVE_KEY_PATTERN`). Names that merely contain a sensitive word stay readable.
 */
import { describe, expect, it } from 'vitest';
import winston from 'winston';
import { redactSecretsFormat, SENSITIVE_KEY_PATTERN } from '@/lib/core/logger';
import { LOG_SECRET_MASK, redactLogPayload } from '@/lib/services/logRedaction';

/** `value[path[0]][path[1]]...` for a JSON-shaped value. */
function at(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((current, key) => (current as Record<string, unknown>)[key], value);
}

function serialize(meta: Record<string, unknown>): Record<string, unknown> {
  const pipeline = winston.format.combine(
    redactSecretsFormat(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  );
  const info = pipeline.transform({ level: 'info', message: 'storage provider', ...meta }, {}) as Record<string, unknown> | false;
  if (!info) throw new Error('format pipeline dropped the log entry');
  return JSON.parse(info[Symbol.for('message') as unknown as string] as string);
}

const STORAGE_SECRET_KEYS = [
  'accountKey', 'account_key', 'AccountKey', 'account-key',
  'sasToken', 'sas_token', 'SasToken',
  'connectionString', 'connection_string', 'ConnectionString',
  'secretAccessKey', 'secret_access_key', 'secretKey', 'secret_key',
  'sessionToken', 'session_token',
  'clientSecret', 'client_secret',
];

const HARMLESS_KEYS = [
  'tokenCount', 'tokens', 'maxTokens', 'accountName', 'accountId', 'account', 'accessKeyId',
  'sessionId', 'sessionCount', 'connectionTimeout', 'connectionCount', 'keyCount', 'secretsCount',
  'sasUrlHost', 'bucket', 'container', 'endpoint', 'authMethod', 'caCertificate', 'allowInsecureTls',
];

describe('SENSITIVE_KEY_PATTERN — storage credentials', () => {
  it('matches the credential fields of the storage providers, in every spelling', () => {
    for (const key of STORAGE_SECRET_KEYS) expect(SENSITIVE_KEY_PATTERN.test(key), key).toBe(true);
  });

  it('keeps matching what it matched before', () => {
    for (const key of ['apiKey', 'api_key', 'password', 'token', 'accessToken', 'refresh_token', 'authorization', 'privateKey', 'awsSecret']) {
      expect(SENSITIVE_KEY_PATTERN.test(key), key).toBe(true);
    }
  });

  it('does not match names that only contain a sensitive word', () => {
    for (const key of HARMLESS_KEYS) expect(SENSITIVE_KEY_PATTERN.test(key), key).toBe(false);
  });
});

describe('logger — storage provider credentials are redacted', () => {
  it('redacts them at the top level of a log call', () => {
    const line = serialize({ accountKey: 'k1', sasToken: 'sv=2022&sig=abc', connectionString: 'AccountKey=zzz', secretAccessKey: 's3', sessionToken: 'st', clientSecret: 'cs' });
    for (const key of ['accountKey', 'sasToken', 'connectionString', 'secretAccessKey', 'sessionToken', 'clientSecret']) {
      expect(line[key], key).toBe('[REDACTED]');
    }
    expect(JSON.stringify(line)).not.toMatch(/sig=abc|AccountKey=zzz/);
  });

  it('redacts them inside nested credentials and settings objects, in arrays and on errors', () => {
    const line = serialize({
      provider: {
        driver: 'azure-blob-files',
        credentials: { account_key: 'k1', sas_token: 'tok', connection_string: 'cs', secret_access_key: 's3' },
        settings: { accountName: 'acct', container: 'files' },
      },
      history: [{ sessionToken: 'st-1' }, { sessionToken: 'st-2', note: 'kept' }],
      error: Object.assign(new Error('upload failed'), { accountKey: 'k2', statusCode: 403 }),
    });
    expect(at(line, 'provider', 'credentials')).toEqual({ account_key: '[REDACTED]', sas_token: '[REDACTED]', connection_string: '[REDACTED]', secret_access_key: '[REDACTED]' });
    expect(at(line, 'provider', 'settings')).toEqual({ accountName: 'acct', container: 'files' });
    expect(line.history).toEqual([{ sessionToken: '[REDACTED]' }, { sessionToken: '[REDACTED]', note: 'kept' }]);
    expect(at(line, 'error', 'message')).toBe('upload failed');
    expect(at(line, 'error', 'accountKey')).toBe('[REDACTED]');
    expect(at(line, 'error', 'statusCode')).toBe(403);
  });

  it('leaves harmless fields readable', () => {
    const line = serialize({ tokenCount: 42, accountName: 'acct', sessionId: 's-1', connectionTimeout: 5000, bucket: 'files' });
    expect(line).toMatchObject({ tokenCount: 42, accountName: 'acct', sessionId: 's-1', connectionTimeout: 5000, bucket: 'files' });
  });
});

describe('persisted-log scrubber — storage provider credentials', () => {
  it('masks them in a logged payload and keeps the rest', () => {
    const out = redactLogPayload({
      credentials: { accountKey: 'k1', sasToken: 'tok', connectionString: 'cs', secretAccessKey: 's3', sessionToken: 'st', clientSecret: 'cs2' },
      settings: { accountName: 'acct', tokenCount: 3 },
    });
    expect(at(out, 'credentials')).toEqual({
      accountKey: LOG_SECRET_MASK,
      sasToken: LOG_SECRET_MASK,
      connectionString: LOG_SECRET_MASK,
      secretAccessKey: LOG_SECRET_MASK,
      sessionToken: LOG_SECRET_MASK,
      clientSecret: LOG_SECRET_MASK,
    });
    expect(at(out, 'settings')).toEqual({ accountName: 'acct', tokenCount: 3 });
  });
});
