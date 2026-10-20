/**
 * The pure helpers of the S3 file drivers: how an endpoint, a region and a bucket are read, how keys and the base
 * prefix are built, how user metadata is encoded for the wire and read back, and how a provider's location is shown.
 */
import { describe, expect, it } from 'vitest';
import { ProviderSettingsError } from '@/lib/providers/errors';
import {
  buildS3Metadata,
  decodeS3Metadata,
  decodeS3MetadataValue,
  describeS3Location,
  encodeS3MetadataValue,
  generateKey,
  normalizeS3Endpoint,
  resolveS3Bucket,
  resolveS3Region,
  S3_METADATA_BUDGET_BYTES,
  S3_METADATA_MAX_ENTRIES,
  S3_METADATA_PREFIX_BYTES,
  s3BasePrefix,
  s3EndpointHost,
  sanitizeKey,
  settingText,
  toS3MetadataKey,
} from '@/lib/providers/contracts/s3/s3Helpers';

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

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

describe('settingText', () => {
  it('trims text and treats everything else as unset', () => {
    expect(settingText('  minio  ')).toBe('minio');
    expect(settingText('')).toBeUndefined();
    expect(settingText('   ')).toBeUndefined();
    expect(settingText(undefined)).toBeUndefined();
    expect(settingText(null)).toBeUndefined();
    expect(settingText(42)).toBeUndefined();
    expect(settingText({})).toBeUndefined();
  });
});

describe('normalizeS3Endpoint', () => {
  it.each([
    [' HTTP://MinIO.Internal:9000// ', 'http://minio.internal:9000'],
    ['https://minio.internal:9000', 'https://minio.internal:9000'],
    ['https://minio.internal:9000/', 'https://minio.internal:9000'],
    ['https://gw.example.com/s3/', 'https://gw.example.com/s3'],
    ['https://gw.example.com/some/prefix///', 'https://gw.example.com/some/prefix'],
    ['http://[::1]:9000', 'http://[::1]:9000'],
    ['http://127.0.0.1:9000/', 'http://127.0.0.1:9000'],
    ['http://host:80/', 'http://host'],
    ['https://host:443', 'https://host'],
    ['https://s3.eu-central-1.amazonaws.com', 'https://s3.eu-central-1.amazonaws.com'],
  ])('reads %j as %j', (raw, expected) => {
    expect(normalizeS3Endpoint(raw)).toBe(expected);
    expect(normalizeS3Endpoint(raw, { strict: true })).toBe(expected);
  });

  it('keeps reading what the SDK always tolerated (user info, query, fragment are ignored) unless strict', () => {
    expect(normalizeS3Endpoint('http://user:pw@minio:9000')).toBe('http://minio:9000');
    expect(normalizeS3Endpoint('http://127.0.0.1:9000?x=1')).toBe('http://127.0.0.1:9000');
    expect(normalizeS3Endpoint('https://minio:9000/s3#frag')).toBe('https://minio:9000/s3');
  });

  it.each([
    'minio:9000',
    'minio.internal',
    'localhost:9000',
    '127.0.0.1:9000',
    'ftp://minio.internal',
    'file:///etc/passwd',
    's3://bucket',
    'http://',
    'https://:9000',
    'http:/minio:9000',
    '',
    '   ',
  ])('refuses %j', (raw) => {
    const error = settingsError(() => normalizeS3Endpoint(raw));
    expect(error.field).toBe('endpoint');
    expect(error.code).toBe('provider_settings_invalid');
    expect(error.retryable).toBe(false);
  });

  it('asks for the scheme with an example when it is missing', () => {
    expect(settingsError(() => normalizeS3Endpoint('minio.internal:9000')).message).toBe(
      'Endpoint URL must start with http:// or https:// (for example https://minio.internal:9000).',
    );
  });

  it('refuses user info, a query and a fragment when strict, without echoing them', () => {
    for (const raw of ['http://admin:hunter2@minio:9000', 'http://minio:9000?token=hunter2', 'http://minio:9000#hunter2', 'http://hunter2@minio:9000']) {
      const error = settingsError(() => normalizeS3Endpoint(raw, { strict: true }));
      expect(error.field).toBe('endpoint');
      expect(error.message).not.toContain('hunter2');
    }
  });
});

