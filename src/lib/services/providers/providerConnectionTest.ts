import type { ProviderDomain } from '@/lib/database';
import { providerRegistry } from '@/lib/providers';
import type { FileConnectionCheck, FileProviderRuntime } from '@/lib/providers/domains/file';
import type { VectorProviderRuntime } from '@/lib/providers/domains/vector';
import type { ProviderContext } from '@/lib/providers/types';
import { safeFetch } from '@/lib/security/outboundFetch';
import {
  assertProviderTestEndpointsAllowed,
  endpointGuardOptions,
  hasUnvettableEndpoint,
} from './providerEndpointGuard';
import { validateProviderSettings } from './providerSettingsValidation';
import { normalizeAnthropicBaseUrl } from '@/lib/providers/contracts/anthropicBaseUrl';

/** A "Test connection" never waits longer than this. */
export const PROVIDER_TEST_TIMEOUT_MS = 10_000;

/**
 * After the time limit has stopped a probe, how long it is given to hand in what it has: a driver's check answers with the
 * steps that passed and the one that was stopped, which says more than the limit alone. A probe that is not done by then
 * is left to finish on its own.
 */
export const PROVIDER_TEST_GRACE_MS = 500;

/** The grace for a time limit: `PROVIDER_TEST_GRACE_MS`, and never more than a quarter of a shorter limit. */
export function graceForLimit(timeoutMs: number): number {
  return Math.min(PROVIDER_TEST_GRACE_MS, Math.floor(timeoutMs / 4));
}

/** Names listed in a result are capped: the answer is a hint, not an inventory. */
const MAX_LISTED = 50;

