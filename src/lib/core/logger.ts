/**
 * Structured Logger — Winston-based, ENV-configurable.
 *
 * Features:
 * - JSON format (production) / pretty format (development)
 * - Automatic requestId & tenantId injection from RequestContext
 * - Scoped child loggers via createLogger(scope)
 * - Log level controlled via LOG_LEVEL env
 *
 * Usage:
 *   import { logger, createLogger } from '@/lib/core/logger';
 *
 *   logger.info('Server started');                    // root logger
 *   const log = createLogger('inference');             // scoped
 *   log.info('Chat completion', { model: 'gpt-4' });  // adds scope + requestId
 */

import { Agent as HttpAgent, ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { inspect } from 'node:util';
import winston from 'winston';
import { getConfig } from './config';
import { getRequestContext } from './requestContext';

/* ------------------------------------------------------------------ */
/*  Request-context enrichment format                                 */
/* ------------------------------------------------------------------ */

const requestContextFormat = winston.format((info) => {
  const ctx = getRequestContext();
  if (ctx) {
    info.requestId = info.requestId ?? ctx.requestId;
    if (ctx.tenantId) info.tenantId = info.tenantId ?? ctx.tenantId;
    if (ctx.tenantSlug) info.tenantSlug = info.tenantSlug ?? ctx.tenantSlug;
    if (ctx.userId) info.userId = info.userId ?? ctx.userId;
  }
  return info;
});

/* ------------------------------------------------------------------ */
/*  Secret redaction                                                  */
/* ------------------------------------------------------------------ */

const REDACTED = '[REDACTED]';
/**
 * Object keys whose VALUE is a secret and must never be persisted or shown.
 * Shared with the persisted-log scrubber (see `logRedaction.ts`) so app logs
 * and request-log payloads redact by the same rule.
 */
export const SENSITIVE_KEY_PATTERN = /^(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|bearer|cookie|set[_-]?cookie|token|jwt|encryption[_-]?key|private[_-]?key|x[_-]?api[_-]?key|aws[_-]?secret)$/i;
const REDACT_MAX_DEPTH = 6;
const CIRCULAR = '[Circular]';
/** Characters of a failed HTTP call's response body kept in a log line. */
const HTTP_ERROR_BODY_MAX_CHARS = 2_000;

function typeTag(value: object): string {
  return `[${value.constructor?.name || 'Object'}]`;
}

/**
 * Node's own HTTP and socket objects. They point at each other (a request at
 * its response and socket, both back at the request), and a request's
 * `_header` is the raw request head, Authorization header included. A log
 * line gets their type, never their fields.
 */
function isNodeIoObject(value: object): boolean {
  return value instanceof ClientRequest
    || value instanceof IncomingMessage
    || value instanceof ServerResponse
    || value instanceof Socket
    || value instanceof HttpAgent;
}

interface HttpClientErrorLike extends Error {
  code?: unknown;
  status?: unknown;
  config?: { method?: unknown; url?: unknown; baseURL?: unknown };
  response?: { status?: unknown; data?: unknown };
}

function isHttpClientError(value: object): value is HttpClientErrorLike {
  return value instanceof Error && (value as { isAxiosError?: unknown }).isAxiosError === true;
}

/** The request URL without its query, fragment or credentials, any of which can carry a key. */
function loggableUrl(url: unknown, baseURL: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  try {
    const parsed = new URL(url, typeof baseURL === 'string' && baseURL ? baseURL : undefined);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0].replace(/\/\/[^/@]*@/, '//');
  }
}

function loggableResponseBody(data: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (data === undefined || data === null || data === '') return undefined;
  if (typeof data === 'string') {
    return data.length > HTTP_ERROR_BODY_MAX_CHARS
      ? `${data.slice(0, HTTP_ERROR_BODY_MAX_CHARS)}… [truncated]`
      : data;
  }
  if (typeof data === 'object' && (Buffer.isBuffer(data) || data instanceof ArrayBuffer)) {
    return typeTag(data);
  }
  return redactValue(data, depth, seen);
}

/**
 * A failed axios call carries the whole exchange: the live request and
 * response (which point at each other), the request body with whatever
 * credentials were posted, the raw request head with its Authorization
 * header. What identifies the failure is kept; none of the rest is.
 */
