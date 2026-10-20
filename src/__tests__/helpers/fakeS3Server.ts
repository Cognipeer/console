/**
 * A small in-process S3 server for tests that drive the real AWS SDK: path-style addressing, no signature check,
 * http or https, listening on an ephemeral port of 127.0.0.1 (never a fixed port).
 *
 * It keeps the objects of the buckets it was given, answers the calls the S3 drivers make (PutObject, GetObject,
 * HeadObject, DeleteObject, ListObjectsV2, CreateBucket) with the XML and headers real stores use, and records every
 * request it receives. The switches reproduce what real deployments do to a client: a store without flexible
 * checksums, a server that rejects raw non-ASCII header bytes, a proxy that never answers `Expect: 100-continue` or
 * limits the body size, a web console that answers 200 to everything, transient failures.
 */
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';

export interface FakeS3Options {
  buckets?: string[];
  /** Other access key ids get `InvalidAccessKeyId`. */
  accessKeyId?: string;
  /** Requests signed for another region get `AuthorizationHeaderMalformed` ("expecting '<region>'"). */
  region?: string;
  tls?: { key: string | Buffer; cert: string | Buffer };
  /** Never answer `Expect: 100-continue`; the body arrives when the client stops waiting for it. */
  neverContinue?: boolean;
  /** A Go-style server: bytes >= 0x80 in an `x-amz-meta-*` header fail the signature check. */
  rejectRawNonAscii?: boolean;
  /** A store without flexible checksums: any `x-amz-checksum-*` / `x-amz-sdk-checksum-algorithm` header gets 501. */
  rejectChecksumHeaders?: boolean;
  /** A reverse proxy body limit: a larger body gets an HTML 413. */
  maxBodyBytes?: number;
  /** Answer every request with an HTML page (the wrong port: a web console). */
  htmlRoot?: boolean;
  /** Answer every request 200 with an empty body. */
  emptyOk?: boolean;
  /** Transient failures before the server starts behaving. */
  failFirst?: { status: number; code: string; times: number; message?: string };
  /** Answer a request yourself; return `undefined` to let the server handle it. */
  intercept?: (request: RecordedRequest) => FakeS3Response | undefined;
  /** Send object bodies without a Content-Length (chunked), like a streaming gateway. */
  noContentLength?: boolean;
  /** A store that ignores `encoding-type=url` on a listing and answers with plain keys (and no `EncodingType` element). */
  ignoreEncodingType?: boolean;
}

