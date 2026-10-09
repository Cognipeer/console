import { authorizeGate } from '../engine';
import { userPrincipal } from '../entities';

/**
 * Smoke-test of the engine for one tenant: an admin principal must be allowed
 * to read a service without evaluation errors. Used before switching a tenant
 * to shadow mode so a broken WASM load or unreadable policy store is reported
 * to the operator instead of silently producing noise.
 */
export async function engineSelfTest(tenantDbName: string): Promise<{ ok: boolean; error?: string }> {
  const result = await authorizeGate({
    tenant: tenantDbName,
    principal: userPrincipal({ userId: 'iam-selftest', user: { role: 'admin' } }),
    service: 'models',
    method: 'GET',
  });
  if (result.allowed && result.errors.length === 0) return { ok: true };
  return { ok: false, error: result.errors.join('; ') || 'the engine denied an admin read of "models"' };
}
