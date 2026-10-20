/**
 * Unit tests - how a failed file call is answered (server/api/fileHttp.ts), for the Document Store routes and
 * the client Files API alike: the status, the stable `code`, and a message that is safe to show.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { CircuitOpenError, RequestTimeoutError } from '@/lib/core/resilience';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { AzureBlobError } from '@/lib/providers/contracts/azure/blobErrors';
import { S3OperationError } from '@/lib/providers/contracts/s3/s3Errors';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';
import { FileServiceError, bucketInactiveError } from '@/lib/services/files/errors';
import {
  GENERIC_STORAGE_MESSAGE,
  STORAGE_TIMEOUT_MESSAGE,
  STORAGE_UNAVAILABLE_MESSAGE,
  describeFileError,
  sendFileError,
  setFileDownloadHeaders,
  uploadRouteErrorHandler,
} from '@/server/api/fileHttp';

function fakeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    code: vi.fn((status: number) => { reply.statusCode = status; return reply; }),
    send: vi.fn((body: unknown) => { reply.body = body; return reply; }),
    header: vi.fn((name: string, value: string) => { reply.headers[name] = value; return reply; }),
  };
  return reply;
}

function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

const errorWith = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

describe('a refusal of the file service', () => {
  it.each([
    [new FileServiceError('bucket_not_found', 404, 'File bucket not found.'), 404, 'bucket_not_found', 'Bucket not found'],
    [new FileServiceError('file_not_found', 404, 'File record not found.'), 404, 'file_not_found', 'File not found'],
    [bucketInactiveError(), 409, 'bucket_inactive', 'File bucket is not active.'],
    [new FileServiceError('provider_inactive', 409, 'File provider is not active.'), 409, 'provider_inactive', 'File provider is not active.'],
    [new FileServiceError('duplicate_key', 409, 'Bucket with key "docs" already exists.'), 409, 'duplicate_key', 'Bucket with key "docs" already exists.'],
    [new FileServiceError('bucket_not_empty', 409, 'Bucket contains files. Remove files or use force delete.'), 409, 'bucket_not_empty', 'Bucket contains files. Remove files or use force delete.'],
    [new FileServiceError('markdown_unavailable', 409, 'Markdown conversion not available for this file.'), 409, 'markdown_unavailable', 'Markdown conversion not available for this file.'],
    [new FileServiceError('file_too_large', 413, 'File exceeds maximum allowed size of 50 MB (got 51 MB).'), 413, 'file_too_large', 'File exceeds maximum allowed size of 50 MB (got 51 MB).'],
    [new FileServiceError('content_type_not_allowed', 415, 'Content type "image/gif" is not in the FILE_UPLOAD_ALLOWED_MIME_TYPES allowlist.'), 415, 'content_type_not_allowed', 'Content type "image/gif" is not in the FILE_UPLOAD_ALLOWED_MIME_TYPES allowlist.'],
    [new FileServiceError('invalid_content_type', 400, 'Invalid content-type header for upload.'), 400, 'invalid_content_type', 'Invalid content-type header for upload.'],
    [new FileServiceError('provider_mismatch', 400, 'Bucket is not associated with the provided provider key.'), 400, 'provider_mismatch', 'Bucket is not associated with the provided provider key.'],
    [new FileServiceError('invalid_request', 400, 'prefix is not valid.'), 400, 'invalid_request', 'prefix is not valid.'],
  ])('%#: answers its own status, code and message', (error, status, code, message) => {
    expect(describeFileError(error)).toEqual({ status, body: { error: message, code }, unexpected: false });
  });

  it('carries the extra fields of a refusal into the body (a preview refusal says why)', () => {
    const refusal = new FileServiceError('preview_unsupported', 415, 'This file type cannot be previewed. Download it instead.', { details: { reason: 'unsupported_type' } });
    expect(describeFileError(refusal).body).toEqual({
      error: 'This file type cannot be previewed. Download it instead.',
      code: 'preview_unsupported',
      reason: 'unsupported_type',
    });
  });

  it('is recognised by its shape too (a second copy of the module)', () => {
    const twin = Object.assign(new Error('File bucket is not active.'), { name: 'FileServiceError', code: 'bucket_inactive', status: 409 });
    expect(describeFileError(twin)).toMatchObject({ status: 409, body: { code: 'bucket_inactive' } });
  });

  it('is never logged as an incident', () => {
    const reply = fakeReply();
    const logger = fakeLogger();
    sendFileError(reply as unknown as FastifyReply, bucketInactiveError(), { logger: logger as never, action: 'upload' });
    expect(reply.statusCode).toBe(409);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('the messages the service used to throw as plain errors', () => {
  it.each([
    ['File bucket not found.', 404, 'bucket_not_found'],
    ['File record not found.', 404, 'file_not_found'],
    ['File bucket is not active.', 409, 'bucket_inactive'],
    ['File provider is not active.', 409, 'provider_inactive'],
    ['Markdown conversion not available for this file.', 409, 'markdown_unavailable'],
    ['Bucket contains files. Remove files or use force delete.', 409, 'bucket_not_empty'],
  ])('%s is still a %i %s', (message, status, code) => {
    expect(describeFileError(new Error(message))).toMatchObject({ status, body: { code }, unexpected: false });
  });
});

describe('a missing object', () => {
  it.each([
    ['an S3 object that is missing', new S3OperationError({ code: 'object_missing', message: 'The file "a.txt" was not found in the bucket.', statusCode: 404, retryable: false })],
    ['an Azure blob that is missing', new AzureBlobError('The blob is missing.', { statusCode: 404, code: 'BlobNotFound' })],
    ['a raw S3 SDK error', errorWith('The specified key does not exist.', { code: 'NoSuchKey' })],
    ['a raw S3 SDK error that only carries the code', errorWith('Request failed.', { code: 'NoSuchKey' })],
    ['a file the local disk does not have (ENOENT)', errorWith("ENOENT: no such file or directory, open '/srv/data/files/t1/disk/docs/a.txt'", { code: 'ENOENT' })],
    ['a GridFS file', errorWith('File not found: docs/a.txt', { statusCode: 404 })],
    ['a driver that only says so in words', new Error('Object docs/a.txt not found')],
    ['a driver that says "does not exist"', new Error('The object does not exist')],
  ])('%s is a 404 "File not found"', (_label, error) => {
    expect(describeFileError(error, { storage: true })).toEqual({ status: 404, body: { error: 'File not found', code: 'file_not_found' }, unexpected: false });
  });

  it('never repeats a server path from the driver error', () => {
    const answer = describeFileError(errorWith("ENOENT: no such file or directory, open '/srv/data/files/t1/disk/docs/a.txt'", { code: 'ENOENT' }), { storage: true });
    expect(JSON.stringify(answer.body)).not.toContain('/srv');
  });

  it('is not claimed by an S3 bucket error: the drivers keep "not found" for objects only', () => {
    const missingBucket = new S3OperationError({ code: 'bucket_missing', message: 'The bucket "b" was not found.', statusCode: 404, retryable: false });
    expect(describeFileError(missingBucket, { storage: true })).toMatchObject({ status: 502, body: { code: 'storage_failure' } });
  });
});

describe('a storage provider that cannot serve', () => {
  it('answers 503 for an open circuit breaker, without the breaker key (it names the tenant and provider)', () => {
    const answer = describeFileError(new CircuitOpenError('file-upload:tenant-1:s3-main'), { storage: true });
    expect(answer).toEqual({ status: 503, body: { error: STORAGE_UNAVAILABLE_MESSAGE, code: 'storage_unavailable' }, unexpected: false });
    expect(JSON.stringify(answer.body)).not.toContain('tenant-1');
    expect(JSON.stringify(answer.body)).not.toContain('s3-main');
  });

  it('answers 503 for a breaker error that lost its class (a second copy of the module)', () => {
    const twin = Object.assign(new Error('Circuit breaker is open for "k" - request rejected'), { name: 'CircuitOpenError' });
    expect(describeFileError(twin, { storage: true }).status).toBe(503);
  });

  it('answers 504 for a call that timed out, without the key', () => {
    const answer = describeFileError(new RequestTimeoutError('file-download:tenant-1:s3-main', 30_000), { storage: true });
    expect(answer).toEqual({ status: 504, body: { error: STORAGE_TIMEOUT_MESSAGE, code: 'storage_timeout' }, unexpected: false });
    expect(JSON.stringify(answer.body)).not.toContain('tenant-1');
  });

  it('logs an outage as a warning, not as an incident', () => {
    const reply = fakeReply();
    const logger = fakeLogger();
    sendFileError(reply as unknown as FastifyReply, new CircuitOpenError('k'), { logger: logger as never, action: 'upload', storage: true });
    expect(reply.statusCode).toBe(503);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('a failure the driver has put into words', () => {
  it('shows the message of an S3 error', () => {
    const error = new S3OperationError({ code: 'access_denied', message: 'The access key is not allowed to write to bucket "files".', statusCode: 403, retryable: false });
    expect(describeFileError(error, { storage: true })).toEqual({
      status: 502,
      body: { error: 'The access key is not allowed to write to bucket "files".', code: 'storage_failure' },
      unexpected: false,
    });
  });

  it('shows the message of an Azure error', () => {
    const error = new AzureBlobError('The container "files" is missing in storage account "acct". Create it or enable "Create container if missing".', { statusCode: 404, code: 'ContainerNotFound' });
    expect(describeFileError(error, { storage: true })).toMatchObject({
      status: 502,
      body: { error: error.message, code: 'storage_failure' },
      unexpected: false,
    });
  });

  it('shows a provider setting the console refuses, with the form field', () => {
    const answer = describeFileError(new ProviderSettingsError('endpoint', 'Endpoint must start with http:// or https://.'), { storage: true });
    expect(answer).toEqual({
      status: 502,
      body: { error: 'Endpoint must start with http:// or https://.', code: 'storage_failure', field: 'endpoint' },
      unexpected: false,
    });
  });

  it('shows an endpoint the outbound guard refuses, with the form field', () => {
    const answer = describeFileError(new ProviderEndpointError('endpoint', 'private addresses are not allowed'), { storage: true });
    expect(answer).toMatchObject({ status: 502, body: { code: 'storage_failure', field: 'endpoint' }, unexpected: false });
    expect(answer.body.error).toContain('private addresses are not allowed');
  });
});

describe('anything nobody recognises', () => {
  const sdkError = errorWith(
    'connect ECONNREFUSED 10.1.2.3:9000 while calling https://minio.internal:9000/files/t1/s3-main/docs/a.txt?X-Amz-Signature=abc123',
    { code: 'ECONNREFUSED', stack: 'Error: connect ECONNREFUSED\n    at /srv/app/node_modules/sdk/index.js:1:1' },
  );

  it('is a 502 with a generic sentence when it came from the storage provider', () => {
    const answer = describeFileError(sdkError, { storage: true });
    expect(answer).toEqual({ status: 502, body: { error: GENERIC_STORAGE_MESSAGE, code: 'storage_failure' }, unexpected: true });
    expect(GENERIC_STORAGE_MESSAGE).toBe('The storage provider request failed.');
  });

  it('keeps every detail of the error out of the response', () => {
    const text = JSON.stringify(describeFileError(sdkError, { storage: true }).body);
    for (const leaked of ['ECONNREFUSED', '10.1.2.3', 'minio.internal', 'X-Amz-Signature', 'abc123', '/srv/app']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('is logged in full (the details go to the log, not to the caller)', () => {
    const reply = fakeReply();
    const logger = fakeLogger();
    sendFileError(reply as unknown as FastifyReply, sdkError, { logger: logger as never, action: 'upload', storage: true });
    expect(reply.statusCode).toBe(502);
    expect(reply.body).toEqual({ error: GENERIC_STORAGE_MESSAGE, code: 'storage_failure' });
    expect(logger.error).toHaveBeenCalledWith('File upload failed', { error: sdkError });
  });

  it('is a plain 500 when the call never reached the provider (listing the database, say)', () => {
    expect(describeFileError(new Error('SQLITE_BUSY: database is locked'))).toEqual({
      status: 500,
      body: { error: 'Internal server error', code: 'internal_error' },
      unexpected: true,
    });
  });

  it('does not take a thrown string or object for anything it knows', () => {
    expect(describeFileError('boom', { storage: true })).toMatchObject({ status: 502, unexpected: true });
    expect(describeFileError(undefined)).toMatchObject({ status: 500, unexpected: true });
    expect(describeFileError({ message: 'File bucket not found.' })).toMatchObject({ status: 500 });
  });
});

describe('a request body that is not JSON', () => {
  it('is a 400 on the routes that read a body', () => {
    expect(describeFileError(new SyntaxError('Unexpected token } in JSON at position 4'), { body: true })).toEqual({
      status: 400,
      body: { error: 'The request body must be valid JSON.', code: 'invalid_request' },
      unexpected: false,
    });
  });

  it('is not guessed at on a route that reads none', () => {
    expect(describeFileError(new SyntaxError('Unexpected token'), {}).status).toBe(500);
  });
});

describe('setFileDownloadHeaders', () => {
  it('sets the disposition and tells the browser to trust the declared type', () => {
    const reply = fakeReply();
    setFileDownloadHeaders(reply as unknown as FastifyReply, 'Çalışma.pdf', 'attachment');
    expect(reply.headers['Content-Disposition']).toBe(`attachment; filename="Cal_sma.pdf"; filename*=UTF-8''%C3%87al%C4%B1%C5%9Fma.pdf`);
    expect(reply.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('serves inline when asked to', () => {
    const reply = fakeReply();
    setFileDownloadHeaders(reply as unknown as FastifyReply, 'a.png', 'inline');
    expect(reply.headers['Content-Disposition']).toBe(`inline; filename="a.png"; filename*=UTF-8''a.png`);
  });

  it('is an attachment by default', () => {
    const reply = fakeReply();
    setFileDownloadHeaders(reply as unknown as FastifyReply, 'a.png');
    expect(reply.headers['Content-Disposition']).toMatch(/^attachment;/);
  });
});

describe('uploadRouteErrorHandler', () => {
  const request = {} as FastifyRequest;
  const tooLarge = (over: Partial<FastifyError> = {}) => Object.assign(new Error('Request body is too large'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413, ...over }) as FastifyError;

  it('answers a body over the route limit as a file that is too large', () => {
    const reply = fakeReply();
    uploadRouteErrorHandler(tooLarge(), request, reply as unknown as FastifyReply);
    expect(reply.statusCode).toBe(413);
    expect(reply.body).toEqual({ error: expect.stringMatching(/^File is larger than the \d+ MB upload limit\.$/), code: 'file_too_large' });
  });

  it('answers any 413 that way', () => {
    const reply = fakeReply();
    uploadRouteErrorHandler(tooLarge({ code: 'SOMETHING_ELSE' }), request, reply as unknown as FastifyReply);
    expect(reply.statusCode).toBe(413);
  });

  it('hands every other error on to the server untouched', () => {
    const reply = fakeReply();
    const other = Object.assign(new Error('Unsupported Media Type'), { code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 }) as FastifyError;
    expect(() => uploadRouteErrorHandler(other, request, reply as unknown as FastifyReply)).toThrow(other);
    expect(reply.send).not.toHaveBeenCalled();
  });
});
