/**
 * The Knowledge Engine access scope of an HTTP request.
 *
 * Whether the caller administers the knowledge base (`manage`, which also
 * gives the admin exception in retrieval) is asked of the engine with the
 * request's own principal, so a custom policy that narrows `rag.admin` (by
 * project, address, group...) is honoured exactly as the gate would honour it.
 * Only a person acting for themselves can manage: an API token never does, and
 * neither does a call an application makes for a person (client callers are
 * always checked like everyone else).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IRagModule } from '@/lib/database';
import {
  kbCallerFromApiToken,
  kbCallerFromSession,
  resolveRagAccess,
  type KbCaller,
  type RagAccessScope,
} from '@/lib/services/rag/access';
import { RagAccessError } from '@/lib/services/rag/ragAccessService';
import { getRagModule } from '@/lib/services/rag/ragService';
import { getSessionContext, serviceActionAllowedForRequest } from './fastify-utils';

export interface RagRequestAccess {
  module: IRagModule | null;
  caller: KbCaller;
  /** Undefined only when the module does not exist. */
  scope?: RagAccessScope;
}

/** Who the request is, as a Knowledge Engine caller. */
export function kbCallerForRequest(request: FastifyRequest): KbCaller {
  if (request.apiTokenContext) return kbCallerFromApiToken(request.apiTokenContext);
  return kbCallerFromSession(getSessionContext(request));
}

/**
 * The module (looked up in the request's project) and the caller's scope in
 * it. Without access control on the module the scope is open and no engine
 * question is asked.
 */
export async function ragAccessForRequest(
  request: FastifyRequest,
  input: { tenantDbName: string; tenantId: string; projectId?: string; ragModuleKey: string },
): Promise<RagRequestAccess> {
  const caller = kbCallerForRequest(request);
  const ragModule = await getRagModule(input.tenantDbName, input.ragModuleKey, input.projectId);
  if (!ragModule) return { module: null, caller };
  let manage = false;
  if (ragModule.access?.enabled === true && caller.kind === 'person' && !caller.delegated && !caller.tokenId) {
    // Throws the 503 the gate would send when the engine cannot decide.
    manage = await serviceActionAllowedForRequest(request, 'rag', 'admin', { projectId: ragModule.projectId ?? null });
  }
  const scope = await resolveRagAccess({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    module: ragModule,
    caller,
    manage,
  });
  return { module: ragModule, caller, scope };
}

/** Whether the request may administer the module's access control (always asked of the engine). */
export async function canAdministerRagAccess(request: FastifyRequest, ragModule: Pick<IRagModule, 'projectId'>): Promise<boolean> {
  return serviceActionAllowedForRequest(request, 'rag', 'admin', { projectId: ragModule.projectId ?? null });
}

/** A refusal from the access service as its HTTP answer, or null for anything else. */
export function sendRagAccessError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (!(error instanceof RagAccessError)) return null;
  return reply.code(error.statusCode).send({
    error: error.message,
    code: error.code,
    ...(error.details ? { details: error.details } : {}),
  });
}