describe('s3EndpointHost', () => {
  it('names the host and port only', () => {
    expect(s3EndpointHost('https://MinIO.internal:9000')).toBe('minio.internal:9000');
    expect(s3EndpointHost('https://minio.internal')).toBe('minio.internal');
    expect(s3EndpointHost('http://[::1]:9000/s3')).toBe('[::1]:9000');
    expect(s3EndpointHost('http://user:secret@minio.internal:9000/s3?x=1#y')).toBe('minio.internal:9000');
  });

  it('is undefined for nothing or for a value that is not an http(s) endpoint', () => {
    expect(s3EndpointHost(undefined)).toBeUndefined();
    expect(s3EndpointHost('')).toBeUndefined();
    expect(s3EndpointHost('not a url')).toBeUndefined();
    expect(s3EndpointHost('minio.internal:9000')).toBeUndefined();
  });
});

describe('resolveS3Region and resolveS3Bucket', () => {
  it('defaults a custom endpoint to us-east-1 and requires a region for Amazon S3', () => {
    expect(resolveS3Region(undefined, true)).toBe('us-east-1');
    expect(resolveS3Region('  ', true)).toBe('us-east-1');
    expect(resolveS3Region(' auto ', true)).toBe('auto');
    expect(resolveS3Region('eu-central-1', false)).toBe('eu-central-1');
    const error = settingsError(() => resolveS3Region(undefined, false));
    expect(error.field).toBe('region');
    expect(error.message).toMatch(/required for Amazon S3/);
  });

  it('does not judge the shape of a stored region or bucket (that is the save-time check)', () => {
    expect(resolveS3Region('EU West', true)).toBe('EU West');
    expect(resolveS3Bucket(' ab ')).toBe('ab');
    expect(resolveS3Bucket('my_bucket.name')).toBe('my_bucket.name');
  });

  it('needs a bucket', () => {
    for (const value of [undefined, '', '  ', null, 7]) {
      expect(settingsError(() => resolveS3Bucket(value)).field).toBe('bucket');
    }
  });
});

describe('keys and base prefix', () => {
  it('sanitizeKey strips slashes, reads backslashes as slashes, collapses runs of dots and refuses an empty key', () => {
    expect(sanitizeKey('/a/b/')).toBe('a/b');
    expect(sanitizeKey('a\\b\\c.txt')).toBe('a/b/c.txt');
    expect(sanitizeKey('///x')).toBe('x');
    // ".." never survives: runs of dots collapse to one, so a key cannot climb out of the provider's prefix
    expect(sanitizeKey('..')).toBe('.');
    expect(sanitizeKey('../x')).toBe('./x');
    expect(sanitizeKey('a/../b')).toBe('a/./b');
    expect(sanitizeKey('a....b')).toBe('a.b');
    expect(() => sanitizeKey('/')).toThrow('Invalid file key provided.');
    expect(() => sanitizeKey('')).toThrow('Invalid file key provided.');
  });

  it('generateKey keeps the extension and a readable lower-case stem', () => {
    expect(generateKey('report.pdf')).toMatch(/^report-\d+-[0-9a-f]{8}\.pdf$/);
    expect(generateKey('Rapor Şubat.PDF')).toMatch(/^rapor-ubat-\d+-[0-9a-f]{8}\.PDF$/);
    expect(generateKey('My File (1).TXT')).toMatch(/^my-file-1--\d+-[0-9a-f]{8}\.TXT$/);
    expect(generateKey()).toMatch(/^\d+-[0-9a-f-]{36}$/);
  });

  it('s3BasePrefix joins prefix, tenant and provider key, each only when given', () => {
    expect(s3BasePrefix('console/files', 'tenant1', 'minio-main')).toBe('console/files/tenant1/minio-main/');
    expect(s3BasePrefix(undefined, 'tenant1', 'minio-main')).toBe('tenant1/minio-main/');
    expect(s3BasePrefix('', 'tenant1', 'minio-main')).toBe('tenant1/minio-main/');
    expect(s3BasePrefix('   ', 'tenant1', 'minio-main')).toBe('tenant1/minio-main/');
    expect(s3BasePrefix('/x/', 'tenant1', 'minio-main')).toBe('x/tenant1/minio-main/');
    expect(s3BasePrefix('a/b/', '/tenant1/', 'k')).toBe('a/b/tenant1/k/');
    expect(s3BasePrefix(42, 'tenant1', 'k')).toBe('tenant1/k/');
    expect(s3BasePrefix(undefined, '', '')).toBe('');
  });
});

