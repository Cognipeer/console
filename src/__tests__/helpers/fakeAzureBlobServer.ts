/**
 * A small HTTP stand-in for the Blob service, for tests that run the real @azure/storage-blob SDK.
 *
 * It speaks the path-style layout emulators use (`/<account>/<container>/<blob>`) and implements what the Azure
 * file provider calls: create container, put / get / head / delete blob (with `x-ms-meta-*` headers and the
 * blob content type) and list blobs (paged, with metadata). Every request is recorded for assertions. It is not
 * Azure: it does not check signatures (tests do that on the recorded requests) and it answers errors in the
 * shape the service uses (`x-ms-error-code` header, XML body except for HEAD).
 */
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';

export interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface StoredBlob {
  data: Buffer;
  contentType: string;
  metadata: Record<string, string>;
  etag: string;
  lastModified: Date;
}

export interface BlobServerOptions {
  /** The account segment of the path-style URLs. */
  account: string;
  /** Serve https with this key pair. */
  tls?: { key: string | Buffer; cert: string | Buffer };
  /** Rejects a request before it is routed: return the answer to give instead. */
  authorize?: (request: SeenRequest) => { status: number; code: string; headers?: Record<string, string> } | undefined;
  /** Takes over the answer to a request when it returns true. */
  override?: (request: SeenRequest, response: http.ServerResponse) => boolean;
  /**
   * Cuts the connection in the middle of the body of the first `times` blob downloads, after `afterBytes` bytes of it
   * (what a dropped connection looks like to the client). `onDrop` runs just before each cut.
   */
  dropDownloads?: { afterBytes: number; times: number; onDrop?: () => void };
}

