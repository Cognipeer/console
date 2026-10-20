/**
 * What a failed S3 call becomes: an `S3OperationError` whose message says what to change and whose `retryable` and
 * `statusCode` tell the resilience layer how to treat it.
 *
 * The cases that come from a store are produced by the real AWS SDK talking to the in-process fake S3 server, so the
 * error objects are the ones the SDK really raises (an XML code, an HTML page where XML was expected, a refused
 * connection); the Node-level codes that cannot be provoked on a loopback socket are checked on synthetic errors.
 */
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { describeS3Error, invalidKeyError, isS3OperationError, S3_ERROR_MESSAGE_MAX_CHARS, S3OperationError } from '@/lib/providers/contracts/s3/s3Errors';
import { createS3FileRuntime, type S3FileRuntime } from '@/lib/providers/contracts/s3/s3FileRuntime';
import type { S3CompatibleSettings } from '@/lib/providers/contracts/s3/s3Helpers';
import { OutboundDnsError, OutboundNetworkError } from '@/lib/security/outboundFetch';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';
import { s3Error, startFakeS3, type FakeS3, type FakeS3Options, type FakeS3Response } from '../helpers/fakeS3Server';

const SECRET = 'secret-secret-secret';
const credentials = { accessKeyId: 'AKIATEST', secretAccessKey: SECRET };

const original = getConfigSource();
const servers: FakeS3[] = [];
const runtimes: S3FileRuntime[] = [];

beforeEach(() => {
  // a loopback server is a private target: this is a self-hosted deployment
  setConfigSource({ get: (key: string) => ({ DEPLOYMENT_MODE: 'onprem' } as Record<string, string>)[key] ?? process.env[key] } as ConfigSource);
});

afterEach(async () => {
  setConfigSource(original);
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const server of servers.splice(0)) await server.close();
});

async function fakeStore(options: FakeS3Options = {}): Promise<FakeS3> {
  const server = await startFakeS3({ buckets: ['bkt3'], ...options });
  servers.push(server);
  return server;
}

/** A store that answers every request the same way. */
const storeAnswering = (response: FakeS3Response) => fakeStore({ intercept: () => response });

async function runtimeOn(url: string, settings: Partial<S3CompatibleSettings> = {}, createBucketIfMissing = false): Promise<S3FileRuntime> {
  const runtime = await createS3FileRuntime({
    tenantId: 'tenant1',
    providerKey: 'minio-main',
    credentials,
    settings: { endpoint: url, bucket: 'bkt3', ...settings },
    requireEndpoint: true,
    createBucketIfMissing,
  });
  runtimes.push(runtime);
  return runtime;
}

