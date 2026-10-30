/**
 * Who may point a setting at an existing sandbox, asked from inside other routes (agents).
 *
 * An agent given a persistent sandbox runs its commands in that machine and reads its files, so choosing one in
 * an agent's settings is a Sandbox decision about that project: someone who may edit an agent but may not work
 * in the project's sandboxes cannot hand one to an agent. Re-saving the sandbox that is already stored asks
 * nothing.
 */

import type { FastifyRequest } from 'fastify';
import { serviceLevelForRequest } from '../fastify-utils';

/** May the caller work in the sandboxes of `projectId` (Sandbox write)? Quietly asked of the engine (the token's scope as a cap). */
export async function requestHasSandboxWrite(request: FastifyRequest, projectId: string): Promise<boolean> {
  const level = await serviceLevelForRequest(request, 'sandbox', { projectId });
  return level === 'write' || level === 'admin';
}

/** May the caller see the sandboxes of `projectId` (Sandbox read)? */
export async function requestHasSandboxRead(request: FastifyRequest, projectId: string): Promise<boolean> {
  return (await serviceLevelForRequest(request, 'sandbox', { projectId })) !== 'none';
}

/** Why a write that chooses a persistent sandbox was refused. */
export const SANDBOX_WRITE_REQUIRED_MESSAGE =
  'Giving an agent an existing sandbox needs write access to Sandbox in this project. '
  + 'Ask someone with Sandbox access to choose it, or keep the sandbox that is already set.';

/** The 403 body for a write that chooses a persistent sandbox without Sandbox write access. */
export function sandboxWriteRequiredBody(field: string): Record<string, unknown> {
  return {
    error: SANDBOX_WRITE_REQUIRED_MESSAGE,
    type: 'sandbox_write_required',
    code: 'sandbox_write_required',
    field,
  };
}
