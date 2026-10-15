import type { ProviderDomain } from '@/lib/database';
import { providerRegistry } from '@/lib/providers';
import type { FileProviderRuntime } from '@/lib/providers/domains/file';
import type { VectorProviderRuntime } from '@/lib/providers/domains/vector';
import type { ProviderContext } from '@/lib/providers/types';
import { safeFetch } from '@/lib/security/outboundFetch';
import {
  assertProviderTestEndpointsAllowed,
  endpointGuardOptions,
  hasUnvettableEndpoint,
} from './providerEndpointGuard';

/** A "Test connection" never waits longer than this. */
export const PROVIDER_TEST_TIMEOUT_MS = 10_000;

/** Names listed in a result are capped: the answer is a hint, not an inventory. */
const MAX_LISTED = 50;

export interface ProviderTestResult {
  /** `null`: this driver has no test. */
  ok: boolean | null;
  latencyMs: number;
  message: string;
  details?: { deployments?: string[]; models?: string[] };
}

export interface ProviderTestInput {
  type: ProviderDomain;
  driver: string;
  credentials: Record<string, unknown>;
  settings?: Record<string, unknown>;
  tenantId: string;
  providerKey?: string;
  projectId?: string;
}

/** Seams for tests; production uses the real guarded fetch and the provider registry. */
export interface ProviderTestDeps {
  fetchImpl?: typeof safeFetch;
  createRuntime?: <T>(driver: string, context: ProviderContext) => Promise<T>;
  timeoutMs?: number;
}

type HttpProbe = {
  url: string;
  headers: Record<string, string>;
  /** What the answer lists. */
  parse: (body: unknown) => { models?: string[]; deployments?: string[] };
  /** A 404/405 here means "this server has no such route", not "the credentials are wrong". */
  optionalRoute?: boolean;
  /** Tried when the first route answered 404 (Azure: the deployments route is gone from newer API versions). */
  fallback?: HttpProbe;
};

/** Domains whose drivers are inference APIs over HTTP. */
const INFERENCE_DOMAINS = new Set<string>(['model', 'embedding', 'image', 'stt', 'tts', 'ocr', 'moderation', 'decision']);

/** Drivers that run inside the console: there is no connection to test. */
const LOCAL_DRIVERS = new Set(['local-filesystem', 'sqlite-vector', 'orama', 'dummy-vector', 'system-default']);

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const trimSlash = (value: string): string => value.replace(/\/+$/, '');

function listIds(body: unknown, listKey: string, ...fields: string[]): string[] {
  const list = (body as Record<string, unknown> | null)?.[listKey];
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      names.push(item);
      continue;
    }
    for (const field of fields) {
      const candidate = (item as Record<string, unknown> | null)?.[field];
      if (typeof candidate === 'string' && candidate) {
        names.push(candidate);
        break;
      }
    }
  }
  return names.slice(0, MAX_LISTED);
}

const modelsOf = (listKey: string, ...fields: string[]) => (body: unknown) => ({
  models: listIds(body, listKey, ...fields),
});

/**
 * The cheapest authenticated request each inference driver answers: the "list models" route of
 * its API. A driver without one (signed APIs, rerank-only vendors) has no probe.
 */
