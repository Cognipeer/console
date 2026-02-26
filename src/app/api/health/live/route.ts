/**
 * Liveness probe — always 200 if the process is running.
 * Used by Kubernetes livenessProbe.
 */
import { NextResponse } from 'next/server';
import { checkLiveness } from '@/lib/core/health';

export async function GET() {
  return NextResponse.json(checkLiveness());
}