export interface ProviderTestResult {
  /** `null`: this driver has no test. */
  ok: boolean | null;
  latencyMs: number;
  message: string;
  details?: {
    deployments?: string[];
    models?: string[];
    /** File providers: the steps their check ran (list, write, read, delete) and how each ended. */
    steps?: FileConnectionCheck['steps'];
  };
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
  /** How long a probe that the time limit stopped may take to hand in its answer (default: 500 ms, at most a quarter of the limit). */
  graceMs?: number;
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
      const base = normalizeAnthropicBaseUrl(asString(settings.baseUrl)) ?? 'https://api.anthropic.com';
      return {
        url: `${base}/v1/models?limit=20`,
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

/**
 * `scheme://user:password@`: the password of a connection string. The user part cannot hold a colon, so the
 * password starts at the FIRST colon of the authority; a lazy `[^/?#@]*?` there tried every colon in turn, and a
 * value made of colons ("http://" and a long run of ":") took time quadratic in its length - a request body of a
 * megabyte kept the event loop busy for minutes. The captures are the same as the lazy pattern's.
 */
const CONNECTION_STRING_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@:]*:([^/?#@]+)@/i;

/** Every credential value, so a message can be cleaned of them. */
function secretsOf(...sources: Array<Record<string, unknown> | undefined>): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      if (value.trim().length >= 6) out.push(value.trim());
      // A connection string hides its password inside; an error that echoes only that part must be cleaned too.
      const userinfo = CONNECTION_STRING_PASSWORD.exec(value.trim());
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

/** What a person is told when the service did not answer within the limit. */
function timeoutMessage(ms: number): string {
  return `Timed out after ${Math.round(ms / 1000)} s. The service did not answer: check its address and port, and any firewall or proxy in between.`;
}

/**
 * Runs `work` for at most `ms`. When the limit passes, `onTimeout` runs first (so the work can be told to stop) and the work
 * gets `graceMs` to hand in what it has: an answer it resolves with in that time is returned with `timedOut: true`; a
 * rejection (an abort is one) or no answer at all is the timeout error.
 */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  graceMs: number,
  onTimeout?: () => void,
): Promise<{ value: T; timedOut: boolean }> {
  const expired = Symbol('expired');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sleep = (delay: number) => new Promise<typeof expired>((resolve) => {
    timer = setTimeout(() => resolve(expired), delay);
  });
  try {
    const first = await Promise.race([work, sleep(ms)]);
    if (first !== expired) return { value: first as T, timedOut: false };

    onTimeout?.();
    // Whatever the work does from here is not an error of anybody's: it was told to stop.
    const rest = work.then((value) => ({ value }), () => undefined);
    const answer = graceMs > 0 ? await Promise.race([rest, sleep(graceMs).then(() => undefined)]) : undefined;
    if (answer) return { value: answer.value, timedOut: true };
    throw new Error(timeoutMessage(ms));
  } finally {
    clearTimeout(timer);
  }
}

async function runHttpProbe(
  probe: HttpProbe,
  fetchImpl: typeof safeFetch,
  timeoutMs: number,
  tenantId: string,
): Promise<Omit<ProviderTestResult, 'latencyMs'>> {
  const response = await fetchImpl(
    probe.url,
    { method: 'GET', headers: { Accept: 'application/json', ...probe.headers } },
    { ...endpointGuardOptions(tenantId), timeoutMs, followRedirects: false },
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
    return runHttpProbe(probe.fallback, fetchImpl, timeoutMs, tenantId);
  }
  if ((status === 404 || status === 405 || status === 501) && probe.optionalRoute) {
    return { ok: null, message: 'The server is reachable but has no model list to check the credentials against.' };
  }
  if (status >= 300 && status < 400) {
    return { ok: false, message: `The endpoint redirected the request (HTTP ${status}); check the base URL.` };
  }
  return { ok: false, message: `The provider answered HTTP ${status}.` };
}

/** Releases what a probe's runtime holds; the answer is known by now, so a failure here changes nothing. */
async function closeQuietly(runtime: { close?: () => Promise<void> | void }): Promise<void> {
  try {
    await runtime.close?.();
  } catch {
    /* best effort */
  }
}

/** A file driver's own check, as a test result: nothing in it may carry a credential. */
function fileCheckResult(check: FileConnectionCheck, secrets: readonly string[]): Omit<ProviderTestResult, 'latencyMs'> {
  const steps = check.steps?.map((entry) => ({
    step: entry.step,
    ok: entry.ok,
    ...(entry.message ? { message: scrubMessage(entry.message, secrets) } : {}),
  }));
  return {
    ok: check.ok,
    message: scrubMessage(check.message, secrets) || (check.ok ? 'Connected.' : 'The connection failed.'),
    ...(steps && steps.length > 0 ? { details: { steps } } : {}),
  };
}

async function runtimeProbe(
  input: ProviderTestInput,
  createRuntime: NonNullable<ProviderTestDeps['createRuntime']>,
  signal: AbortSignal,
  secrets: readonly string[],
): Promise<Omit<ProviderTestResult, 'latencyMs'>> {
  const context: ProviderContext = {
    tenantId: input.tenantId,
    providerKey: input.providerKey ?? 'connection-test',
    projectId: input.projectId,
    credentials: input.credentials,
    settings: input.settings ?? {},
  };
  // The time limit may pass while the runtime is still being created; the caller has its answer by then.
  const assertWaiting = () => {
    if (signal.aborted) throw new Error('The connection test timed out.');
  };

  if (input.type === 'vector') {
    const runtime = await createRuntime<VectorProviderRuntime>(input.driver, context);
    try {
      assertWaiting();
      const indexes = await runtime.listIndexes();
      const names = indexes.map((index) => index.name).slice(0, MAX_LISTED);
      return {
        ok: true,
        message: `Connected. ${indexes.length} index${indexes.length === 1 ? '' : 'es'} found.`,
        ...(names.length > 0 ? { details: { deployments: names } } : {}),
      };
    } finally {
      await closeQuietly(runtime);
    }
  }

  const runtime = await createRuntime<FileProviderRuntime>(input.driver, context);
  try {
    assertWaiting();
    if (runtime.checkConnection) {
      return fileCheckResult(await runtime.checkConnection({ signal, write: true }), secrets);
    }
    await runtime.listFiles({ limit: 1 });
    return { ok: true, message: 'Connected.' };
  } finally {
    await closeQuietly(runtime);
  }
}

/**
 * "Test connection": the cheapest authenticated request the driver supports (list models /
 * deployments / indexes). Never persists anything; never returns credentials or an upstream body.
 * `ok: null` = the driver has no test.
 *
 * Throws `ProviderSettingsError` when the driver's own check refuses the settings, and `ProviderEndpointError` when
 * an endpoint is refused by the outbound guard (both HTTP 400 for the caller: they say what to change, where a
 * failed connection is only `ok: false`).
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

  // The driver's own checks first (as when the provider is saved), then every outbound target goes through the guard
  // before anything is dialled.
  const scope = { tenantId: input.tenantId };
  await validateProviderSettings(input.driver, input.credentials, settings, scope);
  await assertProviderTestEndpointsAllowed(input.type, scope, input.credentials, settings);
  if (hasUnvettableEndpoint(input.credentials, settings)) {
    return done({ ok: null, message: 'A connection string of this form cannot be checked, so it is not tested from here.' });
  }

  const httpProbe = INFERENCE_DOMAINS.has(input.type) ? httpProbeFor(input.driver, input.credentials, settings) : null;
  const useRuntime = input.type === 'vector' || input.type === 'file';
  if (!httpProbe && !useRuntime) {
    return done({ ok: null, message: 'Testing is not supported for this driver.' });
  }

  // Aborted when the time limit passes, so a probe that is still running stops instead of holding a connection.
  const abort = new AbortController();
  try {
    const { value: result, timedOut } = await withTimeout(
      httpProbe
        ? runHttpProbe(httpProbe, deps.fetchImpl ?? safeFetch, timeoutMs, input.tenantId)
        : runtimeProbe(
          input,
          deps.createRuntime ?? ((driver, context) => providerRegistry.createRuntime(driver, context)),
          abort.signal,
          secrets,
        ),
      timeoutMs,
      deps.graceMs ?? graceForLimit(timeoutMs),
      () => abort.abort(),
    );
    // A check that was stopped by the limit says so in its own words ("stopped before it finished"); the person is told
    // the limit passed, and what to look at. The steps it ran stay: they show how far it got.
    return done(timedOut && result.ok === false ? { ...result, message: timeoutMessage(timeoutMs) } : result);
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
