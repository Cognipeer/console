/** Bare-bones structured logger. Replace with pino if/when we need stable JSON output. */

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  const payload = {
    time: new Date().toISOString(),
    level,
    msg: message,
    ...(meta ?? {}),
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(payload)}\n`);
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => {
    if (process.env.COGNIPEER_LOG_LEVEL === 'debug') emit('debug', m, meta);
  },
  info: (m: string, meta?: Record<string, unknown>) => emit('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit('error', m, meta),
};