describe('describeS3Location', () => {
  const settings = { bucket: 'archive', prefix: 'console/files' };

  it('names the bucket and the base prefix of the runtime, ending with a slash', () => {
    expect(describeS3Location(settings, 'tenant1', 'amazon-main')).toBe('s3://archive/console/files/tenant1/amazon-main/');
    expect(describeS3Location({ bucket: 'archive' }, 'tenant1', 'amazon-main')).toBe('s3://archive/tenant1/amazon-main/');
  });

  it('uses exactly the prefix the runtime keys objects under', () => {
    const location = describeS3Location({ bucket: 'b', prefix: '/pre/' }, 't', 'k');
    expect(location).toBe(`s3://b/${s3BasePrefix('/pre/', 't', 'k')}`);
  });

  it('adds the host and port of a custom endpoint, and nothing else of it', () => {
    expect(describeS3Location({ ...settings, endpoint: 'https://minio.internal:9000' }, 'tenant1', 'minio')).toBe(
      's3://archive/console/files/tenant1/minio/ · minio.internal:9000',
    );
    expect(describeS3Location({ ...settings, endpoint: 'https://admin:hunter2@minio.internal/s3/path?token=hunter2' }, 'tenant1', 'minio')).toBe(
      's3://archive/console/files/tenant1/minio/ · minio.internal',
    );
  });

  it('leaves the suffix out for an endpoint that does not parse, and is null without a bucket', () => {
    expect(describeS3Location({ ...settings, endpoint: 'minio.internal:9000' }, 't', 'k')).toBe('s3://archive/console/files/t/k/');
    expect(describeS3Location({ prefix: 'x' }, 't', 'k')).toBeNull();
    expect(describeS3Location({ bucket: '  ' }, 't', 'k')).toBeNull();
  });
});

