/**
 * The save-time check of the two S3 drivers (`validateSettings`): what is refused when a provider is created, edited
 * or tested, with the field named so the form can point at it.
 */
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { AwsS3FileProviderContract } from '@/lib/providers/contracts/awsS3Files.contract';
import { S3CompatibleFileProviderContract } from '@/lib/providers/contracts/s3Compatible.contract';
import { validateS3Settings } from '@/lib/providers/contracts/s3/s3Validation';
import { ProviderSettingsError } from '@/lib/providers/errors';

const KEYS = { accessKeyId: 'AKIATEST', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const ROOT_PEM = tls.rootCertificates[0];
const BASE = { endpoint: 'https://minio.internal:9000', bucket: 'cognipeer-files' };

type Validate = (input: { credentials: Record<string, unknown>; settings: Record<string, unknown>; isOnPrem: boolean }) => void | Promise<void>;
const validateCompatible = S3CompatibleFileProviderContract.validateSettings as unknown as Validate;
const validateAmazon = AwsS3FileProviderContract.validateSettings as unknown as Validate;

function problem(run: () => unknown): ProviderSettingsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderSettingsError);
    return error as ProviderSettingsError;
  }
  throw new Error('expected a ProviderSettingsError, nothing was thrown');
}

function compatible(settings: Record<string, unknown>, credentials: Record<string, unknown> = KEYS) {
  return () => validateS3Settings({ credentials, settings, requireEndpoint: true });
}

function amazon(settings: Record<string, unknown>, credentials: Record<string, unknown> = KEYS) {
  return () => validateS3Settings({ credentials, settings, requireEndpoint: false });
}

describe('S3-compatible storage settings', () => {
  it('accepts a complete provider, with or without the optional parts', () => {
    expect(compatible(BASE)).not.toThrow();
    expect(compatible({ ...BASE, region: 'auto', prefix: 'console/files', usePathStyleEndpoint: true, createBucketIfMissing: false })).not.toThrow();
    expect(compatible({ ...BASE, caCertificate: ROOT_PEM, allowInsecureTls: false })).not.toThrow();
    expect(compatible(BASE, { ...KEYS, sessionToken: 'FQoGZXIvYXdzE...token+with/base64==' })).not.toThrow();
    expect(compatible({ ...BASE, endpoint: 'http://[::1]:9000' })).not.toThrow();
    expect(compatible({ ...BASE, endpoint: 'https://gw.example.com/s3' })).not.toThrow();
  });

  // Where the endpoint may point (private networks, metadata addresses) is the network policy's job, at save and again
  // at runtime; the scheme is the provider's own choice on every deployment.
  it('takes plain http as well as https for the endpoint', () => {
    for (const endpoint of ['http://minio.example.com:9000', 'HTTP://minio.example.com', 'http://[::1]:9000', 'http://10.0.0.5/s3', 'HTTPS://gw.example.com/s3']) {
      expect(compatible({ ...BASE, endpoint }), endpoint).not.toThrow();
    }
  });

  it('takes a plain-http custom endpoint in the Amazon form too', () => {
    const settings = { bucket: 'abc', region: 'eu-central-1' };
    expect(amazon({ ...settings, endpoint: 'http://minio.example.com' })).not.toThrow();
    expect(amazon(settings)).not.toThrow();
  });

  it('answers the same through both contracts\' validateSettings, on a hosted and on a self-hosted deployment', () => {
    const settings = { ...BASE, region: 'us-east-1', endpoint: 'http://minio.example.com:9000' };
    for (const validate of [validateCompatible, validateAmazon]) {
      for (const isOnPrem of [false, true]) {
        expect(() => validate({ credentials: KEYS, settings, isOnPrem }), String(isOnPrem)).not.toThrow();
        expect(() => validate({ credentials: KEYS, settings: { ...settings, allowInsecureTls: true }, isOnPrem }), String(isOnPrem)).not.toThrow();
        expect(problem(() => validate({ credentials: KEYS, settings: { ...settings, endpoint: 'http://u:p@minio:9000' }, isOnPrem })).field).toBe('endpoint');
        expect(problem(() => validate({ credentials: KEYS, settings: { ...settings, allowInsecureTls: 'true' }, isOnPrem })).field).toBe('allowInsecureTls');
      }
    }
  });

  it('is what the contract runs through validateSettings', () => {
    expect(() => validateCompatible({ credentials: KEYS, settings: BASE, isOnPrem: true })).not.toThrow();
    expect(problem(() => validateCompatible({ credentials: KEYS, settings: { bucket: 'abc' }, isOnPrem: true })).field).toBe('endpoint');
    expect(problem(() => validateAmazon({ credentials: KEYS, settings: { bucket: 'abc' }, isOnPrem: true })).field).toBe('region');
  });

  it('requires an endpoint, with a scheme, and refuses what does not belong in one', () => {
    expect(problem(compatible({ bucket: 'abc' })).field).toBe('endpoint');
    expect(problem(compatible({ ...BASE, endpoint: '  ' })).field).toBe('endpoint');
    for (const endpoint of ['minio.internal:9000', 'minio.internal', 'ftp://minio.internal', 'http://', 'http://u:p@minio:9000', 'http://minio:9000?x=1', 'http://minio:9000#a']) {
      const error = problem(compatible({ ...BASE, endpoint }));
      expect(error.field, endpoint).toBe('endpoint');
      expect(error.code).toBe('provider_settings_invalid');
    }
  });

  it('refuses a region that is not a plain name, but lets a store pick odd ones', () => {
    for (const region of ['EU West', 'eu/west', 'eu west 1', '-x', 'x'.repeat(64), 'é']) {
      expect(problem(compatible({ ...BASE, region })).field, region).toBe('region');
    }
    for (const region of ['us-east-1', 'auto', 'default', 'garage', 'my_region', 'zone.1', 'cn-north-1']) {
      expect(compatible({ ...BASE, region }), region).not.toThrow();
    }
  });

  it('refuses a bucket that is not just a bucket name', () => {
    for (const bucket of [undefined, '', '  ', 's3://bucket', 'https://x/y', 'a/b', 'a\\b', 'with space', 'ab', 'x'.repeat(64), 'b?x', 'b#x', 'b%20', 'türkçe-bucket']) {
      expect(problem(compatible({ ...BASE, bucket })).field, String(bucket)).toBe('bucket');
    }
    for (const bucket of ['abc', 'my-bucket', 'my.bucket.name', 'My_Bucket', 'x'.repeat(63), '123']) {
      expect(compatible({ ...BASE, bucket }), bucket).not.toThrow();
    }
  });

  it('requires both keys, and refuses a key with white space inside, without echoing it', () => {
    expect(problem(compatible(BASE, { secretAccessKey: 'x' })).field).toBe('accessKeyId');
    expect(problem(compatible(BASE, { accessKeyId: '  ', secretAccessKey: 'x' })).field).toBe('accessKeyId');
    expect(problem(compatible(BASE, { accessKeyId: 'AK' })).field).toBe('secretAccessKey');
    expect(problem(compatible(BASE, { accessKeyId: 'AK', secretAccessKey: '' })).field).toBe('secretAccessKey');
    const spaced = problem(compatible(BASE, { accessKeyId: 'AK', secretAccessKey: 'hunter2 hunter2' }));
    expect(spaced.field).toBe('secretAccessKey');
    expect(spaced.message).not.toContain('hunter2');
    expect(problem(compatible(BASE, { accessKeyId: 'AK\nIA', secretAccessKey: 'x' })).field).toBe('accessKeyId');
    expect(problem(compatible(BASE, { ...KEYS, sessionToken: 'tok en' })).field).toBe('sessionToken');
    expect(compatible(BASE, { ...KEYS, sessionToken: '' })).not.toThrow();
  });

  it('wants true or false for the switches and text for the prefix', () => {
    expect(problem(compatible({ ...BASE, usePathStyleEndpoint: 'false' })).field).toBe('usePathStyleEndpoint');
    expect(problem(compatible({ ...BASE, createBucketIfMissing: 1 })).field).toBe('createBucketIfMissing');
    expect(problem(compatible({ ...BASE, prefix: 5 })).field).toBe('prefix');
    expect(compatible({ ...BASE, usePathStyleEndpoint: null, createBucketIfMissing: undefined, prefix: null })).not.toThrow();
  });

  describe('TLS', () => {
    it('refuses text that is no certificate, or holds a private key', () => {
      expect(problem(compatible({ ...BASE, caCertificate: 'hello' })).field).toBe('caCertificate');
      const withKey = problem(compatible({ ...BASE, caCertificate: `${ROOT_PEM}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----` }));
      expect(withKey.field).toBe('caCertificate');
      expect(withKey.message).not.toContain('AAAA');
    });

    it('lets a provider skip verification on any deployment', () => {
      expect(compatible({ ...BASE, allowInsecureTls: true })).not.toThrow();
      expect(compatible({ ...BASE, allowInsecureTls: false })).not.toThrow();
    });

    it('wants a real boolean for it', () => {
      for (const allowInsecureTls of ['false', 'true', 0, 1, {}]) {
        expect(problem(compatible({ ...BASE, allowInsecureTls })).field, String(allowInsecureTls)).toBe('allowInsecureTls');
      }
    });
  });
});

