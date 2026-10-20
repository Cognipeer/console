/**
 * Who may point a setting at Config, asked from inside other routes (agents, sandbox).
 *
 * A config reference makes a value readable by whatever runs with it (an agent's commands, a sandbox's
 * processes), so naming a config item or group in a setting is a Config read decision about that project:
 * someone who may edit an agent but may not look at Config cannot route a Config secret into a sandbox.
 * Re-saving references that are already stored asks nothing (see `configRefTargets` / `addsConfigTargets`).
 */

import type { FastifyRequest } from 'fastify';
import { serviceLevelForRequest } from '../fastify-utils';

/** May the caller read Config in `projectId`? Quietly asked of the engine (the token's scope as a cap). */
export async function requestHasConfigRead(request: FastifyRequest, projectId: string): Promise<boolean> {
  return (await serviceLevelForRequest(request, 'config', { projectId })) !== 'none';
}

/** Why a write that adds config references was refused. */
export const CONFIG_READ_REQUIRED_MESSAGE =
  'Taking a value from Config needs read access to Config in this project. '
  + 'Ask an administrator for Config access, or type the value instead.';

/** The 403 body for a write that adds config references without Config read access. */
export function configReadRequiredBody(field: string): Record<string, unknown> {
  return {
    error: CONFIG_READ_REQUIRED_MESSAGE,
    type: 'config_read_required',
    code: 'config_read_required',
    field,
  };
}
