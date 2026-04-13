import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CookieMutation } from './types';

type CookieRecord = Record<string, string | undefined>;

export interface NextRequest {
  readonly headers: Headers;
  readonly cookies: {
    get(name: string): { name: string; value: string } | undefined;
    has(name: string): boolean;
  };
  readonly method: string;
  readonly nextUrl: URL;
  readonly url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json<T = any>(): Promise<T>;
  text(): Promise<string>;
}

class RequestCookies {
  constructor(private readonly cookies: CookieRecord) {}

  get(name: string): { name: string; value: string } | undefined {
    const value = this.cookies[name];
    if (value === undefined) {
      return undefined;
    }
    return { name, value };
  }

  has(name: string): boolean {
    return this.cookies[name] !== undefined;
  }
}

function serializeCookie(
  name: string,
  value: string,
  options: CookieMutation['options'] = {},
): string {
  const parts = [`${name}=${value}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.secure) {
    parts.push('Secure');
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  return parts.join('; ');
}

export class GatewayRequest implements NextRequest {
  readonly headers: Headers;
  readonly cookies: RequestCookies;
  readonly nextUrl: URL;
  readonly method: string;
  readonly url: string;

  constructor(
    readonly raw: FastifyRequest,
    private readonly rawBody: unknown,
    headersInit: HeadersInit,
    cookies: CookieRecord,
    absoluteUrl: string,
  ) {
    this.headers = new Headers(headersInit);
    this.cookies = new RequestCookies(cookies);
    this.method = raw.method;
    this.url = absoluteUrl;
    this.nextUrl = new URL(absoluteUrl);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async json<T = any>(): Promise<T> {
    if (this.rawBody === undefined || this.rawBody === null) {
      throw new SyntaxError('Unexpected end of JSON input');
    }

    if (typeof this.rawBody === 'string') {
      return JSON.parse(this.rawBody) as T;
    }

    if (Buffer.isBuffer(this.rawBody)) {
      return JSON.parse(this.rawBody.toString('utf8')) as T;
    }

    return this.rawBody as T;
  }

  async text(): Promise<string> {
    if (this.rawBody === undefined || this.rawBody === null) {
      return '';
    }

    if (typeof this.rawBody === 'string') {
      return this.rawBody;
    }

    if (Buffer.isBuffer(this.rawBody)) {
      return this.rawBody.toString('utf8');
    }

    return JSON.stringify(this.rawBody);
  }
}

export class GatewayResponse extends Response {
  private readonly cookieMutations: CookieMutation[] = [];

  readonly cookies = {
    delete: (name: string, options?: CookieMutation['options']) => {
      const mergedOptions = {
        expires: new Date(0),
        maxAge: 0,
        path: '/',
        ...options,
      };
      this.cookieMutations.push({
        action: 'delete',
        name,
        options: mergedOptions,
      });
      this.headers.append('Set-Cookie', serializeCookie(name, '', mergedOptions));
    },
    set: (
      name: string,
      value: string,
      options?: CookieMutation['options'],
    ) => {
      this.cookieMutations.push({
        action: 'set',
        name,
        value,
        options,
      });
      this.headers.append('Set-Cookie', serializeCookie(name, value, options));
    },
  };

  static json(
    data: unknown,
    init?: ResponseInit,
  ): GatewayResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json; charset=utf-8');
    }

    return new GatewayResponse(JSON.stringify(data), {
      ...init,
      headers,
    });
  }

  static redirect(url: string | URL, init?: number | ResponseInit): GatewayResponse {
    const status = typeof init === 'number' ? init : (init?.status ?? 307);
    const headers = new Headers(typeof init === 'number' ? undefined : init?.headers);
    headers.set('Location', String(url));
    return new GatewayResponse(null, {
      status,
      headers,
    });
  }

  getCookieMutations(): CookieMutation[] {
    return this.cookieMutations;
  }
}

export { GatewayResponse as NextResponse };

function getAbsoluteUrl(request: FastifyRequest): string {
  const protocol =
    request.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim()
    || request.protocol
    || 'http';
  const host = request.headers.host || 'localhost';
  const rawUrl = request.raw.url || '/';
  return new URL(rawUrl, `${protocol}://${host}`).toString();
}

export function createGatewayRequest(
  request: FastifyRequest,
  contextHeaders: HeadersInit = {},
): GatewayRequest {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }
    if (value !== undefined) {
      headers.set(key, String(value));
    }
  }

  const extraHeaders = new Headers(contextHeaders);
  for (const [key, value] of extraHeaders.entries()) {
    headers.set(key, value);
  }

  return new GatewayRequest(
    request,
    request.body,
    headers,
    request.cookies ?? {},
    getAbsoluteUrl(request),
  );
}

function applyCookies(reply: FastifyReply, response: GatewayResponse): void {
  for (const mutation of response.getCookieMutations()) {
    if (mutation.action === 'delete') {
      reply.clearCookie(mutation.name, mutation.options);
      continue;
    }
    reply.setCookie(mutation.name, mutation.value ?? '', mutation.options);
  }
}

async function sendWebResponse(
  reply: FastifyReply,
  response: Response,
): Promise<void> {
  reply.code(response.status);

  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') {
      continue;
    }
    reply.header(key, value);
  }

  if (response.body) {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('text/event-stream')) {
      reply.hijack();
      const nodeStream = Readable.fromWeb(
        response.body as NodeReadableStream,
      );
      nodeStream.pipe(reply.raw);
      await finished(nodeStream);
      return;
    }

    const payload = Buffer.from(await response.arrayBuffer());
    reply.send(payload);
    return;
  }

  reply.send();
}

export async function sendGatewayResponse(
  reply: FastifyReply,
  response: GatewayResponse | Response,
): Promise<void> {
  if (response instanceof GatewayResponse) {
    applyCookies(reply, response);
  }

  await sendWebResponse(reply, response);
}
