/**
 * Next.js instrumentation hook — runs once when the Node.js server process starts.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * We use this to kick off the background inference-monitoring poll scheduler
 * so that servers are polled automatically at their configured interval without
 * any external cron or process manager.
 */

export async function register() {
  // Only run in the Node.js runtime (not Edge workers).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startPollScheduler } = await import(
      '@/lib/services/inferenceMonitoring/pollScheduler'
    );
    startPollScheduler();
  }
}