export interface BlobServer {
  port: number;
  /** `http(s)://127.0.0.1:<port>/<account>`: what the provider's endpoint setting holds. */
  endpoint: string;
  seen: SeenRequest[];
  containers: Map<string, Map<string, StoredBlob>>;
  close(): Promise<void>;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function errorBody(code: string, message: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${escapeXml(message)}\nRequestId:${randomUUID()}\nTime:${new Date().toISOString()}</Message></Error>`;
}

function sendError(request: SeenRequest, response: http.ServerResponse, status: number, code: string, message: string, extra: Record<string, string> = {}): void {
  const headers = { 'x-ms-error-code': code, 'x-ms-request-id': randomUUID(), ...extra };
  if (request.method === 'HEAD') {
    response.writeHead(status, headers);
    response.end();
    return;
  }
  response.writeHead(status, { ...headers, 'content-type': 'application/xml' });
  response.end(errorBody(code, message));
}

function blobHeaders(blob: StoredBlob): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': blob.contentType,
    etag: blob.etag,
    'last-modified': blob.lastModified.toUTCString(),
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-request-id': randomUUID(),
  };
  for (const [name, value] of Object.entries(blob.metadata)) headers[`x-ms-meta-${name}`] = value;
  return headers;
}

export async function startBlobServer(options: BlobServerOptions): Promise<BlobServer> {
  const seen: SeenRequest[] = [];
  const containers = new Map<string, Map<string, StoredBlob>>();
  const sockets = new Set<Socket>();
  let sequence = 0;
  let dropsLeft = options.dropDownloads?.times ?? 0;

  function route(request: SeenRequest, response: http.ServerResponse): void {
    const url = new URL(request.url, 'http://x');
    const [account, container, ...rest] = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    if (account !== options.account) return sendError(request, response, 404, 'ResourceNotFound', 'The specified resource does not exist.');
    if (!container) return sendError(request, response, 400, 'InvalidUri', 'The requested URI does not represent any resource on the server.');

    if (rest.length === 0) {
      if (request.method === 'PUT' && url.searchParams.get('restype') === 'container') {
        if (containers.has(container)) return sendError(request, response, 409, 'ContainerAlreadyExists', 'The specified container already exists.');
        containers.set(container, new Map());
        response.writeHead(201, { etag: `"0x8D${++sequence}"`, 'last-modified': new Date().toUTCString() });
        return void response.end();
      }
      if (request.method === 'GET' && url.searchParams.get('comp') === 'list') {
        const blobs = containers.get(container);
        if (!blobs) return sendError(request, response, 404, 'ContainerNotFound', 'The specified container does not exist.');
        const prefix = url.searchParams.get('prefix') ?? '';
        const max = Number(url.searchParams.get('maxresults') ?? 5000);
        const marker = url.searchParams.get('marker');
        const names = [...blobs.keys()].filter((name) => name.startsWith(prefix)).sort();
        const start = marker ? names.indexOf(marker) : 0;
        const page = names.slice(Math.max(start, 0), Math.max(start, 0) + max);
        const next = names[Math.max(start, 0) + max] ?? '';
        const items = page.map((name) => {
          const blob = blobs.get(name)!;
          const metadata = url.searchParams.get('include')?.includes('metadata')
            ? `<Metadata>${Object.entries(blob.metadata).map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`).join('')}</Metadata>`
            : '';
          return `<Blob><Name>${escapeXml(name)}</Name><Properties><Last-Modified>${blob.lastModified.toUTCString()}</Last-Modified><Etag>${blob.etag.replace(/"/g, '')}</Etag><Content-Length>${blob.data.length}</Content-Length><Content-Type>${escapeXml(blob.contentType)}</Content-Type><BlobType>BlockBlob</BlobType></Properties>${metadata}</Blob>`;
        });
        response.writeHead(200, { 'content-type': 'application/xml', 'x-ms-request-id': randomUUID() });
        return void response.end(`<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="http://x/${options.account}" ContainerName="${escapeXml(container)}"><Prefix>${escapeXml(prefix)}</Prefix><MaxResults>${max}</MaxResults><Blobs>${items.join('')}</Blobs><NextMarker>${escapeXml(next)}</NextMarker></EnumerationResults>`);
      }
      return sendError(request, response, 400, 'UnsupportedHttpVerb', 'The resource does not support the HTTP verb used in the request.');
    }

    const blobs = containers.get(container);
    if (!blobs) return sendError(request, response, 404, 'ContainerNotFound', 'The specified container does not exist.');
    const name = rest.join('/');
    const blob = blobs.get(name);

    switch (request.method) {
      case 'PUT': {
        const metadata: Record<string, string> = {};
        for (const [header, value] of Object.entries(request.headers)) {
          if (header.startsWith('x-ms-meta-')) metadata[header.slice('x-ms-meta-'.length)] = String(value);
        }
        const stored: StoredBlob = {
          data: request.body,
          contentType: String(request.headers['x-ms-blob-content-type'] ?? 'application/octet-stream'),
          metadata,
          etag: `"0x8D${String(++sequence).padStart(8, '0')}"`,
          lastModified: new Date(),
        };
        blobs.set(name, stored);
        response.writeHead(201, {
          etag: stored.etag,
          'last-modified': stored.lastModified.toUTCString(),
          'content-md5': createHash('md5').update(request.body).digest('base64'),
          'x-ms-request-server-encrypted': 'true',
          'x-ms-request-id': randomUUID(),
        });
        return void response.end();
      }
      case 'GET':
      case 'HEAD': {
        if (!blob) return sendError(request, response, 404, 'BlobNotFound', 'The specified blob does not exist.');
        const ifMatch = request.headers['if-match'];
        if (ifMatch && ifMatch !== '*' && ifMatch !== blob.etag) {
          return sendError(request, response, 412, 'ConditionNotMet', 'The condition specified using HTTP conditional header(s) is not met.');
        }
        // `bytes=<start>-[<end>]`; an empty blob has no range to give and answers 200
        const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers['x-ms-range'] ?? request.headers.range ?? ''));
        const total = blob.data.length;
        const start = range ? Number(range[1]) : 0;
        if (range && total > 0 && start >= total) return sendError(request, response, 416, 'InvalidRange', 'The range specified is invalid for the current size of the resource.');
        const end = range && total > 0 ? Math.min(range[2] === '' ? total - 1 : Number(range[2]), total - 1) : total - 1;
        const ranged = Boolean(range) && total > 0;
        const slice = ranged ? blob.data.subarray(start, end + 1) : blob.data;
        const headers = { ...blobHeaders(blob), 'content-length': String(slice.length) };
        if (ranged) Object.assign(headers, { 'content-range': `bytes ${start}-${end}/${total}` });
        response.writeHead(ranged ? 206 : 200, headers);
        const drop = options.dropDownloads;
        if (request.method === 'GET' && drop && dropsLeft > 0 && slice.length > drop.afterBytes) {
          dropsLeft -= 1;
          drop.onDrop?.();
          // the socket goes once the part has been handed to the kernel, so the client reads exactly that part and then loses the connection
          response.write(slice.subarray(0, drop.afterBytes), () => response.socket?.destroy());
          return;
        }
        return void response.end(request.method === 'HEAD' ? undefined : slice);
      }
      case 'DELETE':
        if (!blob) return sendError(request, response, 404, 'BlobNotFound', 'The specified blob does not exist.');
        blobs.delete(name);
        response.writeHead(202, { 'x-ms-request-id': randomUUID(), 'x-ms-delete-type-permanent': 'true' });
        return void response.end();
      default:
        return sendError(request, response, 400, 'UnsupportedHttpVerb', 'The resource does not support the HTTP verb used in the request.');
    }
  }

  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request: SeenRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(request);
      if (options.override?.(request, res)) return;
      const refusal = options.authorize?.(request);
      if (refusal) return sendError(request, res, refusal.status, refusal.code, 'Refused by the test server.', refusal.headers);
      route(request, res);
    });
  };

  const server = options.tls ? https.createServer({ key: options.tls.key, cert: options.tls.cert }, handler) : http.createServer(handler);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('secureConnection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    endpoint: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}/${options.account}`,
    seen,
    containers,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface TokenServerOptions {
  /** The key pair the server presents. */
  tls: { key: string | Buffer; cert: string | Buffer };
  /** The access token it hands out (default `token-from-the-fake-authority`). */
  token?: string;
}

export interface TokenServer {
  port: number;
  /** `https://127.0.0.1:<port>`: what the provider's "Authority host" setting holds. */
  authority: string;
  /** Every request that got through the TLS handshake, in order. */
  seen: SeenRequest[];
  close(): Promise<void>;
}

/** A stand-in for a Microsoft Entra token endpoint: `POST /<tenant>/oauth2/v2.0/token` is answered with an access token, anything else with a 404. */
export async function startTokenServer(options: TokenServerOptions): Promise<TokenServer> {
  const seen: SeenRequest[] = [];
  const sockets = new Set<Socket>();
  const server = https.createServer({ key: options.tls.key, cert: options.tls.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      if (req.method === 'POST' && /^\/[^/]+\/oauth2\/v2\.0\/token$/.test(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ token_type: 'Bearer', expires_in: 3600, access_token: options.token ?? 'token-from-the-fake-authority' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });
  server.on('secureConnection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    authority: `https://127.0.0.1:${port}`,
    seen,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
