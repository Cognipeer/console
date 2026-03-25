/**
 * Next.js instrumentation hook — delegates to the shared Node bootstrap.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootstrapApplication } = await import('@/server/bootstrap');
    await bootstrapApplication();
  }
}