export interface FakeS3Response {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export interface StoredObject {
  body: Buffer;
  contentType?: string;
  meta: Record<string, string>;
  etag: string;
  lastModified: Date;
}

export interface RecordedRequest {
  method: string;
  /** The raw request target (path and query). */
  url: string;
  bucket: string;
  key: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  /** Length of the request body that arrived. */
  bytes: number;
}

export interface FakeS3 {
  /** `http(s)://127.0.0.1:<port>` */
  url: string;
  /** `http(s)://localhost:<port>`: the same server reached through a host name. */
  localhostUrl: string;
  port: number;
  requests: RecordedRequest[];
  /** Keyed `<bucket>/<key>`. */
  objects: Map<string, StoredObject>;
  buckets: Set<string>;
  /** Puts an object in directly, as another tool would have. */
  seed(bucket: string, key: string, body: Buffer | string, options?: { contentType?: string; meta?: Record<string, string> }): void;
  openSockets(): number;
  close(): Promise<void>;
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The body of an S3 error response. */
export function s3ErrorXml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${escapeXml(message)}</Message><RequestId>fake</RequestId></Error>`;
}

/** An S3 error answer for `intercept`. */
export function s3Error(status: number, code: string, message = code): FakeS3Response {
  return { status, body: s3ErrorXml(code, message), headers: { 'content-type': 'application/xml' } };
}

export async function startFakeS3(options: FakeS3Options = {}): Promise<FakeS3> {
  const buckets = new Set(options.buckets ?? []);
  const objects = new Map<string, StoredObject>();
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let failuresLeft = options.failFirst?.times ?? 0;

  const etagOf = (body: Buffer) => `"${createHash('md5').update(body).digest('hex')}"`;

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const url = new URL(req.url ?? '/', 'http://fake');
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const bucket = parts[0] ?? '';
    const key = parts.slice(1).join('/');
    const recorded: RecordedRequest = {
      method: req.method ?? '',
      url: req.url ?? '',
      bucket,
      key,
      query: url.searchParams,
      headers: req.headers,
      bytes: body.length,
    };
    requests.push(recorded);

    const send = (status: number, payload: string | Buffer = '', headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/xml', ...headers });
      res.end(req.method === 'HEAD' ? undefined : payload);
    };
    const sendResponse = (response: FakeS3Response) => send(response.status, response.body ?? '', response.headers);
    const error = (status: number, code: string, message: string) => send(status, s3ErrorXml(code, message));

    const intercepted = options.intercept?.(recorded);
    if (intercepted) return sendResponse(intercepted);

    if (options.htmlRoot) return send(200, '<!doctype html><html><body>console</body></html>', { 'content-type': 'text/html' });
    if (options.emptyOk) {
      res.writeHead(200);
      return res.end();
    }
    if (options.maxBodyBytes !== undefined && body.length > options.maxBodyBytes) {
      return send(413, '<html><body>413 Request Entity Too Large</body></html>', { 'content-type': 'text/html' });
    }
    if (failuresLeft > 0 && options.failFirst) {
      failuresLeft -= 1;
      return error(options.failFirst.status, options.failFirst.code, options.failFirst.message ?? 'transient');
    }

    const scope = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request/.exec(String(req.headers.authorization ?? ''));
    if (options.accessKeyId && scope && scope[1] !== options.accessKeyId) {
      return error(403, 'InvalidAccessKeyId', 'The Access Key Id you provided does not exist in our records.');
    }
    if (options.region && scope && scope[3] !== options.region) {
      return error(400, 'AuthorizationHeaderMalformed', `the region '${scope[3]}' is wrong; expecting '${options.region}'`);
    }
    for (const [name, value] of Object.entries(req.headers)) {
      if (options.rejectRawNonAscii && name.startsWith('x-amz-meta-') && /[\x80-\xff]/.test(String(value))) {
        return error(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.');
      }
    }
    if (options.rejectChecksumHeaders && Object.keys(req.headers).some((name) => name.startsWith('x-amz-checksum-') || name === 'x-amz-sdk-checksum-algorithm')) {
      return error(501, 'NotImplemented', 'A header you provided implies functionality that is not implemented');
    }

    if (!key) {
      if (req.method === 'PUT') {
        if (buckets.has(bucket)) {
          return error(409, 'BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.');
        }
        buckets.add(bucket);
        return send(200, '', { location: `/${bucket}` });
      }
      if (!buckets.has(bucket)) return error(404, 'NoSuchBucket', 'The specified bucket does not exist');
      if (req.method === 'HEAD') return send(200);
      if (req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const max = Number(url.searchParams.get('max-keys') ?? 1000);
        const token = Number(url.searchParams.get('continuation-token') ?? 0) || 0;
        const encode = !options.ignoreEncodingType && url.searchParams.get('encoding-type') === 'url';
        const all = [...objects.entries()]
          .filter(([storageKey]) => storageKey.startsWith(`${bucket}/`) && storageKey.slice(bucket.length + 1).startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const page = all.slice(token, token + max);
        const truncated = token + max < all.length;
        const text = (value: string) => (encode ? encodeURIComponent(value).replace(/%2F/g, '/') : escapeXml(value));
        const contents = page
          .map(([storageKey, object]) => `<Contents><Key>${text(storageKey.slice(bucket.length + 1))}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>${object.etag}</ETag><Size>${object.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`)
          .join('');
        return send(
          200,
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${text(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys>${encode ? '<EncodingType>url</EncodingType>' : ''}<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${token + max}</NextContinuationToken>` : ''}${contents}</ListBucketResult>`,
        );
      }
      return error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.');
    }

    if (!buckets.has(bucket)) return error(404, 'NoSuchBucket', 'The specified bucket does not exist');
    const storageKey = `${bucket}/${key}`;
    if (req.method === 'PUT') {
      const meta: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (name.startsWith('x-amz-meta-')) meta[name.slice('x-amz-meta-'.length)] = String(value);
      }
      const etag = etagOf(body);
      objects.set(storageKey, { body, contentType: req.headers['content-type'], meta, etag, lastModified: new Date() });
      return send(200, '', { etag });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const object = objects.get(storageKey);
      if (!object) {
        // a HEAD has no body to carry the code: that is what makes the SDK name it `NotFound`
        return error(404, 'NoSuchKey', 'The specified key does not exist.');
      }
      const headers: Record<string, string> = {
        'content-type': object.contentType ?? 'binary/octet-stream',
        etag: object.etag,
        'last-modified': object.lastModified.toUTCString(),
      };
      if (!options.noContentLength || req.method === 'HEAD') headers['content-length'] = String(object.body.length);
      for (const [name, value] of Object.entries(object.meta)) headers[`x-amz-meta-${name}`] = value;
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : object.body);
    }
    if (req.method === 'DELETE') {
      objects.delete(storageKey);
      return send(204);
    }
    return error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.');
  };

  const server = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
  // "never answers 100-continue": take the request WITHOUT res.writeContinue(); the body arrives when the client gives up waiting
  if (options.neverContinue) server.on('checkContinue', (req, res) => { void handler(req, res); });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // the TLS handshake of a client that distrusts the certificate ends in an error event the test already sees on its side
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const scheme = options.tls ? 'https' : 'http';

  return {
    url: `${scheme}://127.0.0.1:${port}`,
    localhostUrl: `${scheme}://localhost:${port}`,
    port,
    requests,
    objects,
    buckets,
    seed(bucket, key, body, seedOptions = {}) {
      const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
      objects.set(`${bucket}/${key}`, {
        body: data,
        contentType: seedOptions.contentType,
        meta: seedOptions.meta ?? {},
        etag: etagOf(data),
        lastModified: new Date(),
      });
    },
    openSockets: () => sockets.size,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
