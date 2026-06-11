import { createLogger } from '@/lib/core/logger';
import { createServer } from './app';
import { ensureServerEnvLoaded } from './env';

const logger = createLogger('server');

function sanitizeEnvToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const [token] = trimmed.split(/\\r\\n|\\n|\\r|\s+/u);
  return token || undefined;
}

function resolveListenPort(): number {
  const portToken = sanitizeEnvToken(process.env.PORT);
  const parsed = Number.parseInt(portToken ?? '3000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

function resolveListenHost(): string {
  return sanitizeEnvToken(process.env.HOST) ?? '0.0.0.0';
}

function isDevMode(): boolean {
  return process.argv.includes('--dev') || process.env.NODE_ENV !== 'production';
}

async function main() {
  ensureServerEnvLoaded();

  const dev = isDevMode();
  const port = resolveListenPort();
  const host = resolveListenHost();

  const app = await createServer(dev);
  await app.listen({ host, port });

  logger.info('Server listening', {
    dev,
    host,
    port,
  });
}

main().catch((error) => {
  logger.error('Failed to start server', { error });
  process.exit(1);
});
