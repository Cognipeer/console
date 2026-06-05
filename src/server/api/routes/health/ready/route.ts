/**
 * Readiness probe — checks all registered health contributors.
 * Used by Kubernetes readinessProbe.
 *
 * Returns 200 when all checks pass, 503 when any check is down.
 */
import { NextResponse } from '@/server/api/http';
import { checkHealth } from '@/lib/core/health';

export async function GET() {
  const report = await checkHealth();
  const status = report.status === 'down' ? 503 : 200;
  return NextResponse.json(report, { status });
}
