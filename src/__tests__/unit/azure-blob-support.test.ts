/**
 * Unit tests - the pure parts of the Azure Blob file provider: names and keys, the metadata codec, endpoint and
 * credential resolution, error wording, the Microsoft Entra token source and the SDK pipeline.
 * No SDK instance, no network (the one SDK-shaped value is the in-memory fake).
 */
import https from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import {
  assertAccountKey,
  assertAccountName,
  assertContainerName,
  defaultAuthorityFor,
  describeAzureBlobLocation,
  parseConnectionString,
  parseSasToken,
  resolveAzureBlobConfig,
  resolveBlobEndpoint,
  secretValues,
  validateClientSecretConfig,
} from '@/lib/providers/contracts/azure/blobConfig';
import { createClientSecretCredential, STORAGE_SCOPE } from '@/lib/providers/contracts/azure/blobEntra';
import {
  AzureBlobError,
  authenticationHint,
  describeAzureError,
  describeFailure,
  invalidKeyError,
  isAzureBlobError,
  isBlobMissing,
  isContainerMissing,
  isHopelessFailure,
  isRetryableStatus,
  redactSecrets,
  withoutMissingPhrases,
  type AzureErrorInfo,
} from '@/lib/providers/contracts/azure/blobErrors';
import {
  asciiHeaderValue,
  assertBlobNameLimits,
  buildBasePrefix,
  generateKey,
  quoteEtag,
  sanitizeBlobKey,
  sanitizeListPrefix,
  sha256Hex,
} from '@/lib/providers/contracts/azure/blobKeys';
import {
  METADATA_BUDGET_BYTES,
  decodeBlobMetadata,
  encodeBlobMetadata,
  isDirectoryMarker,
} from '@/lib/providers/contracts/azure/blobMetadata';
import { buildPipeline, type AzureBlobSdk } from '@/lib/providers/contracts/azure/blobTransport';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { fakeSdkModule } from '../helpers/fakeAzureBlobSdk';

const KEY = Buffer.alloc(64, 3).toString('base64');
const SAS = 'sv=2022-11-02&sr=c&sp=racwdl&se=2099-01-01T00:00:00Z&sig=ab%2Bc%3D';
const CLIENT = '66666666-7777-8888-9999-000000000000';
const HEADER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_VALUE = /^[\x20-\x7e]*$/;

/** The ProviderSettingsError a call throws, or a failure naming what was thrown instead. */
function settingsError(run: () => unknown): ProviderSettingsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderSettingsError);
    return error as ProviderSettingsError;
  }
  throw new Error('expected a ProviderSettingsError, nothing was thrown');
}

describe('names', () => {
  it('account names: 3-24 lowercase letters and digits, folded and trimmed', () => {
    expect(assertAccountName(' MyAcct1 ')).toBe('myacct1');
    for (const bad of [undefined, '', 'ab', 'a'.repeat(25), 'my-acct', 'my.acct', 'https://x.blob.core.windows.net', 'acct/x']) {
      const error = settingsError(() => assertAccountName(bad));
      expect(error.field).toBe('accountName');
      expect(error.code).toBe('provider_settings_invalid');
    }
    expect(settingsError(() => assertAccountName('x', 'connectionString', 'AccountName in the connection string')).field).toBe('connectionString');
  });

  it('container names follow the service rules', () => {
    for (const ok of ['files', 'abc', 'a-b-c', 'a1b', 'x'.repeat(63)]) expect(assertContainerName(ok)).toBe(ok);
    expect(assertContainerName('  files  ')).toBe('files');
    for (const bad of [undefined, '', 'a', 'ab', 'a--b', '-abc', 'abc-', 'ABC', 'a_b', 'x'.repeat(64), 'a/b', 'a.b', '$root', '$web', '$logs']) {
      expect(settingsError(() => assertContainerName(bad)).field, String(bad)).toBe('container');
    }
  });
});

