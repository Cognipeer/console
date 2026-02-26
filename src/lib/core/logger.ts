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
/*  Build format pipeline based on config                             */
/* ------------------------------------------------------------------ */

function buildFormat() {
  const cfg = getConfig();
  const base = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    requestContextFormat(),
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
  return getRootLogger().child({ scope });
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