function summarizeHttpClientError(
  error: HttpClientErrorLike,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = { name: error.name, message: error.message, stack: error.stack };
  if (error.code !== undefined && error.code !== null) summary.code = error.code;
  const status = error.response?.status ?? error.status;
  if (status !== undefined && status !== null) summary.status = status;
  if (typeof error.config?.method === 'string') summary.method = error.config.method.toUpperCase();
  const url = loggableUrl(error.config?.url, error.config?.baseURL);
  if (url) summary.url = url;
  const body = loggableResponseBody(error.response?.data, depth + 1, seen);
  if (body !== undefined) summary.responseBody = body;
  return summary;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  // Never hand the object itself back: whatever cycle it is part of would
  // reach the serializer and throw out of the log call.
  if (seen.has(value)) return CIRCULAR;
  if (depth > REDACT_MAX_DEPTH) return typeTag(value);
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  if (value instanceof Date || Buffer.isBuffer(value)) {
    return value;
  }

  if (isNodeIoObject(value)) {
    return typeTag(value);
  }

  if (isHttpClientError(value)) {
    return summarizeHttpClientError(value, depth, seen);
  }

  // `winston.format.errors({ stack: true })` below only expands an Error
  // passed as the log call's own top-level message/splat -- it never looks
  // inside a metadata property. `logger.error('X failed', { error })`, the
  // dominant pattern across this codebase, buries the Error one level down,
  // so it reaches here unexpanded and then hits `winston.format.json()`:
  // `message` and `stack` are non-enumerable own properties on a plain
  // `Error`, so a bare `JSON.stringify` drops both and keeps only whatever a
  // custom subclass explicitly assigned as an enumerable own property (e.g.
  // Playwright's TimeoutError setting `this.name`) -- which is exactly why
  // these logs showed `{"name":"TimeoutError"}` and nothing else. Expand it
  // into a plain object instead of returning it as-is, so every one of those
  // call sites actually logs what it was written to log.
  if (value instanceof Error) {
    const expanded: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const [k, v] of Object.entries(value as unknown as Record<string, unknown>)) {
      if (k === 'name' || k === 'message' || k === 'stack') continue;
      expanded[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : redactValue(v, depth + 1, seen);
    }
    return expanded;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactValue(v, depth + 1, seen);
    }
  }
  return out;
}

/** Exported for direct testing of the actual serialization pipeline. */
export const redactSecretsFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    // Skip Winston's well-known structural fields.
    if (key === 'level' || key === 'message' || key === 'timestamp' || key === 'scope') continue;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      info[key] = REDACTED;
      continue;
    }
    const value = (info as Record<string, unknown>)[key];
    if (value && typeof value === 'object') {
      (info as Record<string, unknown>)[key] = redactValue(value, 0, new WeakSet());
    }
  }
  return info;
});

/* ------------------------------------------------------------------ */
/*  Build format pipeline based on config                             */
/* ------------------------------------------------------------------ */

function stringifyFields(fields: Record<string, unknown>): string {
  try {
    return JSON.stringify(fields, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  } catch {
    // String keys only: winston keeps the raw log arguments under symbol keys.
    const plain = Object.fromEntries(Object.keys(fields).map((key) => [key, fields[key]]));
    return inspect(plain, { depth: REDACT_MAX_DEPTH, breakLength: Infinity });
  }
}

/** The development (pretty) line. Never throws: a log call must not fail the code that makes it. */
export const prettyLineFormat = winston.format.printf(({ timestamp, level, message, scope, requestId, tenantId, ...rest }) => {
  const scopeTag = scope ? `[${scope}]` : '';
  const reqTag = requestId ? `(${String(requestId).slice(0, 8)})` : '';
  const tenantTag = tenantId ? `{${tenantId}}` : '';
  const extra = Object.keys(rest).length ? ` ${stringifyFields(rest)}` : '';
  return `${timestamp} ${level} ${scopeTag}${reqTag}${tenantTag} ${message}${extra}`;
});

function buildFormat() {
  const cfg = getConfig();
  const base = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    requestContextFormat(),
    redactSecretsFormat(),
    winston.format.errors({ stack: true }),
  );

  if (cfg.logging.format === 'pretty') {
    return winston.format.combine(
      base,
      winston.format.colorize(),
      prettyLineFormat,
    );
  }

  // JSON format for production
  return winston.format.combine(base, winston.format.json());
}

/* ------------------------------------------------------------------ */
/*  Singleton root logger                                             */
/* ------------------------------------------------------------------ */

let _logger: winston.Logger | null = null;

function getRootLogger(): winston.Logger {
  if (!_logger) {
    const cfg = getConfig();
    _logger = winston.createLogger({
      level: cfg.logging.level,
      format: buildFormat(),
      defaultMeta: {},
      transports: [new winston.transports.Console()],
      // Don't exit on uncaught exceptions — let lifecycle handler deal with it
      exitOnError: false,
    });
  }
  return _logger;
}

/**
 * Root logger instance.
 * Use createLogger(scope) for domain-specific logging.
 */
export const logger = new Proxy({} as winston.Logger, {
  get(_target, prop: string) {
    const root = getRootLogger();
    const val = (root as unknown as Record<string, unknown>)[prop];
    if (typeof val === 'function') return val.bind(root);
    return val;
  },
});

/**
 * Create a scoped child logger.
 * The scope is included in every log entry automatically.
 */
export function createLogger(scope: string): winston.Logger {
  return new Proxy({} as winston.Logger, {
    get(_target, prop: string) {
      const child = getRootLogger().child({ scope });
      const val = (child as unknown as Record<string, unknown>)[prop];
      if (typeof val === 'function') return val.bind(child);
      return val;
    },
  });
}

/**
 * Force logger reconfiguration (e.g. after config reload in tests).
 */
export function resetLogger(): void {
  if (_logger) {
    _logger.close();
    _logger = null;
  }
}