function httpProbeFor(driver: string, credentials: Record<string, unknown>, settings: Record<string, unknown>): HttpProbe | null {
  const apiKey = asString(credentials.apiKey);
  const bearer = { Authorization: `Bearer ${apiKey}` };
  switch (driver) {
    case 'openai':
      return { url: 'https://api.openai.com/v1/models', headers: bearer, parse: modelsOf('data', 'id') };
    case 'together':
      // Together answers with a bare array rather than `{ data: [...] }`.
      return {
        url: 'https://api.together.xyz/v1/models',
        headers: bearer,
        parse: (body) => ({
          models: listIds({ data: Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data }, 'data', 'id'),
        }),
      };
    case 'openai-compatible': {
      const base = trimSlash(asString(settings.baseUrl));
      if (!base) return null;
      return {
        url: `${base}/models`,
        headers: { ...bearer, 'api-key': apiKey },
        parse: modelsOf('data', 'id'),
        optionalRoute: true,
      };
    }
    case 'anthropic': {
      const base = trimSlash(asString(settings.baseUrl) || 'https://api.anthropic.com');
      return {
        url: `${base.endsWith('/v1') ? base : `${base}/v1`}/models?limit=20`,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        parse: modelsOf('data', 'id'),
      };
    }
    case 'azure': {
      const instance = asString(settings.instanceName);
      if (!instance) return null;
      const origin = `https://${instance}.openai.azure.com`;
      const headers = { 'api-key': apiKey };
      return {
        url: `${origin}/openai/deployments?api-version=2023-03-15-preview`,
        headers,
        parse: (body) => ({ deployments: listIds(body, 'data', 'id') }),
        fallback: {
          url: `${origin}/openai/models?api-version=${encodeURIComponent(asString(settings.apiVersion) || '2024-10-21')}`,
          headers,
          parse: modelsOf('data', 'id'),
        },
      };
    }
    case 'cohere':
      return { url: 'https://api.cohere.com/v1/models?page_size=20', headers: bearer, parse: modelsOf('models', 'name') };
    default:
      return null;
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Every credential value, so a message can be cleaned of them. */
function secretsOf(...sources: Array<Record<string, unknown> | undefined>): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      if (value.trim().length >= 6) out.push(value.trim());
      // A connection string hides its password inside; an error that echoes only that part must be cleaned too.
      const userinfo = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@]*?:([^/?#@]+)@/i.exec(value.trim());
      if (userinfo && userinfo[1].length >= 3) out.push(userinfo[1], decodeURIComponentSafe(userinfo[1]));
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  sources.forEach(visit);
  return out;
}

/** A message that is safe to show: no credential values, no multi-line upstream bodies, bounded. */
export function scrubMessage(raw: string, secrets: readonly string[]): string {
  let message = raw;
  for (const secret of secrets) message = message.split(secret).join('***');
  message = message.replace(/\s+/g, ' ').trim();
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function runHttpProbe(
  probe: HttpProbe,
  fetchImpl: typeof safeFetch,
  timeoutMs: number,
): Promise<Omit<ProviderTestResult, 'latencyMs'>> {
  const response = await fetchImpl(
    probe.url,
    { method: 'GET', headers: { Accept: 'application/json', ...probe.headers } },
    { ...endpointGuardOptions(), timeoutMs, followRedirects: false },
  );
  const status = response.status;
  if (status >= 200 && status < 300) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      /* a 2xx with an unreadable body still proves the credentials work */
    }
    const listed = probe.parse(body);
    const found = listed.deployments ?? listed.models ?? [];
    const noun = listed.deployments ? 'deployment' : 'model';
    return {
      ok: true,
      message: found.length > 0 ? `Connected. ${found.length} ${noun}${found.length === 1 ? '' : 's'} found.` : 'Connected.',
      ...(found.length > 0 ? { details: listed } : {}),
    };
  }
  // The body is never read for a failure: an upstream error page can echo what was sent.
  if (status === 401 || status === 403) {
    return { ok: false, message: `The provider rejected the credentials (HTTP ${status}).` };
  }
  if (status === 404 && probe.fallback) {
    return runHttpProbe(probe.fallback, fetchImpl, timeoutMs);
  }
  if ((status === 404 || status === 405 || status === 501) && probe.optionalRoute) {
    return { ok: null, message: 'The server is reachable but has no model list to check the credentials against.' };
  }
  if (status >= 300 && status < 400) {
    return { ok: false, message: `The endpoint redirected the request (HTTP ${status}); check the base URL.` };
  }
  return { ok: false, message: `The provider answered HTTP ${status}.` };
}

async function runtimeProbe(
  input: ProviderTestInput,
  createRuntime: NonNullable<ProviderTestDeps['createRuntime']>,
): Promise<Omit<ProviderTestResult, 'latencyMs'>> {
  const context: ProviderContext = {
    tenantId: input.tenantId,
    providerKey: input.providerKey ?? 'connection-test',
    projectId: input.projectId,
    credentials: input.credentials,
    settings: input.settings ?? {},
  };

  if (input.type === 'vector') {
    const runtime = await createRuntime<VectorProviderRuntime>(input.driver, context);
    try {
      const indexes = await runtime.listIndexes();
      const names = indexes.map((index) => index.name).slice(0, MAX_LISTED);
      return {
        ok: true,
        message: `Connected. ${indexes.length} index${indexes.length === 1 ? '' : 'es'} found.`,
        ...(names.length > 0 ? { details: { deployments: names } } : {}),
      };
    } finally {
      await Promise.resolve(runtime.close?.()).catch(() => undefined);
    }
  }

  const runtime = await createRuntime<FileProviderRuntime>(input.driver, context);
  await runtime.listFiles({ limit: 1 });
  return { ok: true, message: 'Connected.' };
}

/**
 * "Test connection": the cheapest authenticated request the driver supports (list models /
 * deployments / indexes). Never persists anything; never returns credentials or an upstream body.
 * `ok: null` = the driver has no test.
 *
 * Throws `ProviderEndpointError` when an endpoint is refused by the outbound guard (HTTP 400 for the caller).
 */
export async function testProviderConnection(
  input: ProviderTestInput,
  deps: ProviderTestDeps = {},
): Promise<ProviderTestResult> {
  const settings = input.settings ?? {};
  const timeoutMs = deps.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS;
  const secrets = secretsOf(input.credentials);
  const started = Date.now();
  const done = (result: Omit<ProviderTestResult, 'latencyMs'>): ProviderTestResult => ({
    ...result,
    latencyMs: Date.now() - started,
  });

  if (LOCAL_DRIVERS.has(input.driver)) {
    return done({ ok: null, message: 'This provider runs inside the console; there is no connection to test.' });
  }

  // Every outbound target goes through the guard before anything is dialled.
  await assertProviderTestEndpointsAllowed(input.type, input.credentials, settings);
  if (hasUnvettableEndpoint(input.credentials, settings)) {
    return done({ ok: null, message: 'Connection strings of this form (SRV) cannot be tested from here.' });
  }

  const httpProbe = INFERENCE_DOMAINS.has(input.type) ? httpProbeFor(input.driver, input.credentials, settings) : null;
  const useRuntime = input.type === 'vector' || input.type === 'file';
  if (!httpProbe && !useRuntime) {
    return done({ ok: null, message: 'Testing is not supported for this driver.' });
  }

  try {
    const result = await withTimeout(
      httpProbe
        ? runHttpProbe(httpProbe, deps.fetchImpl ?? safeFetch, timeoutMs)
        : runtimeProbe(input, deps.createRuntime ?? ((driver, context) => providerRegistry.createRuntime(driver, context))),
      timeoutMs,
    );
    return done(result);
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'The connection failed.';
    return done({ ok: false, message: scrubMessage(raw, secrets) || 'The connection failed.' });
  }
}

/** Deployments / models a result found, as the count a provider record keeps. */
export function foundCount(result: Pick<ProviderTestResult, 'details'>): number | undefined {
  const list = result.details?.deployments ?? result.details?.models;
  return list ? list.length : undefined;
}