describe('Amazon S3 settings', () => {
  it('needs a region when no endpoint is set, and takes the default of a custom endpoint when it is', () => {
    expect(problem(amazon({ bucket: 'abc' })).field).toBe('region');
    expect(problem(amazon({ bucket: 'abc', region: '  ' })).field).toBe('region');
    expect(amazon({ bucket: 'abc', region: 'eu-central-1' })).not.toThrow();
    expect(amazon({ bucket: 'abc', endpoint: 'https://minio.internal:9000' })).not.toThrow();
    expect(amazon({ bucket: 'abc', endpoint: 'https://minio.internal:9000', region: 'us-east-1', usePathStyleEndpoint: false })).not.toThrow();
  });

  it('holds Amazon S3 to a region that is a host name part, and a custom endpoint to what a store accepts', () => {
    expect(problem(amazon({ bucket: 'abc', region: 'my_region' })).field).toBe('region');
    expect(problem(amazon({ bucket: 'abc', region: 'EU West' })).field).toBe('region');
    expect(amazon({ bucket: 'abc', region: 'my_region', endpoint: 'https://minio.internal:9000' })).not.toThrow();
  });

  it('checks the endpoint it is given, but does not need one', () => {
    expect(problem(amazon({ bucket: 'abc', region: 'eu-central-1', endpoint: 'minio.internal:9000' })).field).toBe('endpoint');
    expect(problem(amazon({ bucket: 'abc', region: 'eu-central-1', endpoint: 'https://u:p@minio.internal' })).field).toBe('endpoint');
  });

  it('holds the bucket, the keys and the TLS settings to the same rules', () => {
    expect(problem(amazon({ region: 'eu-central-1', bucket: 's3://abc' })).field).toBe('bucket');
    expect(problem(amazon({ region: 'eu-central-1', bucket: 'abc' }, { accessKeyId: 'x' })).field).toBe('secretAccessKey');
    expect(problem(amazon({ region: 'eu-central-1', bucket: 'abc', allowInsecureTls: 'yes' })).field).toBe('allowInsecureTls');
    expect(problem(amazon({ region: 'eu-central-1', bucket: 'abc', caCertificate: 'nope' })).field).toBe('caCertificate');
  });
});
