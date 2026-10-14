/**
 * A failed HTTP call logged as `{ error }` must come out as a short, safe
 * summary, and the log call must never throw.
 *
 * An AxiosError carries the live request and response, which point at each
 * other. The redaction handed an object it had already seen back unchanged,
 * so the development line's JSON.stringify met that cycle and threw
 * "Converting circular structure to JSON" out of `log.error(...)`: the catch
 * block logging the failure failed itself (the SSO callback answered 500
 * instead of redirecting to the login page). The request also carries what
 * was sent: the posted body and the raw request head with its Authorization
 * header.
 *
 * Uses real requests against a local server, because the cycle is in Node's
 * own request/response objects.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import axios, { type AxiosError } from 'axios';
import winston from 'winston';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prettyLineFormat, redactSecretsFormat } from '@/lib/core/logger';

const MESSAGE = Symbol.for('message') as unknown as string;
const POSTED_SECRET = 'posted-client-secret-1234';
const BASIC_CREDENTIALS = Buffer.from('console:basic-client-secret-5678').toString('base64');
const IDP_ERROR = { error: 'unauthorized_client', error_description: "Client requires method 'client_secret_basic'" };

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(IDP_ERROR));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function failure(request: () => Promise<unknown>): Promise<AxiosError> {
  try {
    await request();
  } catch (err) {
    return err as AxiosError;
  }
  throw new Error('the request was expected to fail');
}

/** What the SSO callback logged: a token request the IdP turned down. */
function rejectedTokenRequest(): Promise<AxiosError> {
  return failure(() => axios.post(
    `${baseUrl}/realms/dev/protocol/openid-connect/token?tenant=dev-corp`,
    new URLSearchParams({ grant_type: 'authorization_code', code: 'abc', client_secret: POSTED_SECRET }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${BASIC_CREDENTIALS}` } },
  ));
}

async function refusedRequest(): Promise<AxiosError> {
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  return failure(() => axios.get(`http://127.0.0.1:${port}/userinfo`));
}

function render(format: winston.Logform.Format, meta: Record<string, unknown>): string {
  const pipeline = winston.format.combine(redactSecretsFormat(), winston.format.errors({ stack: true }), format);
  const info = pipeline.transform({ level: 'error', message: 'SSO callback failed', ...meta }, {});
  if (!info) throw new Error('the format pipeline dropped the entry');
  return (info as unknown as Record<string, string>)[MESSAGE];
}

describe('logger: a failed HTTP call in the metadata', () => {
  it('gives a development line instead of throwing, with what identifies the failure', async () => {
    const error = await rejectedTokenRequest();

    let line = '';
    expect(() => { line = render(prettyLineFormat, { tenant: 'dev-corp', error }); }).not.toThrow();

    expect(line).toContain('"tenant":"dev-corp"');
    expect(line).toContain('"name":"AxiosError"');
    expect(line).toContain('"status":401');
    expect(line).toContain('"method":"POST"');
    expect(line).toContain(`"url":"${baseUrl}/realms/dev/protocol/openid-connect/token"`);
    expect(line).toContain(JSON.stringify({ responseBody: IDP_ERROR }).slice(1, -1));
  });

  it('gives the production (JSON) line the same summary and none of the exchange', async () => {
    const error = await rejectedTokenRequest();

    const logged = JSON.parse(render(winston.format.json(), { error })).error;

    expect(logged).toMatchObject({ name: 'AxiosError', code: 'ERR_BAD_REQUEST', status: 401, method: 'POST', responseBody: IDP_ERROR });
    for (const key of ['config', 'request', 'response']) expect(logged).not.toHaveProperty(key);
  });

  it('never logs what the request sent: the posted secret, the credentials, the query', async () => {
    const error = await rejectedTokenRequest();

    for (const line of [render(prettyLineFormat, { error }), render(winston.format.json(), { error })]) {
      expect(line).not.toContain(POSTED_SECRET);
      expect(line).not.toContain(BASIC_CREDENTIALS);
      expect(line).not.toContain('tenant=dev-corp');
    }
  });

  it('logs a refused connection by its code', async () => {
    const error = await refusedRequest();

    let line = '';
    expect(() => { line = render(prettyLineFormat, { error }); }).not.toThrow();
    expect(line).toContain('"code":"ECONNREFUSED"');
    expect(line).toContain('"method":"GET"');
  });

  it('logs Node request objects by their type', async () => {
    const error = await rejectedTokenRequest();

    expect(render(prettyLineFormat, { request: error.request })).toContain('"request":"[ClientRequest]"');
  });
});

describe('logger: metadata the redaction cannot copy whole', () => {
  it('marks a cycle instead of throwing', () => {
    const node: Record<string, unknown> = { name: 'node' };
    node.self = node;

    expect(render(prettyLineFormat, { node })).toContain('"node":{"name":"node","self":"[Circular]"}');
  });

  it('cuts what is nested deeper than it walks, so nothing below escapes the redaction', () => {
    let nested: Record<string, unknown> = { password: 'nested-secret-value' };
    for (let i = 0; i < 8; i += 1) nested = { child: nested };

    const line = render(prettyLineFormat, { nested });

    expect(line).not.toContain('nested-secret-value');
    expect(line).toContain('"child":"[Object]"');
  });

  it('writes a BigInt as a string instead of throwing', () => {
    expect(render(prettyLineFormat, { tokens: BigInt(10) })).toContain('"tokens":"10"');
  });
});