describe('S3 user metadata codec', () => {
  const NAMES = [
    'rapor_şubat.pdf',
    'çıktı.docx',
    'Güneş_Ağaç.pdf',
    'Çözüm_üretim.pdf',
    'İstanbul İÇ.txt',
    'report-\u{1F642}.pdf',
    '日本語のファイル.txt',
    'плейн.pdf',
  ];

  it('sends printable ASCII as it is', () => {
    for (const value of ['plain.pdf', 'with spaces inside', 'a=b?c', 'x'.repeat(500), '~!@#$%^&*()_+{}|:"<>?']) {
      expect(encodeS3MetadataValue(value)).toBe(value);
    }
    expect(encodeS3MetadataValue('')).toBe('');
  });

  it.each(NAMES)('writes %s as ASCII and reads exactly it back', (name) => {
    const encoded = encodeS3MetadataValue(name);
    expect(encoded).toMatch(PRINTABLE_ASCII);
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true);
    expect(decodeS3MetadataValue(encoded)).toBe(name);
  });

  it('wraps every value a header would mangle: edge spaces, line breaks, control characters, DEL', () => {
    for (const value of [' leading', 'trailing ', ' both ', 'line\r\nbreak', 'tab\tinside', 'nul\u0000byte', 'del\u007fchar', 'ç']) {
      const encoded = encodeS3MetadataValue(value);
      expect(encoded, JSON.stringify(value)).toMatch(PRINTABLE_ASCII);
      expect(encoded.startsWith('=?UTF-8?B?')).toBe(true);
      expect(decodeS3MetadataValue(encoded)).toBe(value);
    }
  });

  it('wraps a plain value that already looks like an encoded word, so reading returns what was written', () => {
    for (const value of ['=?UTF-8?B?aGk=?=', 'prefix =?UTF-8?Q?=C5=9F?= suffix', '=?ISO-8859-1?Q?caf=E9?=', '=?x?b?AAAA?=']) {
      const encoded = encodeS3MetadataValue(value);
      expect(encoded).not.toBe(value);
      expect(decodeS3MetadataValue(encoded)).toBe(value);
    }
  });

  describe('decoding what other writers and the stores produce', () => {
    it.each([
      ['=?UTF-8?B?xZ91YmF0?=', 'şubat'],
      ['=?utf-8?b?xZ91YmF0?=', 'şubat'],
      ['=?UTF-8?Q?=C5=9Fubat?=', 'şubat'],
      ['=?UTF-8?q?=c5=9fubat?=', 'şubat'],
      ['=?ISO-8859-1?Q?=E7ok_g=FC=E7l=FC?=', 'çok güçlü'],
      ['=?iso-8859-1?q?caf=E9?=', 'café'],
      ['=?ISO-8859-1?B?5+c=?=', 'çç'],
      ['=?UTF-8*tr?Q?=C5=9Fubat?=', 'şubat'],
      ['=?US-ASCII?Q?plain_text?=', 'plain text'],
      ['=?UTF-8?Q?a_b?=', 'a b'],
      ['Rapor =?UTF-8?Q?=C5=9Fubat?= 2024', 'Rapor şubat 2024'],
    ])('reads %s as %j', (encoded, expected) => {
      expect(decodeS3MetadataValue(encoded)).toBe(expected);
    });

    it('joins adjacent words and drops the white space between them (RFC 2047)', () => {
      expect(decodeS3MetadataValue('=?UTF-8?B?xZ91?= =?UTF-8?B?YmF0?=')).toBe('şubat');
      expect(decodeS3MetadataValue('=?UTF-8?Q?=C5=9Fu?=\t =?UTF-8?Q?bat?=')).toBe('şubat');
      // text between two words is kept, white space and all
      expect(decodeS3MetadataValue('=?UTF-8?Q?a?= and =?UTF-8?Q?b?=')).toBe('a and b');
    });

    it('leaves what it cannot read exactly as it is', () => {
      for (const value of [
        '=?KOI8-R?B?0NLJ18XU?=', // a charset it does not know
        '=?UTF-8?Q?=ZZ?=', // malformed escape
        '=?UTF-8?Q?=C5=9?=', // truncated escape
        '=?UTF-8?B?not base64!?=', // not base64
        '=?UTF-8?X?abc?=', // not an encoding
        '=?UTF-8?B?abc',
        'plain =? text',
        '',
      ]) {
        expect(decodeS3MetadataValue(value), value).toBe(value);
      }
    });

    it('reads a bad word next to a good one without losing either', () => {
      expect(decodeS3MetadataValue('=?KOI8-R?B?AAAA?= =?UTF-8?Q?ok?=')).toBe('=?KOI8-R?B?AAAA?= ok');
    });

    it('decodes a lot of words in linear time', () => {
      const value = '=?UTF-8?Q?a?= '.repeat(2000).trimEnd();
      const started = performance.now();
      expect(decodeS3MetadataValue(value)).toBe('a'.repeat(2000));
      expect(performance.now() - started).toBeLessThan(500);
      const hostile = `${'=?x?B?'.repeat(5000)}`;
      const started2 = performance.now();
      expect(decodeS3MetadataValue(hostile)).toBe(hostile);
      expect(performance.now() - started2).toBeLessThan(500);
    });
  });

  it('decodeS3Metadata maps every value and passes nothing through as nothing', () => {
    expect(decodeS3Metadata(undefined)).toBeUndefined();
    expect(decodeS3Metadata({ originalname: encodeS3MetadataValue('çıktı.docx'), checksum: 'abc', title: '=?UTF-8?Q?=C5=9Fubat?=' })).toEqual({
      originalname: 'çıktı.docx',
      checksum: 'abc',
      title: 'şubat',
    });
  });
});

