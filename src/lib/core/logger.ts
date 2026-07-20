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

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (depth > REDACT_MAX_DEPTH) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  // Preserve Error / Date / Buffer instances as-is.
  if (value instanceof Error || value instanceof Date || Buffer.isBuffer(value)) {
    return value;
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

const redactSecretsFormat = winston.format((info) => {
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
      winston.format.printf(({ timestamp, level, message, scope, requestId, tenantId, ...rest }) => {
        const scopeTag = scope ? `[${scope}]` : '';
        const reqTag = requestId ? `(${String(requestId).slice(0, 8)})` : '';
        const tenantTag = tenantId ? `{${tenantId}}` : '';
        const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
        return `${timestamp} ${level} ${scopeTag}${reqTag}${tenantTag} ${message}${extra}`;
      }),
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