describe('blob keys', () => {
  it('normalises separators and trims slashes', () => {
    expect(sanitizeBlobKey('a//b/')).toBe('a/b');
    expect(sanitizeBlobKey('\\a\\b')).toBe('a/b');
    expect(sanitizeBlobKey('/x')).toBe('x');
    expect(sanitizeBlobKey('a..b/c...d')).toBe('a..b/c...d');
    expect(sanitizeBlobKey('ü/日本語 dosya.txt')).toBe('ü/日本語 dosya.txt');
  });

  it('refuses what could leave the tenant prefix or break the request, with an error that is never retried', () => {
    for (const bad of ['', '/', '.', '..', 'a/../b', '../a', 'a/..', 'a/./b', '\\..\\x', 'a\u0000b', 'a\nb', 'a\u007fb', '\uD800x', 'x\uDC00']) {
      expect(() => sanitizeBlobKey(bad), JSON.stringify(bad)).toThrow('Invalid file key provided.');
    }
    expect(() => sanitizeBlobKey(undefined as unknown as string)).toThrow('Invalid file key provided.');
    const error = (() => {
      try {
        sanitizeBlobKey('..');
      } catch (e) {
        return e as AzureBlobError;
      }
      throw new Error('not thrown');
    })();
    expect(error).toBeInstanceOf(AzureBlobError);
    expect(error).toMatchObject({ statusCode: 400, code: 'InvalidFileKey', retryable: false });
  });

  it('keeps a trailing slash on a listing prefix: "docs/" is the folder, "docs" is every name that starts with it', () => {
    expect(sanitizeListPrefix(undefined)).toBe('');
    expect(sanitizeListPrefix('')).toBe('');
    expect(sanitizeListPrefix('   ')).toBe('');
    expect(sanitizeListPrefix('docs')).toBe('docs');
    expect(sanitizeListPrefix('docs/')).toBe('docs/');
    expect(sanitizeListPrefix('/docs//')).toBe('docs/');
    expect(sanitizeListPrefix('a\\b\\')).toBe('a/b/');
    expect(sanitizeListPrefix('a//b')).toBe('a/b');
    for (const bad of ['..', 'a/../b', '/', '\u0001']) expect(() => sanitizeListPrefix(bad), bad).toThrow('Invalid file key provided.');
  });

  it('builds the base prefix from prefix, tenant and provider', () => {
    expect(buildBasePrefix(['/cognipeer/files/', 'tenant1', 'prov'])).toBe('cognipeer/files/tenant1/prov/');
    expect(buildBasePrefix([undefined, 't1', ' '])).toBe('t1/');
    expect(buildBasePrefix([])).toBe('');
    expect(buildBasePrefix(['a\\b', 't'])).toBe('a/b/t/');
    for (const bad of ['a/../b', '..', './x', 'a\u0000', '\uD800']) {
      const error = settingsError(() => buildBasePrefix([bad, 't']));
      expect(error.field).toBe('prefix');
    }
  });

  it('enforces the service limits on the final blob name', () => {
    expect(assertBlobNameLimits('a'.repeat(1024))).toHaveLength(1024);
    expect(() => assertBlobNameLimits('a'.repeat(1025))).toThrow(/Invalid file key/);
    expect(assertBlobNameLimits(Array(254).fill('a').join('/'))).toBeTruthy();
    expect(() => assertBlobNameLimits(Array(255).fill('a').join('/'))).toThrow(/Invalid file key/);
  });

  it('generates keys in the shape the other drivers use', () => {
    expect(generateKey('report.pdf')).toMatch(/^report-\d+-[a-f0-9]{8}\.pdf$/);
    expect(generateKey()).toMatch(/^\d+-[0-9a-f-]{36}$/);
    expect(generateKey('Şirket Raporu.pdf')).toMatch(/^[a-z0-9_-]+-\d+-[a-f0-9]{8}\.pdf$/);
  });

  it('quotes an etag once, and hashes bytes', () => {
    expect(quoteEtag(undefined)).toBeUndefined();
    expect(quoteEtag('0x1')).toBe('"0x1"');
    expect(quoteEtag('"0x1"')).toBe('"0x1"');
    expect(quoteEtag('W/"x"')).toBe('W/"x"');
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('keeps only header-safe content types', () => {
    expect(asciiHeaderValue(' text/plain; charset=utf-8 ')).toBe('text/plain; charset=utf-8');
    for (const bad of [undefined, '', 'text/\nplain', 'tëxt/plain', 'a'.repeat(256)]) expect(asciiHeaderValue(bad)).toBeUndefined();
  });
});

describe('blob metadata codec', () => {
  const checksum = 'a'.repeat(64);

  function assertServiceSafe(metadata: Record<string, string>): void {
    let total = 0;
    for (const [name, value] of Object.entries(metadata)) {
      expect(name).toMatch(HEADER_NAME);
      expect(value).toMatch(HEADER_VALUE);
      total += name.length + value.length;
    }
    expect(total).toBeLessThanOrEqual(8 * 1024);
  }

  it('round-trips names and structured caller metadata in service-safe form', () => {
    const custom = { 'doc-id': 'x', nested: { list: [1, null, 'ç'] }, 'ünï.key': true };
    const { metadata, droppedCustom } = encodeBlobMetadata({ checksum, name: 'Şirket Raporu 日本語 😀.pdf', custom });
    expect(droppedCustom).toBeUndefined();
    assertServiceSafe(metadata);
    expect(decodeBlobMetadata(metadata)).toEqual({ checksum, name: 'Şirket Raporu 日本語 😀.pdf', custom });
  });

  it('survives names that would make encodeURIComponent throw', () => {
    for (const name of ['😀'.repeat(200), 'abc\uD800def', `${'x'.repeat(254)}\u{1F600}`, '\uDC00']) {
      const { metadata } = encodeBlobMetadata({ name });
      assertServiceSafe(metadata);
      const decoded = decodeBlobMetadata(metadata).name!;
      expect(Array.from(decoded).length).toBeLessThanOrEqual(255);
      expect(decoded).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });

  it('drops caller metadata that does not fit instead of failing the upload', () => {
    const big = encodeBlobMetadata({ checksum, name: 'a.txt', custom: { blob: 'x'.repeat(30_000) } });
    expect(big.droppedCustom).toBe('too-large');
    expect(big.metadata.cp_meta).toBeUndefined();
    expect(big.metadata.cp_checksum).toBe(checksum);
    expect(Object.entries(big.metadata).reduce((n, [k, v]) => n + k.length + v.length, 0)).toBeLessThan(METADATA_BUDGET_BYTES);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(encodeBlobMetadata({ custom: circular }).droppedCustom).toBe('unserializable');
    expect(encodeBlobMetadata({ custom: { n: BigInt(1) } }).droppedCustom).toBe('unserializable');
    expect(encodeBlobMetadata({ custom: {} }).metadata.cp_meta).toBeUndefined();
  });

  it('counts the checksum and the name against the same budget as the custom block', () => {
    const name = 'n'.repeat(255);
    const fits = encodeBlobMetadata({ checksum, name, custom: { v: 'x'.repeat(3000) } });
    expect(fits.droppedCustom).toBeUndefined();
    const total = Object.entries(fits.metadata).reduce((n, [k, v]) => n + k.length + v.length, 0);
    expect(total).toBeLessThanOrEqual(METADATA_BUDGET_BYTES);
    // a name of 255 percent-encoded characters takes 765 bytes, leaving less room than the custom block alone would
    const tight = encodeBlobMetadata({ checksum, name: 'ü'.repeat(255), custom: { v: 'x'.repeat(4500) } });
    expect(tight.droppedCustom).toBe('too-large');
  });

  it('ignores a malformed checksum and everything it did not write', () => {
    expect(encodeBlobMetadata({ checksum: 'nope' }).metadata.cp_checksum).toBeUndefined();
    expect(decodeBlobMetadata({ foo: 'bar', cp_checksum: 'zz', cp_meta: 'not-b64u', cp_name: '%E0%A4%A' })).toEqual({ name: '%E0%A4%A' });
    expect(decodeBlobMetadata({ cp_meta: `b64u:${Buffer.from('[1,2]').toString('base64url')}` })).toEqual({});
    expect(decodeBlobMetadata(undefined)).toEqual({});
  });

  it('folds key case (emulators lowercase, the service may preserve) and strips prototype keys', () => {
    const { metadata } = encodeBlobMetadata({ checksum, name: 'n', custom: JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"ok":1}') });
    const shouty = Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k.toUpperCase(), v]));
    const decoded = decodeBlobMetadata(shouty);
    expect(decoded.checksum).toBe(checksum);
    expect(decoded.custom).toEqual({ ok: 1 });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('recognises ADLS Gen2 directory markers only when empty', () => {
    expect(isDirectoryMarker({ hdi_isfolder: 'true' }, 0)).toBe(true);
    expect(isDirectoryMarker({ Hdi_IsFolder: 'TRUE' }, 0)).toBe(true);
    expect(isDirectoryMarker({ hdi_isfolder: 'true' }, 5)).toBe(false);
    expect(isDirectoryMarker({ hdi_isfolder: 'false' }, 0)).toBe(false);
    expect(isDirectoryMarker(undefined, 0)).toBe(false);
  });
});

describe('endpoint', () => {
  it('derives the public-cloud and sovereign hosts from the account name', () => {
    expect(resolveBlobEndpoint({ accountName: 'MyAcct', allowHttp: false })).toMatchObject({
      serviceUrl: 'https://myacct.blob.core.windows.net',
      accountName: 'myacct',
      host: 'myacct.blob.core.windows.net',
      protocol: 'https:',
    });
    expect(resolveBlobEndpoint({ accountName: 'myacct', endpointSuffix: 'core.chinacloudapi.cn', allowHttp: false }).host).toBe('myacct.blob.core.chinacloudapi.cn');
    expect(() => resolveBlobEndpoint({ accountName: 'myacct', endpointSuffix: 'other.example/x', allowHttp: false })).toThrow(ProviderSettingsError);
    expect(() => resolveBlobEndpoint({ accountName: 'myacct', protocol: 'http', allowHttp: false })).toThrow(/https/);
    expect(resolveBlobEndpoint({ accountName: 'myacct', protocol: 'http', allowHttp: true }).serviceUrl).toBe('http://myacct.blob.core.windows.net');
  });

  it('accepts an explicit endpoint: scheme-less, path-style emulators, account inferred from the host', () => {
    expect(resolveBlobEndpoint({ endpoint: 'myacct.blob.core.windows.net', allowHttp: false })).toMatchObject({
      serviceUrl: 'https://myacct.blob.core.windows.net',
      accountName: 'myacct',
    });
    expect(resolveBlobEndpoint({ endpoint: 'http://127.0.0.1:10000/devstoreaccount1/', allowHttp: true })).toMatchObject({
      serviceUrl: 'http://127.0.0.1:10000/devstoreaccount1',
      accountName: 'devstoreaccount1',
      host: '127.0.0.1',
      protocol: 'http:',
    });
    expect(resolveBlobEndpoint({ endpoint: 'https://storage.internal.example', accountName: 'acct', allowHttp: false }).accountName).toBe('acct');
    expect(resolveBlobEndpoint({ endpoint: 'https://Storage.Example.com:8443/', accountName: 'acct', allowHttp: false }).serviceUrl).toBe('https://storage.example.com:8443');
  });

  it('does not read the container of a pasted container URL as the account', () => {
    for (const endpoint of [
      'https://acct.blob.core.windows.net/files',
      'https://acct.blob.core.windows.net/files/',
      'https://acct.blob.core.chinacloudapi.cn/files',
      'acct.blob.core.windows.net/files',
    ]) {
      const error = settingsError(() => resolveBlobEndpoint({ endpoint, allowHttp: false }));
      expect(error.field, endpoint).toBe('endpoint');
      expect(error.message, endpoint).toBe('The endpoint is the account URL, for example https://myaccount.blob.core.windows.net. Enter the container in the Container field.');
    }
    // with the account named as well, and with a SAS or Entra credential that does not need the name
    expect(settingsError(() => resolveBlobEndpoint({ endpoint: 'https://acct.blob.core.windows.net/files', accountName: 'acct', allowHttp: false })).field).toBe('endpoint');
    expect(settingsError(() => resolveBlobEndpoint({ endpoint: 'https://acct.blob.core.windows.net/files', allowHttp: false, accountOptional: true })).field).toBe('endpoint');
    // and the field a connection string's endpoint came from
    expect(settingsError(() => resolveBlobEndpoint({ endpoint: 'https://acct.blob.core.windows.net/files', allowHttp: false, fields: { endpoint: 'connectionString' } })).field).toBe('connectionString');
    // the account URL itself, with or without a trailing slash, is what it was
    expect(resolveBlobEndpoint({ endpoint: 'https://acct.blob.core.windows.net/', allowHttp: false })).toMatchObject({ serviceUrl: 'https://acct.blob.core.windows.net', accountName: 'acct' });
    // a path-style emulator keeps its account segment
    expect(resolveBlobEndpoint({ endpoint: 'https://emulator.internal.example:10000/devstoreaccount1', allowHttp: false })).toMatchObject({
      serviceUrl: 'https://emulator.internal.example:10000/devstoreaccount1',
      accountName: 'devstoreaccount1',
    });
  });

  it('refuses a pasted container URL when the whole configuration is resolved, whatever the credential', () => {
    const error = settingsError(() => resolveAzureBlobConfig(
      { accountKey: KEY },
      { endpoint: 'https://acct.blob.core.windows.net/files', container: 'cont1' },
      { allowHttp: false },
    ));
    expect(error.field).toBe('endpoint');
    const withSas = settingsError(() => resolveAzureBlobConfig(
      { sasToken: SAS },
      { authMethod: 'sas', endpoint: 'https://acct.blob.core.windows.net/files', container: 'cont1' },
      { allowHttp: false },
    ));
    expect(withSas.field).toBe('endpoint');
  });

  it('leaves the account name out of a SAS or Entra endpoint on a custom domain, and asks for it otherwise', () => {
    expect(resolveBlobEndpoint({ endpoint: 'https://files.example.com', allowHttp: false, accountOptional: true }).accountName).toBeUndefined();
    expect(settingsError(() => resolveBlobEndpoint({ endpoint: 'https://files.example.com', allowHttp: false })).field).toBe('accountName');
  });

  it('refuses anything that is not a plain origin, and names the field the value came from', () => {
    const cases: Array<[Partial<Parameters<typeof resolveBlobEndpoint>[0]>, RegExp]> = [
      [{ endpoint: 'http://127.0.0.1:10000/devstoreaccount1' }, /https/],
      [{ endpoint: 'https://u:p@acct.blob.core.windows.net' }, /credentials/],
      [{ endpoint: 'https://acct.blob.core.windows.net?sv=1' }, /query string or fragment/],
      [{ endpoint: 'https://acct.blob.core.windows.net#x' }, /query string or fragment/],
      [{ endpoint: 'https://storage.internal.example/deep/path', accountName: 'acct' }, /single account/],
      [{ endpoint: 'https://storage.internal.example/a b', accountName: 'acct' }, /single account/],
      // an account host takes no path: what follows it is a container (or something deeper), never the account
      [{ endpoint: 'https://acct.blob.core.windows.net/deep/path' }, /account URL.*Container field/],
      [{ endpoint: 'https://acct.blob.core.windows.net/a b' }, /account URL.*Container field/],
      [{ endpoint: 'https://storage.internal.example' }, /account name/],
      [{ endpoint: 'http://127.0.0.1:10000/acct', accountName: 'other' }, /https/],
      [{ endpoint: 'ftp://acct.blob.core.windows.net' }, /https/],
      [{ endpoint: 'https://' }, /valid URL/],
    ];
    for (const [input, message] of cases) {
      const error = settingsError(() => resolveBlobEndpoint({ allowHttp: false, ...input }));
      expect(error.message, JSON.stringify(input)).toMatch(message);
    }
    expect(settingsError(() => resolveBlobEndpoint({ endpoint: 'http://127.0.0.1:10000/acct', accountName: 'other', allowHttp: true })).message).toMatch(/does not match/);
    expect(settingsError(() => resolveBlobEndpoint({ endpoint: 'ftp://x', allowHttp: true, fields: { endpoint: 'connectionString' } })).field).toBe('connectionString');
  });
});

describe('credentials', () => {
  it('account keys', () => {
    expect(assertAccountKey(` ${KEY} `)).toBe(KEY);
    for (const bad of [undefined, '', 'short', 'not base64 !!'.repeat(5)]) expect(settingsError(() => assertAccountKey(bad)).field).toBe('accountKey');
  });

  it('SAS: token, query or URL, kept exactly as issued', () => {
    expect(parseSasToken(SAS).token).toBe(SAS);
    expect(parseSasToken(`?${SAS}`).token).toBe(SAS);
    expect(parseSasToken(`  ?${SAS}\n`).token).toBe(SAS);
    expect(parseSasToken(`https://acct.blob.core.windows.net/files?${SAS}`).token).toBe(SAS);
    expect(parseSasToken(SAS)).toMatchObject({ resource: 'c', permissions: 'racwdl', expiresAt: new Date('2099-01-01T00:00:00Z') });
    expect(parseSasToken('sv=2022-11-02&ss=b&srt=sco&sp=rwdlac&se=2099-01-01T00:00:00Z&sig=x').resource).toBeUndefined();
  });

  it('SAS: a literal = inside a value is written %3D, because the SDK cuts a value at its second =', () => {
    const base = 'sv=2022-11-02&sr=c&sp=racwdl&se=2099-01-01T00:00:00Z';
    expect(parseSasToken(`${base}&sig=abcd=`).token).toBe(`${base}&sig=abcd%3D`);
    expect(parseSasToken(`${base}&sig=abcd==`).token).toBe(`${base}&sig=abcd%3D%3D`);
    expect(parseSasToken(`${base}&sig=ab%2Bc%2Fd=`).token).toBe(`${base}&sig=ab%2Bc%2Fd%3D`);
    expect(parseSasToken(`?${base}&skoid=a=b&sig=x`).token).toBe(`${base}&skoid=a%3Db&sig=x`);
    expect(parseSasToken(`https://acct.blob.core.windows.net/files?${base}&sig=abcd=`).token).toBe(`${base}&sig=abcd%3D`);
    // the service reads %3D as =, so nothing the signature covers changes
    expect(new URLSearchParams(parseSasToken(`${base}&sig=abcd==`).token).get('sig')).toBe('abcd==');
    expect(parseSasToken(`${base}&sig=abcd=`).permissions).toBe('racwdl');
  });

  it('SAS: a signature pasted decoded gets its + written %2B, one that carries escapes is left alone', () => {
    const base = 'sv=2022-11-02&sr=c&sp=racwdl&se=2099-01-01T00:00:00Z';
    expect(parseSasToken(`${base}&sig=ab+c/d=`).token).toBe(`${base}&sig=ab%2Bc/d%3D`);
    // an escape anywhere in the signature says it was copied encoded: a bare + is not touched
    expect(parseSasToken(`${base}&sig=ab%2Bc+d`).token).toBe(`${base}&sig=ab%2Bc+d`);
    // only the signature, never another parameter
    expect(parseSasToken(`${base}&sip=1.2.3.4&sig=x+y`).token).toBe(`${base}&sip=1.2.3.4&sig=x%2By`);
    expect(parseSasToken(`sv=2022-11-02+x&sr=c&se=2099-01-01T00:00:00Z&sig=ab%2Bc%3D`).token).toBe('sv=2022-11-02+x&sr=c&se=2099-01-01T00:00:00Z&sig=ab%2Bc%3D');
  });

  it('SAS: a token that is already encoded, or has stray separators, comes through as it was', () => {
    expect(parseSasToken(`${SAS}`).token).toBe(SAS);
    expect(parseSasToken(`${SAS}#fragment`).token).toBe(SAS);
    expect(parseSasToken(`&${SAS}&&`).token).toBe(SAS);
    expect(parseSasToken('sv=2022-11-02&sr=c&se=2099-01-01T00:00:00Z&si=&sig=ab%2Bc%3D').token).toBe('sv=2022-11-02&sr=c&se=2099-01-01T00:00:00Z&si=&sig=ab%2Bc%3D');
  });

  it('SAS: refuses a parameter without a value and one that appears twice, which the SDK would rewrite', () => {
    const noValue = settingsError(() => parseSasToken(`${SAS}&flag`));
    expect(noValue.field).toBe('sasToken');
    expect(noValue.message).toMatch(/malformed.*name=value/);
    expect(settingsError(() => parseSasToken(`${SAS}&=x`)).message).toMatch(/malformed/);
    const repeated = settingsError(() => parseSasToken(`${SAS}&sp=r`));
    expect(repeated.field).toBe('sasToken');
    expect(repeated.message).toBe('The SAS token repeats the parameter "sp".');
    expect(settingsError(() => parseSasToken(`${SAS}&sp=r`, new Date(), 'connectionString')).field).toBe('connectionString');
  });

  it('SAS: rejects what can never work', () => {
    const cases: Array<[string, RegExp]> = [
      ['', /Enter the SAS token/],
      ['sv=2022-11-02&se=2099-01-01T00:00:00Z', /incomplete/],
      ['https://acct.blob.core.windows.net/files', /no query/],
      [SAS.replace('sr=c', 'sr=b'), /single blob/],
      [SAS.replace('sr=c', 'sr=bs'), /single blob/],
      [SAS.replace('2099-01-01', '2000-01-01'), /expired/],
    ];
    for (const [token, message] of cases) {
      const error = settingsError(() => parseSasToken(token));
      expect(error.field).toBe('sasToken');
      expect(error.message, token).toMatch(message);
    }
    expect(() => parseSasToken(SAS.replace('2099-01-01', '2000-01-01'), new Date('1999-01-01'))).not.toThrow();
  });

  it('connection strings are parsed and validated, not interpolated blindly', () => {
    expect(parseConnectionString(`DefaultEndpointsProtocol=https;AccountName=acctname1;AccountKey=${KEY};EndpointSuffix=core.windows.net;`)).toEqual({
      accountName: 'acctname1',
      accountKey: KEY,
      endpointSuffix: 'core.windows.net',
      protocol: 'https',
    });
    expect(parseConnectionString(`BlobEndpoint=https://acctname1.blob.core.windows.net;SharedAccessSignature=${SAS}`)).toMatchObject({
      blobEndpoint: 'https://acctname1.blob.core.windows.net',
      sas: SAS,
    });
    expect(parseConnectionString(`accountname=acctname1;ACCOUNTKEY=${KEY}`)).toMatchObject({ accountName: 'acctname1', accountKey: KEY });
    const cases: Array<[string, RegExp]> = [
      [`AccountName=other.example/x#;AccountKey=${KEY}`, /AccountName/],
      ['AccountName=acctname1;AccountKey=short', /AccountKey/],
      ['AccountName=acctname1', /neither AccountKey nor SharedAccessSignature/],
      [`AccountKey=${KEY}`, /neither AccountName nor BlobEndpoint/],
      [`DefaultEndpointsProtocol=ftp;AccountName=acctname1;AccountKey=${KEY}`, /https or http/],
      ['', /Enter the connection string/],
      ['just some text', /neither/],
    ];
    for (const [input, message] of cases) {
      const error = settingsError(() => parseConnectionString(input));
      expect(error.field).toBe('connectionString');
      expect(error.message, input).toMatch(message);
    }
  });

  it('refuses UseDevelopmentStorage and shows how to write the emulator out', () => {
    const error = settingsError(() => parseConnectionString('UseDevelopmentStorage=true'));
    expect(error.field).toBe('connectionString');
    expect(error.message).toContain('UseDevelopmentStorage is not supported');
    expect(error.message).toContain('BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1');
  });

  it('Microsoft Entra inputs', () => {
    expect(validateClientSecretConfig({ authorityHost: 'https://login.microsoftonline.com/', tenantId: 'contoso.onmicrosoft.com', clientId: CLIENT, clientSecret: 'super-secret-value' })).toEqual({
      authority: 'https://login.microsoftonline.com',
    });
    const base = { authorityHost: 'https://login.microsoftonline.com', tenantId: CLIENT, clientId: CLIENT, clientSecret: 'super-secret-value' };
    const cases: Array<[Partial<typeof base>, string]> = [
      [{ tenantId: 'not a tenant!' }, 'entraTenantId'],
      [{ clientId: 'nope' }, 'clientId'],
      [{ clientSecret: 'short' }, 'clientSecret'],
      [{ authorityHost: 'http://login.microsoftonline.com' }, 'authorityHost'],
      [{ authorityHost: 'https://login.microsoftonline.com/x' }, 'authorityHost'],
      [{ authorityHost: 'https://u:p@login.microsoftonline.com' }, 'authorityHost'],
      [{ authorityHost: 'not a url' }, 'authorityHost'],
    ];
    for (const [override, field] of cases) {
      expect(settingsError(() => validateClientSecretConfig({ ...base, ...override })).field, JSON.stringify(override)).toBe(field);
    }
    expect(defaultAuthorityFor('a.blob.core.windows.net')).toBe('https://login.microsoftonline.com');
    expect(defaultAuthorityFor('a.blob.core.usgovcloudapi.net')).toBe('https://login.microsoftonline.us');
    expect(defaultAuthorityFor('a.blob.core.chinacloudapi.cn')).toBe('https://login.chinacloudapi.cn');
    expect(defaultAuthorityFor('127.0.0.1')).toBe('https://login.microsoftonline.com');
  });
});

describe('resolveAzureBlobConfig', () => {
  const settings = { accountName: 'acctname1', container: 'files' };

  it('uses the chosen method and ignores credentials left over from an earlier choice', () => {
    const config = resolveAzureBlobConfig({ accountKey: KEY, sasToken: SAS }, { ...settings, authMethod: 'sas' }, { allowHttp: false });
    expect(config.auth.method).toBe('sas');
    expect(config.authMethod).toBe('sas');
    expect(config.endpoint.serviceUrl).toBe('https://acctname1.blob.core.windows.net');
    expect(config.endpointField).toBe('accountName');
  });

  it('infers the method for records created through the API when exactly one credential is set', () => {
    expect(resolveAzureBlobConfig({ accountKey: KEY }, settings, { allowHttp: false }).authMethod).toBe('accountKey');
    expect(resolveAzureBlobConfig({ sasToken: SAS }, settings, { allowHttp: false }).authMethod).toBe('sas');
    expect(resolveAzureBlobConfig({ accountKey: KEY }, { ...settings, authMethod: '  ' }, { allowHttp: false }).authMethod).toBe('accountKey');
    expect(settingsError(() => resolveAzureBlobConfig({}, settings, { allowHttp: false })).message).toMatch(/Provide an account key/);
    expect(settingsError(() => resolveAzureBlobConfig({ accountKey: KEY, sasToken: SAS }, settings, { allowHttp: false })).message).toMatch(/choose the authentication method/);
    const unknown = settingsError(() => resolveAzureBlobConfig({ accountKey: KEY }, { ...settings, authMethod: 'kerberos' }, { allowHttp: false }));
    expect(unknown.field).toBe('authMethod');
    expect(unknown.message).toMatch(/Unknown authentication method/);
  });

  it('reads account and endpoint from a connection string and reports the method that was chosen', () => {
    const connectionString = `DefaultEndpointsProtocol=https;AccountName=fromstring;AccountKey=${KEY};EndpointSuffix=core.windows.net`;
    const config = resolveAzureBlobConfig({ connectionString }, { container: 'files', authMethod: 'connectionString' }, { allowHttp: false });
    expect(config.authMethod).toBe('connectionString');
    expect(config.auth.method).toBe('accountKey');
    expect(config.endpoint.accountName).toBe('fromstring');
    expect(config.endpointField).toBe('connectionString');
  });

  it('lets explicit account and endpoint settings win over the connection string', () => {
    const connectionString = `AccountName=fromstring;AccountKey=${KEY};BlobEndpoint=https://fromstring.blob.core.windows.net`;
    const config = resolveAzureBlobConfig(
      { connectionString },
      { container: 'files', authMethod: 'connectionString', accountName: 'explicit1', endpoint: 'https://explicit1.blob.core.windows.net' },
      { allowHttp: false },
    );
    expect(config.endpoint).toMatchObject({ serviceUrl: 'https://explicit1.blob.core.windows.net', accountName: 'explicit1' });
    expect(config.endpointField).toBe('endpoint');
  });

  it('a connection string with a SAS reports the SAS as its credential', () => {
    const connectionString = `BlobEndpoint=https://acctname1.blob.core.windows.net;SharedAccessSignature=${SAS}`;
    const config = resolveAzureBlobConfig({ connectionString }, { container: 'files', authMethod: 'connectionString' }, { allowHttp: false });
    expect(config.auth).toMatchObject({ method: 'sas', sas: { token: SAS } });
    expect(config.endpoint.accountName).toBe('acctname1');
  });

  it('an expired SAS inside a connection string is attributed to the connection string', () => {
    const connectionString = `BlobEndpoint=https://acctname1.blob.core.windows.net;SharedAccessSignature=${SAS.replace('2099-01-01', '2000-01-01')}`;
    const error = settingsError(() => resolveAzureBlobConfig({ connectionString }, { container: 'files', authMethod: 'connectionString' }, { allowHttp: false }));
    expect(error.field).toBe('connectionString');
    expect(error.message).toMatch(/expired/);
  });

  it('Entra needs the three values, an https endpoint, and picks the sovereign authority', () => {
    const entra = { ...settings, authMethod: 'entra', entraTenantId: 'contoso.onmicrosoft.com', clientId: CLIENT };
    const ok = resolveAzureBlobConfig({ clientSecret: 'super-secret-value' }, entra, { allowHttp: false });
    expect(ok.auth).toMatchObject({ method: 'entra', authority: 'https://login.microsoftonline.com', tenantId: 'contoso.onmicrosoft.com', clientId: CLIENT });
    expect(resolveAzureBlobConfig({ clientSecret: 'super-secret-value' }, { ...entra, endpoint: 'https://acctname1.blob.core.usgovcloudapi.net' }, { allowHttp: false }).auth)
      .toMatchObject({ authority: 'https://login.microsoftonline.us' });
    expect(resolveAzureBlobConfig({ clientSecret: 'super-secret-value' }, { ...entra, authorityHost: 'https://login.example.org/' }, { allowHttp: false }).auth)
      .toMatchObject({ authority: 'https://login.example.org' });
    expect(settingsError(() => resolveAzureBlobConfig({ clientSecret: 'super-secret-value' }, { ...entra, entraTenantId: undefined }, { allowHttp: false })).field).toBe('entraTenantId');
    expect(settingsError(() => resolveAzureBlobConfig({ clientSecret: 'super-secret-value' }, { ...entra, clientId: undefined }, { allowHttp: false })).field).toBe('clientId');
    expect(settingsError(() => resolveAzureBlobConfig({}, entra, { allowHttp: false })).field).toBe('clientSecret');
    const plaintext = settingsError(() => resolveAzureBlobConfig({ clientSecret: 'super-secret-value' }, { ...entra, endpoint: 'http://127.0.0.1:10000/acctname1' }, { allowHttp: true }));
    expect(plaintext.field).toBe('endpoint');
    expect(plaintext.message).toMatch(/https/);
  });

  it('an account key needs the account name, a SAS or Entra credential does not', () => {
    const custom = { container: 'files', endpoint: 'https://files.example.com' };
    expect(settingsError(() => resolveAzureBlobConfig({ accountKey: KEY }, { ...custom, authMethod: 'accountKey' }, { allowHttp: false })).field).toBe('accountName');
    expect(resolveAzureBlobConfig({ sasToken: SAS }, { ...custom, authMethod: 'sas' }, { allowHttp: false }).endpoint.accountName).toBeUndefined();
  });

  it('validates the remaining settings', () => {
    const run = (extra: Record<string, unknown>) => resolveAzureBlobConfig({ accountKey: KEY }, { ...settings, ...extra }, { allowHttp: false });
    expect(settingsError(() => run({ container: 'BAD NAME' })).field).toBe('container');
    expect(settingsError(() => run({ container: undefined })).field).toBe('container');
    expect(settingsError(() => run({ apiVersion: '2023-11' })).field).toBe('apiVersion');
    expect(run({ apiVersion: '2023-11-03' }).apiVersion).toBe('2023-11-03');
    expect(settingsError(() => run({ prefix: 'a/../b' })).field).toBe('prefix');
    expect(settingsError(() => run({ accountName: 42 })).message).toMatch(/must be text/);
    for (const [value, expected] of [[true, true], ['true', true], ['on', true], ['1', true], [false, false], ['off', false], [undefined, false], ['', false]] as const) {
      expect(run({ createContainer: value }).createContainer, String(value)).toBe(expected);
    }
    expect(run({ caCertificate: '  \n ' }).caCertificate).toBeUndefined();
  });

  it('skips TLS verification only for the boolean true', () => {
    const run = (value: unknown) => resolveAzureBlobConfig({ accountKey: KEY }, { ...settings, allowInsecureTls: value as boolean }, { allowHttp: true }).allowInsecureTls;
    expect(run(true)).toBe(true);
    for (const value of ['true', 'false', 1, 0, {}, [], null, undefined, false]) expect(run(value), JSON.stringify(value)).toBe(false);
  });

  it('collects every credential value that could end up in a message', () => {
    const sas = SAS.replace('sig=ab%2Bc%3D', 'sig=abcdefgh%2Bijkl%3D');
    const config = resolveAzureBlobConfig({ sasToken: sas, accountKey: KEY, clientSecret: 'short' }, { ...settings, authMethod: 'sas' }, { allowHttp: false });
    const secrets = secretValues({ sasToken: sas, accountKey: KEY, clientSecret: 'short' }, config);
    expect(secrets).toContain(KEY);
    expect(secrets).toContain(sas);
    expect(secrets).toContain('abcdefgh%2Bijkl%3D');
    expect(secrets).toContain('abcdefgh+ijkl=');
    expect(secrets).not.toContain('short');
  });
});

describe('describeAzureBlobLocation', () => {
  it('builds the display location from settings alone', () => {
    expect(describeAzureBlobLocation({ accountName: 'MyAcct1', container: 'files', prefix: '/cognipeer/files/' }, 't1', 'prov'))
      .toBe('https://myacct1.blob.core.windows.net/files/cognipeer/files/t1/prov/');
    expect(describeAzureBlobLocation({ accountName: 'myacct1', container: 'files' }, 't1', 'prov')).toBe('https://myacct1.blob.core.windows.net/files/t1/prov/');
    expect(describeAzureBlobLocation({ endpoint: 'http://127.0.0.1:10000/devstoreaccount1', container: 'files' }, 't1', 'prov'))
      .toBe('http://127.0.0.1:10000/devstoreaccount1/files/t1/prov/');
    expect(describeAzureBlobLocation({ endpoint: 'files.example.com', container: 'files' }, 't1', 'prov')).toBe('https://files.example.com/files/t1/prov/');
  });

  it('starts at the container when the settings do not say where the account is, and never guesses a host for a connection string', () => {
    expect(describeAzureBlobLocation({ container: 'files' }, 't1', 'prov')).toBe('files/t1/prov/');
    expect(describeAzureBlobLocation({ container: 'files', authMethod: 'connectionString', accountName: 'myacct1' }, 't1', 'prov')).toBe('files/t1/prov/');
    expect(describeAzureBlobLocation({ container: 'files', authMethod: 'connectionString', endpoint: 'https://myacct1.blob.core.windows.net' }, 't1', 'prov'))
      .toBe('https://myacct1.blob.core.windows.net/files/t1/prov/');
  });

  it('is null when there is nothing meaningful to show', () => {
    expect(describeAzureBlobLocation(undefined, 't1', 'prov')).toBeNull();
    expect(describeAzureBlobLocation({}, 't1', 'prov')).toBeNull();
    expect(describeAzureBlobLocation({ container: 'files', prefix: 'a/../b' }, 't1', 'prov')).toBeNull();
    expect(describeAzureBlobLocation({ container: 'files', endpoint: 'ftp://nowhere' }, 't1', 'prov')).toBeNull();
  });

  it('ignores anything that looks like a credential in the settings', () => {
    const text = describeAzureBlobLocation({ accountName: 'myacct1', container: 'files', accountKey: KEY, sasToken: SAS } as never, 't1', 'prov')!;
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('sig=');
  });
});

describe('AzureBlobError', () => {
  it('declares whether another attempt can succeed from the status unless told otherwise', () => {
    expect(new AzureBlobError('x').retryable).toBe(true);
    for (const status of [500, 502, 503, 504, 408, 429]) expect(new AzureBlobError('x', { statusCode: status }).retryable, String(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 412]) expect(new AzureBlobError('x', { statusCode: status }).retryable, String(status)).toBe(false);
    expect(new AzureBlobError('x', { statusCode: 503, retryable: false }).retryable).toBe(false);
    expect(new AzureBlobError('x', { statusCode: 404, retryable: true }).retryable).toBe(true);
    expect(isRetryableStatus(undefined)).toBe(true);
    expect(isRetryableStatus(200)).toBe(false);
  });

  it('carries the status, the Azure code and the request id, but not the SDK request', () => {
    const error = new AzureBlobError('boom', { statusCode: 403, code: 'AuthorizationFailure', requestId: 'req-1' });
    expect(error).toMatchObject({ name: 'AzureBlobError', message: 'boom', statusCode: 403, code: 'AuthorizationFailure', requestId: 'req-1' });
    expect(Object.keys(error)).not.toContain('request');
    expect(Object.keys(error)).not.toContain('response');
  });

  it('the type guard recognises its own errors, a second copy of the class and nothing else', () => {
    expect(isAzureBlobError(new AzureBlobError('x'))).toBe(true);
    expect(isAzureBlobError(Object.assign(new Error('x'), { name: 'AzureBlobError', retryable: false }))).toBe(true);
    expect(isAzureBlobError(Object.assign(new Error('x'), { name: 'AzureBlobError' }))).toBe(false);
    expect(isAzureBlobError(new Error('x'))).toBe(false);
    expect(isAzureBlobError({ name: 'AzureBlobError', retryable: true })).toBe(false);
    expect(isAzureBlobError(undefined)).toBe(false);
    expect(isAzureBlobError(invalidKeyError())).toBe(true);
  });

  it('a rejected key reads like the other drivers say it', () => {
    expect(invalidKeyError().message).toBe('Invalid file key provided.');
    expect(invalidKeyError('too long').message).toBe('Invalid file key provided: too long');
  });
});

describe('failure classification', () => {
  const ctx = { operation: 'upload', account: 'acctname1', container: 'files', host: 'acctname1.blob.core.windows.net', authMethod: 'accountKey' };

  it('reads the shapes the SDK actually produces', () => {
    // HEAD: no body, so no message and no `code`; only details.errorCode
    expect(describeAzureError({ name: 'RestError', statusCode: 404, message: '', details: { errorCode: 'BlobNotFound' } })).toMatchObject({ status: 404, code: 'BlobNotFound', aborted: false });
    expect(describeAzureError({
      statusCode: 403,
      code: 'AuthenticationFailed',
      message: 'Server failed to authenticate the request.\nRequestId:abc\nTime:now',
      details: { errorCode: 'AuthenticationFailed', 'x-ms-request-id': 'req-1' },
    })).toMatchObject({ status: 403, code: 'AuthenticationFailed', requestId: 'req-1', detail: 'Server failed to authenticate the request.' });
    expect(describeAzureError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' })).toMatchObject({ systemCode: 'ECONNREFUSED', code: undefined });
    expect(describeAzureError({ name: 'AbortError', message: 'The operation was aborted.' }).aborted).toBe(true);
    expect(describeAzureError({ statusCode: 403, details: { errorCode: 'AuthenticationFailed', authenticationErrorDetail: 'camel' } }).detail).toBe('camel');
    expect(describeAzureError({ statusCode: 403, details: { errorCode: 'AuthenticationFailed', authenticationerrordetail: 'lower' } }).detail).toBe('lower');
    expect(describeAzureError(undefined)).toMatchObject({ aborted: false, blocked: false });
    expect(describeAzureError('just a string')).toMatchObject({ aborted: false, blocked: false });
  });

  it('reads the service code from the error itself when the details do not carry one', () => {
    expect(describeAzureError({ statusCode: 404, code: 'ContainerNotFound', message: 'The specified container does not exist.' }))
      .toMatchObject({ status: 404, code: 'ContainerNotFound', systemCode: undefined });
    // the code of the details wins when both are there
    expect(describeAzureError({ statusCode: 404, code: 'SomethingElse', details: { errorCode: 'BlobNotFound' } })).toMatchObject({ code: 'BlobNotFound' });
    // what is not shaped like a service code (or is a socket's or the runtime's) is not taken for one
    for (const raw of ['not_a_service_code', 'lowercase', 'ABC123', 'ECONNRESET', 'ERR_INVALID_URL']) {
      expect(describeAzureError({ code: raw, message: 'x' }), raw).toMatchObject({ code: undefined });
    }
  });

  it('recognises a refusal by the network policy, which the SDK reports as a plain request error', () => {
    const sdkShaped = Object.assign(new Error('Refusing outbound request to private/loopback host: files.example.com'), { name: 'RestError', code: 'REQUEST_SEND_ERROR' });
    expect(describeAzureError(sdkShaped)).toMatchObject({ blocked: true, systemCode: 'REQUEST_SEND_ERROR' });
    expect(describeAzureError(Object.assign(new Error('x'), { name: 'OutboundNetworkError' })).blocked).toBe(true);
    expect(describeAzureError(new Error('connect ECONNREFUSED')).blocked).toBe(false);
  });

  it('tells a missing blob from a missing container', () => {
    expect(isBlobMissing({ status: 404, code: 'BlobNotFound', aborted: false, blocked: false })).toBe(true);
    // a 404 that does not name the blob says nothing about it (a gateway, a proxy page, another protocol's error)
    expect(isBlobMissing({ status: 404, aborted: false, blocked: false })).toBe(false);
    expect(isBlobMissing({ status: 404, code: 'NoSuchBucket', aborted: false, blocked: false })).toBe(false);
    expect(isBlobMissing({ status: 404, code: 'ContainerNotFound', aborted: false, blocked: false })).toBe(false);
    expect(isBlobMissing({ status: 404, code: 'ResourceNotFound', aborted: false, blocked: false })).toBe(false);
    expect(isBlobMissing({ status: 403, aborted: false, blocked: false })).toBe(false);
    expect(isContainerMissing({ status: 404, code: 'ContainerNotFound', aborted: false, blocked: false })).toBe(true);
    expect(isContainerMissing({ status: 404, code: 'BlobNotFound', aborted: false, blocked: false })).toBe(false);
  });

  it('knows which failures no second attempt can change', () => {
    const base = { aborted: false, blocked: false };
    expect(isHopelessFailure({ ...base, blocked: true })).toBe(true);
    expect(isHopelessFailure({ ...base, systemCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).toBe(true);
    expect(isHopelessFailure({ ...base, systemCode: 'ERR_TLS_CERT_ALTNAME_INVALID' })).toBe(true);
    expect(isHopelessFailure({ ...base, systemCode: 'ERR_INVALID_CHAR' })).toBe(true);
    expect(isHopelessFailure({ ...base, status: 400 })).toBe(true);
    expect(isHopelessFailure({ ...base, status: 403 })).toBe(true);
    expect(isHopelessFailure({ ...base, status: 404 })).toBe(true);
    expect(isHopelessFailure({ ...base, status: 503 })).toBe(false);
    expect(isHopelessFailure({ ...base, status: 429 })).toBe(false);
    expect(isHopelessFailure({ ...base, systemCode: 'ECONNRESET' })).toBe(false);
    expect(isHopelessFailure({ ...base, systemCode: 'ENOTFOUND' })).toBe(false);
    expect(isHopelessFailure({ ...base, aborted: true })).toBe(false);
  });

  it('writes actionable sentences that never echo a signature and never say "not found" for configuration', () => {
    const base = { aborted: false, blocked: false };
    const configProblems: AzureErrorInfo[] = [
      { ...base, status: 404, code: 'ContainerNotFound' },
      { ...base, status: 404, code: 'ResourceNotFound' },
      {
        ...base,
        status: 403,
        code: 'AuthenticationFailed',
        detail: "Server failed to authenticate the request. Make sure the value of Authorization header is formed correctly including the signature. MAC signature found in the HTTP request 'SECRETSIG' is not the same as any computed signature. Server used following string to sign: 'PUT\\n...'",
      },
      { ...base, status: 403, code: 'KeyBasedAuthenticationNotPermitted' },
      { ...base, status: 403, code: 'AuthorizationFailure' },
      { ...base, status: 403, code: 'AuthorizationPermissionMismatch' },
      { ...base, systemCode: 'ENOTFOUND' },
      { ...base, blocked: true, systemCode: 'REQUEST_SEND_ERROR' },
      { ...base, systemCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
      { ...base, systemCode: 'ECONNREFUSED' },
      { ...base, aborted: true },
    ];
    for (const info of configProblems) {
      const message = describeFailure(info, ctx);
      expect(message, JSON.stringify(info)).not.toMatch(/not found|does not exist/i);
      expect(message).not.toContain('SECRETSIG');
      expect(message).not.toContain('string to sign');
      expect(message.endsWith('.')).toBe(true);
      expect(message).not.toContain('..');
    }
    expect(describeFailure({ ...base, status: 403, code: 'AuthenticationFailed', detail: "MAC signature found in the HTTP request 'x' is not the same as any computed signature.", aborted: false }, ctx))
      .toContain('wrong or rotated account key');
    expect(describeFailure({ ...base, status: 404, code: 'ContainerNotFound' }, ctx))
      .toBe('The container "files" is missing in storage account "acctname1". Create it or enable "Create container if missing".');
    expect(describeFailure({ ...base, status: 403, code: 'KeyBasedAuthenticationNotPermitted' }, ctx))
      .toBe('Key-based access is turned off for this storage account. Use a SAS token or Microsoft Entra ID.');
    expect(describeFailure({ ...base, status: 403, code: 'AuthorizationFailure' }, ctx)).toMatch(/firewall/);
    expect(describeFailure({ ...base, status: 403, code: 'AuthorizationPermissionMismatch' }, { ...ctx, authMethod: 'entra' })).toContain('Storage Blob Data Contributor');
    expect(describeFailure({ ...base, status: 403, code: 'AuthorizationPermissionMismatch' }, ctx)).toContain('c and w (create and write)');
    expect(describeFailure({ ...base, status: 403, code: 'AuthorizationPermissionMismatch' }, { ...ctx, operation: 'something else' })).toContain('racwdl');
    expect(describeFailure({ ...base, status: 403, code: 'AuthorizationPermissionMismatch' }, { ...ctx, operation: 'list' })).toContain('l (list)');
    expect(describeFailure({ ...base, status: 403, code: 'AuthorizationPermissionMismatch' }, { ...ctx, operation: 'create the container' })).toContain('may not create the container "files"');
    expect(describeFailure({ ...base, status: 400, code: 'InvalidHeaderValue', detail: 'The value for one of the HTTP headers is not in the correct format.' }, ctx)).toContain('API version');
    expect(describeFailure({ ...base, status: 500, code: 'Weird' }, ctx)).toBe('Azure Blob Storage upload failed with HTTP 500 (Weird).');
    expect(describeFailure({ ...base, status: 502, detail: 'Bad gateway: file not found upstream' }, ctx)).toBe('Azure Blob Storage upload failed with HTTP 502: Bad gateway: file not located upstream.');
    expect(describeFailure({ ...base, aborted: true }, ctx)).toBe('Azure Blob Storage did not answer in time (upload).');
  });

  it('explains an untrusted certificate and mentions the verification switch only where it exists', () => {
    const info = { aborted: false, blocked: false, systemCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' };
    const saas = describeFailure(info, ctx);
    expect(saas).toContain('"CA certificate" setting');
    expect(saas).not.toContain('Skip TLS verification');
    expect(describeFailure(info, { ...ctx, onPrem: true })).toContain('Skip TLS verification');
  });

  it('says which address a refused host resolves to without naming the target of a redirect or a URL', () => {
    const message = describeFailure({ aborted: false, blocked: true }, ctx);
    expect(message).toBe('acctname1.blob.core.windows.net resolves to a private or loopback address, which this deployment does not allow.');
  });

  it('turns an authentication detail into a hint that does not repeat it', () => {
    expect(authenticationHint(undefined)).toBeUndefined();
    expect(authenticationHint('something else entirely')).toBeUndefined();
    expect(authenticationHint('Signature not valid in the specified time frame: Start [Mon, 01 Jan 2024 00:00:00 GMT] - Expiry [Tue, 02 Jan 2024 00:00:00 GMT] - Current [Wed, 03 Jan 2024 00:00:00 GMT]'))
      .toContain('outside its validity window');
    expect(authenticationHint('Request date header too old')).toContain('clock');
    expect(authenticationHint('AADSTS500011: wrong audience')).toContain('audience');
  });

  it('keeps the phrases a route turns into a 404 out of service text', () => {
    expect(withoutMissingPhrases('The specified blob does not exist.')).toBe('The specified blob is not present.');
    expect(withoutMissingPhrases("Tenant 'x' Not Found")).toBe("Tenant 'x' not located");
  });

  it('scrubs credentials and anything shaped like one', () => {
    const text = 'GET https://a.blob.core.windows.net/c?sv=1&sig=abc%2Fdef&se=2 failed; AccountKey=zzzz1234abcd; Authorization: Bearer eyJ.abc-def_1; SharedAccessSignature=sv=1&sig=q; secret-value-1';
    const scrubbed = redactSecrets(text, ['secret-value-1', 'tiny']);
    expect(scrubbed).not.toContain('abc%2Fdef');
    expect(scrubbed).not.toContain('zzzz1234abcd');
    expect(scrubbed).not.toContain('eyJ.abc-def_1');
    expect(scrubbed).not.toContain('secret-value-1');
    expect(scrubbed).toContain('sig=[redacted]');
    expect(redactSecrets('plain', [])).toBe('plain');
  });
});

describe('Microsoft Entra client-credentials token source', () => {
  const config = { authorityHost: 'https://login.microsoftonline.com', tenantId: 'contoso.onmicrosoft.com', clientId: CLIENT, clientSecret: 'super-secret-value' };
  const tokenBody = (token: string, expires_in: number | string = 3600) => new Response(JSON.stringify({ access_token: token, expires_in, token_type: 'Bearer' }), { status: 200 });

  it('asks the v2.0 token endpoint for the storage scope, then serves the cache', async () => {
    const fetchImpl = vi.fn(async () => tokenBody('tok-1'));
    const credential = createClientSecretCredential({ ...config, fetchImpl });
    expect((await credential.getToken())?.token).toBe('tok-1');
    expect((await credential.getToken())?.token).toBe('tok-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: CLIENT, client_secret: 'super-secret-value', scope: STORAGE_SCOPE });
    expect(STORAGE_SCOPE).toBe('https://storage.azure.com/.default');
  });

  it('puts the tenant into the path as one safe segment, whatever it holds', async () => {
    const fetchImpl = vi.fn(async () => tokenBody('tok'));
    await createClientSecretCredential({ ...config, tenantId: CLIENT, authorityHost: 'https://login.microsoftonline.us/', fetchImpl }).getToken();
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(`https://login.microsoftonline.us/${CLIENT}/oauth2/v2.0/token`);
  });

  it('asks for the configured tenant and the storage scope whatever the caller passes (the SDK forwards the scopes and tenant a challenge names)', async () => {
    const fetchImpl = vi.fn(async () => tokenBody('tok', 1));
    const credential = createClientSecretCredential({ ...config, fetchImpl });
    await credential.getToken(['https://graph.microsoft.com/.default'], { tenantId: '11111111-2222-3333-4444-555555555555' });
    await credential.getToken('https://vault.azure.net/.default', { tenantId: 'login.other.example' });
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(call[0]).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token');
      expect(new URLSearchParams(String(call[1].body)).get('scope')).toBe(STORAGE_SCOPE);
    }
  });

  it('shares one request between concurrent callers and refreshes shortly before expiry', async () => {
    let clock = 1_000_000;
    const fetchImpl = vi.fn(async () => tokenBody(`tok-${fetchImpl.mock.calls.length}`, 3600));
    const credential = createClientSecretCredential({ ...config, fetchImpl, now: () => clock });
    const [a, b, c] = await Promise.all([credential.getToken(), credential.getToken(), credential.getToken()]);
    expect([a?.token, b?.token, c?.token]).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(a?.expiresOnTimestamp).toBe(1_000_000 + 3600 * 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += (3600 - 90) * 1000; // still outside the one-minute skew
    expect((await credential.getToken())?.token).toBe('tok-1');
    clock += 60 * 1000; // inside it
    expect((await credential.getToken())?.token).toBe('tok-2');
  });

  it('reads a lifetime sent as text, and falls back to an hour', async () => {
    const clock = 5_000;
    const text = await createClientSecretCredential({ ...config, fetchImpl: async () => tokenBody('t', '120'), now: () => clock }).getToken();
    expect(text?.expiresOnTimestamp).toBe(5_000 + 120_000);
    const missing = await createClientSecretCredential({ ...config, fetchImpl: async () => new Response(JSON.stringify({ access_token: 't' }), { status: 200 }), now: () => clock }).getToken();
    expect(missing?.expiresOnTimestamp).toBe(5_000 + 3_600_000);
  });

  it('turns a rejection into a short message without the secret, trace lines or the AADSTS prefix twice', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: 'invalid_client',
      error_codes: [7000215],
      error_description: 'AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value.\r\nTrace ID: t\r\nCorrelation ID: c\r\nTimestamp: now',
    }), { status: 401 }));
    const error = await createClientSecretCredential({ ...config, fetchImpl }).getToken().catch((e) => e);
    expect(error).toBeInstanceOf(AzureBlobError);
    expect(error).toMatchObject({ statusCode: 401, code: 'EntraTokenRequestFailed', retryable: false });
    expect(error.message).toBe('Microsoft Entra rejected the service principal (invalid_client AADSTS7000215): Invalid client secret provided. Ensure the secret being sent in the request is the client secret value.');
    expect(error.message).not.toContain('super-secret-value');
    expect(error.message).not.toMatch(/Trace ID|Correlation/);
  });

  it('clips a long service sentence at a word boundary and keeps "not found" out of it', async () => {
    const long = `AADSTS90002: Tenant 'x' not found. ${'Check with your subscription administrator, this may happen if there are no active subscriptions. '.repeat(4)}`;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_request', error_codes: [90002], error_description: long }), { status: 400 }));
    const error = await createClientSecretCredential({ ...config, fetchImpl }).getToken().catch((e) => e);
    expect(error.message).toMatch(/\.\.\.$/);
    expect(error.message.length).toBeLessThan(330);
    expect(error.message).not.toMatch(/\bsubscripti\.\.\.$/);
    expect(error.message).not.toMatch(/not found/i);
    expect(error.statusCode).toBe(401);
  });

  it('survives a failed attempt (the next call asks again) and an unreachable authority', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('connect ETIMEDOUT'))
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
      .mockResolvedValueOnce(tokenBody('tok-ok'));
    const credential = createClientSecretCredential({ ...config, fetchImpl });
    const unreachable = await credential.getToken().catch((e) => e);
    expect(unreachable.message).toMatch(/Could not reach Microsoft Entra at https:\/\/login\.microsoftonline\.com: connect ETIMEDOUT\./);
    expect(unreachable.retryable).toBe(true);
    const gateway = await credential.getToken().catch((e) => e);
    expect(gateway.statusCode).toBe(502);
    expect(gateway.retryable).toBe(true);
    expect((await credential.getToken())?.token).toBe('tok-ok');
  });

  it('a refusal by the network policy is not retried, and shows the reason fetch hides in its cause', async () => {
    const refused = Object.assign(new Error('Refusing outbound request to private/loopback host: login.example'), { retryable: false });
    const blocked = await createClientSecretCredential({ ...config, fetchImpl: async () => { throw refused; } }).getToken().catch((e) => e);
    expect(blocked.retryable).toBe(false);
    const withCause = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const refusedConnection = await createClientSecretCredential({ ...config, fetchImpl: async () => { throw withCause; } }).getToken().catch((e) => e);
    expect(refusedConnection.message).toContain('fetch failed (ECONNREFUSED)');
  });

  it('never leaves the secret in a message, however the authority answers', async () => {
    const echoing = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'super-secret-value was rejected' }), { status: 401 }));
    const error = await createClientSecretCredential({ ...config, fetchImpl: echoing }).getToken().catch((e) => e);
    // the description is the authority's own sentence; the runtime scrubs known secrets again before it leaves
    expect(redactSecrets(error.message, [config.clientSecret])).not.toContain('super-secret-value');
  });

  it('refuses invalid configuration before any request', () => {
    const fetchImpl = vi.fn();
    const error = settingsError(() => createClientSecretCredential({ ...config, authorityHost: 'http://login.microsoftonline.com', fetchImpl }));
    expect(error.field).toBe('authorityHost');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('a token server that stalls or never stops', () => {
    const encoder = new TextEncoder();
    /** Headers now, then a partial answer, then silence: the stream is never closed. */
    const silentAfterHeaders = (onCancel?: () => void) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"access_to'));
        },
        cancel() {
          onCancel?.();
        },
      }),
      { status: 200 },
    );

    it('gives the whole exchange one deadline: an answer that goes silent ends in a retryable error', async () => {
      const cancelled = vi.fn();
      const fetchImpl = vi.fn(async () => silentAfterHeaders(cancelled));
      const credential = createClientSecretCredential({ ...config, fetchImpl, timeoutMs: 100 });
      const started = Date.now();
      const error = await credential.getToken().catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error).toMatchObject({ code: 'EntraTokenRequestFailed', retryable: true });
      expect(error.message).toBe('Microsoft Entra at https://login.microsoftonline.com did not finish answering within 100 ms.');
      expect(Date.now() - started).toBeLessThan(3000);
      // the half-read answer is given up, not left open
      expect(cancelled).toHaveBeenCalled();
    });

    it('does not stay wedged: the next call asks again, and callers that waited on the stuck request all get the failure', async () => {
      const fetchImpl = vi.fn()
        .mockImplementationOnce(async () => silentAfterHeaders())
        .mockImplementationOnce(async () => tokenBody('tok-after'));
      const credential = createClientSecretCredential({ ...config, fetchImpl, timeoutMs: 100 });
      const [first, second] = await Promise.all([credential.getToken().catch((e) => e), credential.getToken().catch((e) => e)]);
      expect(first).toBeInstanceOf(AzureBlobError);
      expect(second).toBe(first);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect((await credential.getToken())?.token).toBe('tok-after');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('hands the deadline to the request as its signal, and holds the line even when the request ignores it', async () => {
      const seen: Array<AbortSignal | null | undefined> = [];
      const hangs = vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init.signal);
        return new Promise<Response>(() => undefined);
      });
      const error = await createClientSecretCredential({ ...config, fetchImpl: hangs, timeoutMs: 100 }).getToken().catch((e) => e);
      expect(error).toMatchObject({ code: 'EntraTokenRequestFailed', retryable: true });
      expect(error.message).toMatch(/did not finish answering within 100 ms\.$/);
      expect(seen[0]).toBeInstanceOf(AbortSignal);
      expect(seen[0]?.aborted).toBe(true);
    });

    it('reads no more than the cap of an answer and stops reading there', async () => {
      const cancelled = vi.fn();
      let sent = 0;
      const endless = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 16 * 1024;
            controller.enqueue(new Uint8Array(16 * 1024).fill(0x61));
          },
          cancel() {
            cancelled();
          },
        }),
        { status: 200 },
      );
      const error = await createClientSecretCredential({ ...config, fetchImpl: async () => endless }).getToken().catch((e) => e);
      expect(error).toMatchObject({ code: 'EntraTokenRequestFailed', retryable: true });
      expect(error.message).toBe('Microsoft Entra at https://login.microsoftonline.com answered with more than 64 KiB, which is not a token response.');
      expect(cancelled).toHaveBeenCalled();
      expect(sent).toBeLessThan(1024 * 1024);
    });

    describe('an answer that only offers its text (no stream to read piece by piece)', () => {
      const textOnly = (text: () => Promise<string>) => ({ ok: true, status: 200, body: null, text }) as unknown as Response;

      it('is read, when it is a token', async () => {
        const credential = createClientSecretCredential({
          ...config,
          fetchImpl: async () => textOnly(async () => JSON.stringify({ access_token: 'tok-text', expires_in: 3600 })),
        });
        expect((await credential.getToken())?.token).toBe('tok-text');
      });

      it('is held to the same cap', async () => {
        const fetchImpl = async () => textOnly(async () => 'a'.repeat(64 * 1024 + 1));
        const error = await createClientSecretCredential({ ...config, fetchImpl }).getToken().catch((e) => e);
        expect(error).toMatchObject({ code: 'EntraTokenRequestFailed', retryable: true });
        expect(error.message).toBe('Microsoft Entra at https://login.microsoftonline.com answered with more than 64 KiB, which is not a token response.');
      });

      it('is held to the same deadline', async () => {
        const fetchImpl = async () => textOnly(() => new Promise<string>(() => undefined));
        const started = Date.now();
        const error = await createClientSecretCredential({ ...config, fetchImpl, timeoutMs: 100 }).getToken().catch((e) => e);
        expect(error).toMatchObject({ code: 'EntraTokenRequestFailed', retryable: true });
        expect(error.message).toBe('Microsoft Entra at https://login.microsoftonline.com did not finish answering within 100 ms.');
        expect(Date.now() - started).toBeLessThan(3000);
      });
    });

    it('does not turn an oversized error into an oversized message', async () => {
      const huge = new Response(JSON.stringify({ error: 'x'.repeat(5 * 1024 * 1024) }), { status: 400 });
      const error = await createClientSecretCredential({ ...config, fetchImpl: async () => huge }).getToken().catch((e) => e);
      expect(error.message.length).toBeLessThan(200);

      // within the cap, the machine-readable parts are still cut to a short token
      const longCode = new Response(JSON.stringify({ error: `invalid_client${'y'.repeat(20_000)}`, error_codes: [`7000215${'9'.repeat(20_000)}`] }), { status: 401 });
      const clipped = await createClientSecretCredential({ ...config, fetchImpl: async () => longCode }).getToken().catch((e) => e);
      expect(clipped).toMatchObject({ statusCode: 401, code: 'EntraTokenRequestFailed' });
      expect(clipped.message.length).toBeLessThan(200);
      expect(clipped.message).toMatch(/^Microsoft Entra rejected the service principal \(invalid_client/);
    });

    it('keeps only plain characters of the error code and the AADSTS number', async () => {
      const response = new Response(JSON.stringify({ error: 'invalid client\nsecret=zzz', error_codes: ['70 00 215<script>'] }), { status: 401 });
      const error = await createClientSecretCredential({ ...config, fetchImpl: async () => response }).getToken().catch((e) => e);
      expect(error.message).toBe('Microsoft Entra rejected the service principal (invalidclientsecretzzz AADSTS7000215script)');
    });

    it('honours the abort signal of a caller without ending the request the others share', async () => {
      let release!: (response: Response) => void;
      const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
      const credential = createClientSecretCredential({ ...config, fetchImpl });

      const controller = new AbortController();
      const impatient = credential.getToken(undefined, { abortSignal: controller.signal }).catch((e) => e);
      const patient = credential.getToken();
      controller.abort();
      const aborted = await impatient;
      expect(aborted).toBeInstanceOf(Error);
      expect(aborted).toMatchObject({ name: 'AbortError' });

      release(tokenBody('tok-shared'));
      expect((await patient)?.token).toBe('tok-shared');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('answers a signal that is already aborted at once, and a flight nobody waits for any more fails quietly', async () => {
      const failing = vi.fn(async () => { throw new Error('connect ETIMEDOUT'); });
      const credential = createClientSecretCredential({ ...config, fetchImpl: failing });
      const gone = new AbortController();
      gone.abort();
      await expect(credential.getToken(undefined, { abortSignal: gone.signal })).rejects.toMatchObject({ name: 'AbortError' });
      // let the flight that nobody waits for fail: an unhandled rejection would fail this run
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(failing).toHaveBeenCalledTimes(1);
      // the failed flight is over: the next caller starts afresh
      await expect(credential.getToken()).rejects.toThrow(/Could not reach Microsoft Entra/);
      expect(failing).toHaveBeenCalledTimes(2);
    });

    it('lets a caller that is not aborted through untouched, signal or not', async () => {
      const fetchImpl = vi.fn(async () => tokenBody('tok-1'));
      const credential = createClientSecretCredential({ ...config, fetchImpl });
      const quiet = new AbortController();
      expect((await credential.getToken(undefined, { abortSignal: quiet.signal }))?.token).toBe('tok-1');
      expect((await credential.getToken(undefined, { abortSignal: undefined }))?.token).toBe('tok-1');
      expect((await credential.getToken(undefined, {}))?.token).toBe('tok-1');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('reports an answer that breaks off as a retryable read failure', async () => {
      const broken = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"access'));
            controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }));
          },
        }),
        { status: 200 },
      );
      const error = await createClientSecretCredential({ ...config, fetchImpl: async () => broken }).getToken().catch((e) => e);
      expect(error).toBeInstanceOf(AzureBlobError);
      expect(error.retryable).toBe(true);
      expect(error.message).toBe('Could not read the answer of Microsoft Entra at https://login.microsoftonline.com: terminated (ECONNRESET).');
    });
  });
});