describe('toS3MetadataKey', () => {
  it.each([
    ['originalName', 'originalname'],
    ['source_key', 'source-key'],
    ['Source Key', 'source-key'],
    ['--a--b--', 'a-b'],
    ['x.y', 'x-y'],
    ['ad ı', 'ad'],
    ['A1_B2', 'a1-b2'],
  ])('writes %j as %j', (key, expected) => {
    expect(toS3MetadataKey(key)).toBe(expected);
  });

  it('has no name for a key with nothing usable in it, and caps the length', () => {
    expect(toS3MetadataKey('çç')).toBeNull();
    expect(toS3MetadataKey('___')).toBeNull();
    expect(toS3MetadataKey('')).toBeNull();
    expect(toS3MetadataKey('k'.repeat(200))).toHaveLength(64);
  });

  it.each([
    ['user_id', 'user_id'],
    ['customer.id', 'customer.id'],
    ['Source_Key', 'source_key'],
    ['x-y', 'x-y'],
    // what a header name cannot carry is still rewritten
    ['Source Key', 'source-key'],
    ['ad ı', 'ad'],
    ['üser_id', 'ser_id'],
  ])('keeps the punctuation of an Amazon S3 key: %j becomes %j', (key, expected) => {
    expect(toS3MetadataKey(key, { keepPunctuation: true })).toBe(expected);
  });

  it('still has no name for a key that is only punctuation to rewrite', () => {
    expect(toS3MetadataKey('çç', { keepPunctuation: true })).toBeNull();
    expect(toS3MetadataKey('--', { keepPunctuation: true })).toBeNull();
  });
});