async function failureOf(run: () => Promise<unknown>): Promise<S3OperationError> {
  try {
    await run();
  } catch (error) {
    expect(isS3OperationError(error), error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toBe(true);
    return error as S3OperationError;
  }
  throw new Error('expected the call to fail');
}

/** What every message has to satisfy, whatever the cause. */
function expectSafeMessage(error: { code: string; message: string }): void {
  expect(error.message.length).toBeLessThanOrEqual(S3_ERROR_MESSAGE_MAX_CHARS);
  expect(error.message).not.toMatch(/[<>]/);
  expect(error.message).not.toContain(SECRET);
  expect(error.message).not.toContain(credentials.accessKeyId);
  // the file routes answer 404 for these two phrases: only the missing-object message may use them
  if (error.code !== 'object_missing') expect(error.message).not.toMatch(/not found|does not exist/i);
}

const upload = (runtime: S3FileRuntime) => runtime.uploadFile({ name: 'a.txt', data: Buffer.from('payload') });
const list = (runtime: S3FileRuntime) => runtime.listFiles();
const download = (runtime: S3FileRuntime) => runtime.downloadFile('k.txt');
const remove = (runtime: S3FileRuntime) => runtime.deleteFile('k.txt');
const html = (status: number, body: string): FakeS3Response => ({ status, headers: { 'content-type': 'text/html' }, body });

interface StoreCase {
  name: string;
  response: FakeS3Response;
  run: (runtime: S3FileRuntime) => Promise<unknown>;
  code: string;
  retryable: boolean;
  status: number;
  message?: RegExp;
  /** How many requests the server saw (the SDK retries a transient failure once). */
  requests?: number;
}

const STORE_CASES: StoreCase[] = [
  { name: 'NoSuchBucket on a listing', response: s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist'), run: list, code: 'bucket_missing', retryable: false, status: 404, message: /Bucket "bkt3" is missing on 127\.0\.0\.1:\d+\. .*Create bucket if missing/, requests: 1 },
  { name: 'NoSuchKey on a download', response: s3Error(404, 'NoSuchKey', 'The specified key does not exist.'), run: download, code: 'object_missing', retryable: false, status: 404, message: /^The object does not exist\.$/, requests: 1 },
  { name: 'InvalidAccessKeyId', response: s3Error(403, 'InvalidAccessKeyId', 'The Access Key Id you provided does not exist in our records.'), run: list, code: 'invalid_access_key', retryable: false, status: 403, message: /does not recognise this access key ID/, requests: 1 },
  { name: 'SignatureDoesNotMatch', response: s3Error(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.'), run: list, code: 'signature_mismatch', retryable: false, status: 403, message: /secret access key is wrong.*Host header/ },
  { name: 'AccessDenied on an upload', response: s3Error(403, 'AccessDenied', 'Access Denied.'), run: upload, code: 'access_denied', retryable: false, status: 403, message: /Access denied on bucket "bkt3".*PutObject/, requests: 1 },
  { name: 'AllAccessDisabled', response: s3Error(403, 'AllAccessDisabled', 'All access to this object has been disabled'), run: remove, code: 'access_denied', retryable: false, status: 403, requests: 1 },
  { name: 'AuthorizationHeaderMalformed that names the region', response: s3Error(400, 'AuthorizationHeaderMalformed', "the region 'us-east-1' is wrong; expecting 'eu-1'"), run: list, code: 'wrong_region', retryable: false, status: 400, message: /expects region "eu-1"/, requests: 1 },
  { name: 'AuthorizationHeaderMalformed worded the Garage way', response: s3Error(400, 'AuthorizationHeaderMalformed', 'Authorization header malformed, unexpected scope: 20240101/us-east-1/s3/aws4_request'), run: list, code: 'wrong_region', retryable: false, status: 400, message: /Check the Region field/ },
  { name: 'InvalidBucketName', response: s3Error(400, 'InvalidBucketName', 'The specified bucket is not valid.'), run: upload, code: 'invalid_bucket_name', retryable: false, status: 400, message: /"bkt3" is not a valid bucket name/ },
  { name: 'RequestTimeTooSkewed', response: s3Error(403, 'RequestTimeTooSkewed', 'The difference between the request time and the current time is too large.'), run: list, code: 'clock_skew', retryable: false, status: 403, message: /15 minutes/ },
  { name: 'KeyTooLongError', response: s3Error(400, 'KeyTooLongError', 'Your key is too long'), run: upload, code: 'invalid_key', retryable: false, status: 400, message: /^Invalid file key provided: it is longer than the store allows/, requests: 1 },
  { name: 'XMinioInvalidObjectName', response: s3Error(400, 'XMinioInvalidObjectName', 'Object name contains unsupported characters.'), run: upload, code: 'invalid_key', retryable: false, status: 400, message: /^Invalid file key provided: Object name contains unsupported characters\.$/, requests: 1 },
  { name: 'MetadataTooLarge', response: s3Error(400, 'MetadataTooLarge', 'Your metadata headers exceed the maximum allowed metadata size.'), run: upload, code: 'metadata_too_large', retryable: false, status: 400 },
  { name: 'EntityTooLarge', response: s3Error(400, 'EntityTooLarge', 'Your proposed upload exceeds the maximum allowed size'), run: upload, code: 'object_too_large', retryable: false, status: 400 },
  { name: 'NotImplemented', response: s3Error(501, 'NotImplemented', 'A header you provided implies functionality that is not implemented'), run: upload, code: 'not_implemented', retryable: false, status: 501, message: /does not implement a feature/, requests: 1 },
  { name: 'BadDigest', response: s3Error(400, 'BadDigest', 'The Content-MD5 you specified did not match what we received.'), run: upload, code: 'integrity', retryable: false, status: 400, message: /proxy in front of it/ },
  { name: 'PermanentRedirect', response: s3Error(301, 'PermanentRedirect', 'The bucket you are attempting to access must be addressed using the specified endpoint.'), run: list, code: 'redirect', retryable: false, status: 301, message: /check the endpoint URL/ },
  { name: 'ExpiredToken', response: s3Error(400, 'ExpiredToken', 'The provided token has expired.'), run: list, code: 'invalid_session_token', retryable: false, status: 400, message: /session token/ },
  { name: 'SlowDown (the SDK retries once)', response: s3Error(503, 'SlowDown', 'Please reduce your request rate.'), run: upload, code: 'store_unavailable', retryable: true, status: 503, message: /overloaded or unavailable \(SlowDown\)/, requests: 2 },
  { name: 'InternalError', response: s3Error(500, 'InternalError', 'We encountered an internal error. Please try again.'), run: download, code: 'store_unavailable', retryable: true, status: 500, requests: 2 },
  { name: 'ServiceUnavailable', response: s3Error(503, 'ServiceUnavailable', 'Reduce your request rate.'), run: remove, code: 'store_unavailable', retryable: true, status: 503, requests: 2 },
  { name: 'RequestTimeout', response: s3Error(400, 'RequestTimeout', 'Your socket connection to the server was not read from or written to within the timeout period.'), run: upload, code: 'timeout', retryable: true, status: 400 },
  { name: 'a 429 from a gateway', response: s3Error(429, 'TooManyRequestsException', 'Too many requests'), run: list, code: 'rate_limited', retryable: true, status: 429 },
  { name: 'a 413 page from a reverse proxy', response: html(413, '<html><body>413 Request Entity Too Large</body></html>'), run: upload, code: 'payload_too_large', retryable: false, status: 413, message: /client_max_body_size/, requests: 1 },
  { name: 'an HTML page with status 200 (the wrong port)', response: html(200, '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Console</title></head><body><div id="root"></div></body></html>'), run: list, code: 'not_s3', retryable: false, status: 200, message: /answered HTTP 200 but not with an S3 response/, requests: 1 },
  { name: 'a 502 text page from a proxy', response: { status: 502, headers: { 'content-type': 'text/plain' }, body: 'Bad gateway' }, run: list, code: 'not_s3', retryable: true, status: 502, requests: 2 },
  { name: 'a JSON 405 from an API gateway', response: { status: 405, headers: { 'content-type': 'application/json' }, body: '{"message":"Method Not Allowed"}' }, run: list, code: 'not_s3', retryable: false, status: 405 },
  { name: 'the 400 page of a TLS port that was sent plain HTTP', response: html(400, '<html><head><title>400 The plain HTTP request was sent to HTTPS port</title></head><body></body></html>'), run: list, code: 'not_s3', retryable: false, status: 400, message: /whether the port expects https:\/\// },
  { name: 'a 307 without a body', response: { status: 307, headers: { location: 'https://elsewhere.example/' } }, run: list, code: 'redirect', retryable: false, status: 307, message: /use the final URL/ },
  { name: 'an HTML 404 on a listing', response: html(404, '<html><body>404 Page Missing</body></html>'), run: list, code: 'bucket_or_object_missing', retryable: false, status: 404, message: /Bucket "bkt3" or the object is missing \(HTTP 404\)/ },
  { name: 'an HTML 404 on a download is a missing object', response: html(404, '<html><body>404</body></html>'), run: download, code: 'object_missing', retryable: false, status: 404, message: /does not exist/ },
  { name: 'an HTML 403 from a proxy', response: html(403, '<html>Forbidden</html>'), run: list, code: 'access_denied', retryable: false, status: 403, message: /Access denied \(HTTP 403\)/ },
  { name: 'a refusal nothing recognises (400)', response: s3Error(400, 'InvalidArgument', 'Argument max-keys must be an integer between 0 and 2147483647'), run: list, code: 'unknown', retryable: false, status: 400, message: /Argument max-keys must be an integer/ },
  { name: 'a failure nothing recognises (500)', response: s3Error(500, 'WeirdFailure', 'Something broke'), run: list, code: 'store_unavailable', retryable: true, status: 500, requests: 2 },
];

describe('S3 errors from a store', () => {
  it.each(STORE_CASES)('$name', async ({ response, run, code, retryable, status, message, requests }) => {
    const server = await storeAnswering(response);
    const runtime = await runtimeOn(server.url);
    const error = await failureOf(() => run(runtime));

    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.statusCode).toBe(status);
    if (message) expect(error.message).toMatch(message);
    expectSafeMessage(error);
    expect(error.cause).toBeDefined();
    if (requests !== undefined) expect(server.requests.length).toBe(requests);
  });

  it('says the first upload creates the bucket when the provider is set to create one', async () => {
    const server = await storeAnswering(s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist'));
    const runtime = await runtimeOn(server.url, {}, true);
    const error = await failureOf(() => list(runtime));
    expect(error.code).toBe('bucket_missing');
    expect(error.message).toMatch(/With "Create bucket if missing" on, the first upload creates it/);
    expectSafeMessage(error);
  });

  it('names the CreateBucket permission when creating the bucket is what was refused', async () => {
    const server = await fakeStore({
      intercept: (request) => {
        if (request.method !== 'PUT') return undefined;
        return request.key
          ? s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist')
          : s3Error(403, 'AccessDenied', 'Access Denied.');
      },
    });
    const runtime = await runtimeOn(server.url, {}, true);
    const error = await failureOf(() => upload(runtime));
    expect(error.code).toBe('access_denied');
    expect(error.message).toMatch(/may not create bucket "bkt3" \(CreateBucket permission\)/);
    expectSafeMessage(error);
    // one upload, one CreateBucket: a refusal is neither retried nor followed by a second upload
    expect(server.requests.map((request) => `${request.method} ${request.key ? 'object' : 'bucket'}`)).toEqual(['PUT object', 'PUT bucket']);
  });

  it('reports a bucket name another account holds', async () => {
    const server = await fakeStore({
      intercept: (request) => {
        if (request.method !== 'PUT') return undefined;
        return request.key
          ? s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist')
          : s3Error(409, 'BucketAlreadyExists', 'The requested bucket name is not available.');
      },
    });
    const runtime = await runtimeOn(server.url, {}, true);
    const error = await failureOf(() => upload(runtime));
    expect(error.code).toBe('bucket_name_taken');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/Bucket name "bkt3" is already taken by another account/);
    expectSafeMessage(error);
  });

  it('keeps a store\'s own wording for a missing file out of every other message', async () => {
    const server = await storeAnswering(s3Error(404, 'NoSuchUpload', 'The specified multipart upload does not exist. The upload ID might be invalid, or Resource not found.'));
    const runtime = await runtimeOn(server.url);
    const error = await failureOf(() => list(runtime));
    expect(error.code).toBe('unknown');
    expect(error.message).toMatch(/multipart upload is missing/);
    expectSafeMessage(error);
  });

  it('shows no markup a store put into its message', async () => {
    const server = await storeAnswering(s3Error(400, 'InvalidRequest', 'bad <b>request</b> in <Error><Code>X</Code></Error> here'));
    const runtime = await runtimeOn(server.url);
    const error = await failureOf(() => list(runtime));
    expect(error.message).toBe('bad request in X here');
    expectSafeMessage(error);
  });

  it('masks the provider\'s keys if a store echoes them', async () => {
    const server = await storeAnswering(s3Error(400, 'InvalidRequest', `the key ${SECRET} and ${credentials.accessKeyId} are rejected`));
    const runtime = await runtimeOn(server.url);
    const error = await failureOf(() => list(runtime));
    expect(error.message).toBe('the key [redacted] and [redacted] are rejected');
    expectSafeMessage(error);
  });

  it('a HEAD for a missing object is "no such object" (null), any other HEAD failure is an error', async () => {
    const server = await fakeStore();
    const runtime = await runtimeOn(server.url);
    await expect(runtime.getFileMetadata('absent.txt')).resolves.toBeNull();

    const refusing = await storeAnswering(s3Error(403, 'AccessDenied', 'Access Denied.'));
    const denied = await runtimeOn(refusing.url);
    const error = await failureOf(() => denied.getFileMetadata('absent.txt'));
    expect(error.code).toBe('access_denied');
    expect(error.statusCode).toBe(403);
    // a HEAD answer has no body to say why, so the message names both causes instead of blaming the permission alone
    expect(error.message).toMatch(/gave no reason: the secret access key may be wrong, or the credentials may lack permission/);
    expectSafeMessage(error);
  });
});

describe('S3 errors from the network', () => {
  it('a refused connection says where to look, and may be retried', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const runtime = await runtimeOn(`http://127.0.0.1:${port}`);
    const error = await failureOf(() => list(runtime));
    expect(error.code).toBe('connection_refused');
    expect(error.retryable).toBe(true);
    expect(error.statusCode).toBeUndefined();
    expect(error.message).toContain(`Connection refused by 127.0.0.1:${port}`);
    expect(error.message).toMatch(/MinIO: 9000, not the 9001 console/);
    expect(error.message).toMatch(/"localhost" is the console's own container/);
    expectSafeMessage(error);
  });

  it('a connection the server drops is a reset, with the TLS hint for an http:// endpoint', async () => {
    const dropping = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => dropping.listen(0, '127.0.0.1', resolve));
    const { port } = dropping.address() as net.AddressInfo;
    try {
      const runtime = await runtimeOn(`http://127.0.0.1:${port}`);
      const error = await failureOf(() => list(runtime));
      expect(error.code).toBe('connection_reset');
      expect(error.retryable).toBe(true);
      expect(error.message).toMatch(/closed the connection unexpectedly\. If this port serves TLS, use https:\/\//);
      expectSafeMessage(error);
    } finally {
      await new Promise<void>((resolve) => dropping.close(() => resolve()));
    }
  });
});

describe('describeS3Error on Node-level and synthetic errors', () => {
  const ctx = { endpoint: 'https://minio.internal:9000', bucket: 'bkt3' };
  const withCode = (code: string, message = '') => Object.assign(new Error(message), { code });

  it.each([
    ['ETIMEDOUT', 'timeout', true],
    ['EHOSTUNREACH', 'timeout', true],
    ['ENETUNREACH', 'timeout', true],
    ['ECONNREFUSED', 'connection_refused', true],
    ['ECONNRESET', 'connection_reset', true],
    ['EPIPE', 'connection_reset', true],
    ['ENOTFOUND', 'dns_failure', true],
    ['EAI_AGAIN', 'dns_failure', true],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_untrusted', false],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'tls_untrusted', false],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_untrusted', false],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'tls_untrusted', false],
    ['UNABLE_TO_GET_ISSUER_CERT', 'tls_untrusted', false],
    ['CERT_UNTRUSTED', 'tls_untrusted', false],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_hostname', false],
    ['CERT_HAS_EXPIRED', 'tls_expired', false],
    ['CERT_NOT_YET_VALID', 'tls_expired', false],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls_protocol', false],
    ['ERR_INVALID_CHAR', 'invalid_header', false],
    ['ERR_INVALID_HTTP_TOKEN', 'invalid_header', false],
  ])('%s -> %s (retryable: %s)', (code, expectedCode, retryable) => {
    const mapped = describeS3Error(withCode(code), ctx);
    expect(mapped.code).toBe(expectedCode);
    expect(mapped.retryable).toBe(retryable);
    expectSafeMessage(mapped);
    expect(mapped.message).toMatch(/\S/);
  });

  it('a URIError (a value the SDK cannot put into a URL) is a refused request, not a store failure to retry', () => {
    const mapped = describeS3Error(new URIError('URI malformed'), ctx);
    expect(mapped).toMatchObject({ code: 'invalid_request', retryable: false });
    expect(mapped.message).toMatch(/cannot be sent in a URL/);
    expectSafeMessage(mapped);
  });

  it('tells a TLS port from a plain one, and a TLS handshake that failed for another reason', () => {
    expect(describeS3Error(withCode('EPROTO', 'write EPROTO error:0A00010B:SSL routines::wrong version number'), ctx).code).toBe('tls_protocol');
    expect(describeS3Error(withCode('EPROTO', 'write EPROTO error:0A0000C6:SSL routines:tls_get_more_records:packet length too long'), ctx).code).toBe('tls_protocol');
    const handshake = describeS3Error(withCode('EPROTO', 'write EPROTO error:0A000410:SSL routines::sslv3 alert handshake failure'), ctx);
    expect(handshake.code).toBe('tls_handshake');
    expect(handshake.retryable).toBe(false);
  });

  it('points at the CA certificate field for an untrusted certificate, and at the host name for a mismatch', () => {
    expect(describeS3Error(withCode('DEPTH_ZERO_SELF_SIGNED_CERT'), ctx).message).toMatch(/"CA certificate" \(recommended\).*"Skip TLS verification"/);
    expect(describeS3Error(withCode('ERR_TLS_CERT_ALTNAME_INVALID'), ctx).message).toMatch(/not valid for the host name used in the endpoint/);
  });

  it('finds the code behind a cause and inside an AggregateError with an empty message', () => {
    const wrapped = new Error('request failed', { cause: withCode('ECONNREFUSED') });
    expect(describeS3Error(wrapped, ctx).code).toBe('connection_refused');
    const aggregate = Object.assign(new AggregateError([withCode('ECONNREFUSED'), withCode('ECONNREFUSED')]), { message: '' });
    expect(describeS3Error(aggregate, ctx).code).toBe('connection_refused');
    expect(describeS3Error(new Error('deep', { cause: new Error('deeper', { cause: withCode('ENOTFOUND') }) }), ctx).code).toBe('dns_failure');
  });

  it('adds the TLS hint only for an http:// endpoint', () => {
    expect(describeS3Error(withCode('ECONNRESET'), { ...ctx, endpoint: 'http://minio.internal:9000' }).message).toMatch(/use https:\/\//);
    expect(describeS3Error(withCode('ECONNRESET'), ctx).message).not.toMatch(/use https:\/\//);
  });

  it('names the bucket sub-domain when that is what failed to resolve', () => {
    const endpoint = 'http://minio.example:9000';
    const subdomain = Object.assign(new Error('getaddrinfo ENOTFOUND bkt3.minio.example'), { code: 'ENOTFOUND', hostname: 'bkt3.minio.example' });
    expect(describeS3Error(subdomain, { endpoint, bucket: 'bkt3' }).message)
      .toMatch(/host name bkt3\.minio\.example cannot be resolved.*turn on "Use path-style addressing"/);

    const plain = Object.assign(new Error('getaddrinfo ENOTFOUND minio.example'), { code: 'ENOTFOUND', hostname: 'minio.example' });
    expect(describeS3Error(plain, { endpoint, bucket: 'bkt3' }).message).toBe('The host name of minio.example:9000 cannot be resolved. Check the endpoint spelling and DNS.');

    // Amazon S3 has no endpoint to correct and no path-style switch to advise
    expect(describeS3Error(subdomain, { bucket: 'bkt3' }).message).toBe('The host name of Amazon S3 cannot be resolved. Check the DNS and network access of this server.');
  });

  it('passes a refusal of the network policy through, retryable only for a resolver outage', () => {
    const refused = describeS3Error(new OutboundNetworkError('Refusing outbound request to private/loopback host: x'), ctx);
    expect(refused).toMatchObject({ code: 'endpoint_not_allowed', retryable: false, message: 'Refusing outbound request to private/loopback host: x' });
    const dns = describeS3Error(new OutboundDnsError('Could not resolve host: x'), ctx);
    expect(dns).toMatchObject({ code: 'endpoint_not_allowed', retryable: true });
    expect(describeS3Error(new ProviderEndpointError('endpoint', 'private'), ctx)).toMatchObject({ code: 'endpoint_not_allowed', retryable: false });
    expect(describeS3Error(new ProviderSettingsError('bucket', 'Bucket name is required.'), ctx)).toMatchObject({ code: 'invalid_settings', retryable: false });
  });

  it('maps the SDK\'s own timeout and abort errors', () => {
    expect(describeS3Error(Object.assign(new Error('Connection timed out after 10000 ms'), { name: 'TimeoutError' }), ctx)).toMatchObject({ code: 'timeout', retryable: true });
    expect(describeS3Error(Object.assign(new Error('Request aborted'), { name: 'AbortError' }), ctx)).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('describes Amazon S3 without an endpoint by name', () => {
    const missing = Object.assign(new Error('x'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
    expect(describeS3Error(missing, { bucket: 'bkt3' }).message).toBe('Bucket "bkt3" is missing on Amazon S3. Check the bucket name and the region, or create the bucket.');
    expect(describeS3Error(withCode('ECONNREFUSED'), { bucket: 'bkt3' }).message).toBe('Connection refused by Amazon S3. Check the network access of this server (proxy, firewall).');
  });

  it('survives values that are not errors', () => {
    for (const value of [undefined, null, 'text', 42, {}, { message: 5 }]) {
      const mapped = describeS3Error(value, ctx);
      expect(mapped.code).toBe('unknown');
      expect(mapped.retryable).toBe(true);
      expect(mapped.message).toBe('The storage request failed.');
    }
  });

  it('keeps a message with a long bucket and host within the limit', () => {
    const longCtx = { endpoint: `https://${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example.com:9000`, bucket: 'x'.repeat(63) };
    const missing = Object.assign(new Error(), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
    const mapped = describeS3Error(missing, longCtx);
    expect(mapped.message).toHaveLength(S3_ERROR_MESSAGE_MAX_CHARS);
    expect(mapped.message.endsWith('…')).toBe(true);
    expect(new S3OperationError(mapped).message).toBe(mapped.message);
  });
});

describe('S3OperationError', () => {
  it('carries the verdict, keeps its cause and is recognised even as a copy from another module instance', () => {
    const cause = new Error('boom');
    const error = new S3OperationError({ code: 'access_denied', message: 'Access denied.', statusCode: 403, retryable: false }, cause);
    expect(error).toMatchObject({ name: 'S3OperationError', code: 'access_denied', statusCode: 403, retryable: false, message: 'Access denied.' });
    expect(error.cause).toBe(cause);
    expect(isS3OperationError(error)).toBe(true);

    const lookAlike = Object.assign(new Error('x'), { name: 'S3OperationError', code: 'timeout', retryable: true });
    expect(isS3OperationError(lookAlike)).toBe(true);
    for (const other of [new Error('x'), Object.assign(new Error('x'), { name: 'S3OperationError' }), { name: 'S3OperationError', code: 'x', retryable: true }, null, 'S3OperationError']) {
      expect(isS3OperationError(other)).toBe(false);
    }
  });

  it('rewrites the wording the file routes read as "no such file" unless it is the missing-object message', () => {
    expect(new S3OperationError({ code: 'object_missing', message: 'The object does not exist.', retryable: false }).message).toBe('The object does not exist.');
    expect(new S3OperationError({ code: 'unknown', message: 'Resource not found and it does not exist', retryable: false }).message).toBe('Resource missing and it is missing');
  });

  it('invalidKeyError uses the text of the other drivers and a verdict that stops retries and breaker counts', () => {
    const plain = invalidKeyError();
    expect(plain).toMatchObject({ name: 'S3OperationError', code: 'invalid_key', statusCode: 400, retryable: false, message: 'Invalid file key provided.' });
    expect(invalidKeyError('too long').message).toBe('Invalid file key provided: too long');
    expect(isS3OperationError(plain)).toBe(true);
  });

  it('cuts a message that is too long', () => {
    const error = new S3OperationError({ code: 'unknown', message: 'x'.repeat(1000), retryable: true });
    expect(error.message).toHaveLength(S3_ERROR_MESSAGE_MAX_CHARS);
    expect(error.message.endsWith('…')).toBe(true);
  });
});
