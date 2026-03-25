import { createLogger } from '@/lib/core/logger';
import { createServer } from './app';

const logger = createLogger('server');

function isDevMode(): boolean {
  return process.argv.includes('--dev') || process.env.NODE_ENV !== 'production';
}

async function main() {
  const dev = isDevMode();
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '0.0.0.0';

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