describe('buildS3Metadata', () => {
  it('builds header-safe pairs from keys and values of any kind', () => {
    const { metadata, dropped } = buildS3Metadata([
      ['checksum', 'abc123'],
      ['originalName', 'rapor_şubat.pdf'],
      ['source_key', 'a'],
      ['count', 3],
      ['flag', true],
      ['when', new Date('2024-02-03T04:05:06.000Z')],
      ['nested', { a: 1, b: ['ş'] }],
      ['empty', ''],
    ]);
    expect(dropped).toEqual([]);
    expect(metadata).toEqual({
      checksum: 'abc123',
      originalname: encodeS3MetadataValue('rapor_şubat.pdf'),
      'source-key': 'a',
      count: '3',
      flag: 'true',
      when: '2024-02-03T04:05:06.000Z',
      nested: encodeS3MetadataValue('{"a":1,"b":["ş"]}'),
      empty: '',
    });
    for (const value of Object.values(metadata!)) expect(value).toMatch(PRINTABLE_ASCII);
    expect(decodeS3Metadata(metadata)!.nested).toBe('{"a":1,"b":["ş"]}');
  });

  it('skips unset values and returns nothing when nothing is left', () => {
    expect(buildS3Metadata([])).toEqual({ metadata: undefined, dropped: [] });
    expect(buildS3Metadata([['a', undefined], ['b', null]])).toEqual({ metadata: undefined, dropped: [] });
  });

  it('keeps the first of two keys that become the same name, and any key that is not an object property of its own', () => {
    const { metadata, dropped } = buildS3Metadata([['a_b', '1'], ['a-b', '2'], ['A B', '3'], ['constructor', 'x'], ['toString', 'y']]);
    expect(metadata).toEqual({ 'a-b': '1', constructor: 'x', tostring: 'y' });
    expect(dropped).toEqual(['a-b', 'A B']);
  });

  it('leaves out keys without a usable name and values that cannot be written, and says which', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { metadata, dropped } = buildS3Metadata([['çç', 'x'], ['ok', 'fine'], ['loop', circular], ['big', BigInt(5) as unknown as string]]);
    expect(dropped).toEqual(['çç', 'loop']);
    expect(metadata).toEqual({ ok: 'fine', big: '5' });
  });

  it('stays inside the metadata budget: what does not fit is left out, in order, and never the entries before it', () => {
    const entries: Array<[string, unknown]> = [['checksum', 'c'.repeat(64)], ['originalName', 'o'.repeat(100)]];
    for (let index = 0; index < 40; index += 1) entries.push([`field${index}`, 'v'.repeat(90)]);
    const { metadata, dropped } = buildS3Metadata(entries);
    const used = Object.entries(metadata!).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0);
    expect(used).toBeLessThanOrEqual(S3_METADATA_BUDGET_BYTES);
    expect(metadata!.checksum).toBeDefined();
    expect(metadata!.originalname).toBeDefined();
    expect(metadata!.field0).toBeDefined();
    expect(dropped.length).toBeGreaterThan(0);
    // dropped entries are the tail: the kept ones are a prefix of the input
    const keptCount = Object.keys(metadata!).length;
    expect(dropped).toEqual(entries.slice(keptCount).map(([key]) => key));
  });

  it('counts the encoded size, not the plain size', () => {
    // 'ş' x 400 is 800 bytes plain but 1068 base64 characters
    const { metadata, dropped } = buildS3Metadata([['a', 'ş'.repeat(400)], ['b', 'ş'.repeat(400)]]);
    expect(Object.keys(metadata!)).toEqual(['a']);
    expect(dropped).toEqual(['b']);
  });

  it('drops a single value that is larger than the whole budget instead of failing', () => {
    const { metadata, dropped } = buildS3Metadata([['big', 'y'.repeat(5000)], ['small', 'ok']]);
    expect(metadata).toEqual({ small: 'ok' });
    expect(dropped).toEqual(['big']);
  });

  /** What a store counts: every entry as the header `x-amz-meta-<key>: <value>`. */
  const onTheWire = (metadata: Record<string, string> | undefined) =>
    Object.entries(metadata ?? {}).reduce((sum, [key, value]) => sum + S3_METADATA_PREFIX_BYTES + Buffer.byteLength(key) + Buffer.byteLength(value), 0);

  it('charges the x-amz-meta- prefix of every entry, so what fits here fits a store that counts it', () => {
    expect(S3_METADATA_PREFIX_BYTES).toBe('x-amz-meta-'.length);
    // the driver's own two entries plus three user entries: 1996 bytes of keys and values, 2051 on the wire
    const entries: Array<[string, unknown]> = [
      ['checksum', 'f'.repeat(64)],
      ['originalName', 'a.txt'],
      ['a', 'x'.repeat(635)],
      ['b', 'y'.repeat(635)],
      ['c', 'z'.repeat(634)],
    ];
    const { metadata, dropped } = buildS3Metadata(entries);
    expect(dropped).toEqual(['c']);
    expect(Object.keys(metadata!)).toEqual(['checksum', 'originalname', 'a', 'b']);
    expect(onTheWire(metadata)).toBeLessThanOrEqual(S3_METADATA_BUDGET_BYTES);
  });

  it.each([1, 2, 3, 4, 5, 8, 13, 21, 34, 55, 90])('never goes past the budget on the wire when %i entries fill it', (count) => {
    const entries: Array<[string, unknown]> = [['checksum', 'f'.repeat(64)], ['originalName', 'a.txt']];
    // the longest value that lets every one of the `count` entries fit, plus a little more so the last one may not
    const fixed = onTheWire(buildS3Metadata(entries).metadata);
    const room = Math.floor((S3_METADATA_BUDGET_BYTES - fixed) / count) - S3_METADATA_PREFIX_BYTES - 3;
    for (let index = 0; index < count; index += 1) entries.push([`k${String(index).padStart(2, '0')}`, 'v'.repeat(Math.max(room + 6, 0))]);
    const { metadata } = buildS3Metadata(entries);
    expect(onTheWire(metadata)).toBeLessThanOrEqual(S3_METADATA_BUDGET_BYTES);
    // the 2 KiB of a store that counts the prefix, with headroom
    expect(onTheWire(metadata)).toBeLessThanOrEqual(2048 - 48);
  });

  it('caps the number of entries, whatever their size, and drops the tail', () => {
    const entries: Array<[string, unknown]> = [];
    for (let index = 0; index < 150; index += 1) entries.push([`k${index}`, 'v']);
    const { metadata, dropped } = buildS3Metadata(entries);
    expect(Object.keys(metadata!)).toHaveLength(S3_METADATA_MAX_ENTRIES);
    expect(Object.keys(metadata!)[0]).toBe('k0');
    expect(dropped).toEqual(entries.slice(S3_METADATA_MAX_ENTRIES).map(([key]) => key));
    // 150 one-byte entries would have been accounted at 729 bytes before the prefix was charged
    expect(onTheWire(metadata)).toBeLessThanOrEqual(S3_METADATA_BUDGET_BYTES);
  });

  it('keeps `_` and `.` in a key when told to, and normalises the rest', () => {
    const entries: Array<[string, unknown]> = [['user_id', 'u1'], ['customer.id', 'c1'], ['Source Key', 's']];
    expect(buildS3Metadata(entries).metadata).toEqual({ 'user-id': 'u1', 'customer-id': 'c1', 'source-key': 's' });
    expect(buildS3Metadata(entries, { keepPunctuation: true }).metadata).toEqual({ user_id: 'u1', 'customer.id': 'c1', 'source-key': 's' });
  });
});