describe('SDK pipeline', () => {
  const sdk = fakeSdkModule as unknown as AzureBlobSdk;
  type Request = { headers: Map<string, string> & { set(k: string, v: string): void }; agent?: unknown };
  const request = (): Request => ({ headers: new Map<string, string>() as Request['headers'] });
  const drive = (pipeline: { factories: Array<{ create(next: { sendRequest(r: unknown): Promise<unknown> }): { sendRequest(r: unknown): Promise<unknown> } }> }, req: Request) =>
    pipeline.factories[0].create({ sendRequest: async (r) => r }).sendRequest(req);

  it('adds nothing when neither an API version nor an agent is needed (keeps the SDK default agent and its proxy support)', () => {
    const pipeline = buildPipeline(sdk, {} as never, {});
    expect(pipeline.factories).toHaveLength(0);
    const options = (pipeline as unknown as { options: { retryOptions: Record<string, number>; userAgentOptions: Record<string, string> } }).options;
    expect(options.retryOptions).toMatchObject({ maxTries: 2, retryDelayInMs: 500, maxRetryDelayInMs: 4000 });
    expect(options.userAgentOptions.userAgentPrefix).toBe('cognipeer-console');
  });

  it('sets x-ms-version and the agent ahead of signing, only the ones configured', async () => {
    const agent = new https.Agent();
    const both = buildPipeline(sdk, {} as never, { apiVersion: '2023-11-03', agent });
    const req = request();
    await drive(both as never, req);
    expect(req.headers.get('x-ms-version')).toBe('2023-11-03');
    expect(req.agent).toBe(agent);

    const versionOnly = request();
    await drive(buildPipeline(sdk, {} as never, { apiVersion: '2023-11-03' }) as never, versionOnly);
    expect(versionOnly.agent).toBeUndefined();

    const agentOnly = request();
    await drive(buildPipeline(sdk, {} as never, { agent }) as never, agentOnly);
    expect(agentOnly.headers.has('x-ms-version')).toBe(false);
    agent.destroy();
  });

  it('takes the retry bound from the caller', () => {
    const pipeline = buildPipeline(sdk, {} as never, { maxTries: 5 });
    expect((pipeline as unknown as { options: { retryOptions: { maxTries: number } } }).options.retryOptions.maxTries).toBe(5);
  });
});
