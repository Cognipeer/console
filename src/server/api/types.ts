import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JWTPayload } from '@/lib/license/token-manager';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import type { IUser } from '@/lib/database';

export interface CookieMutation {
  action: 'set' | 'delete';
  name: string;
  value?: string;
  options?: {
    domain?: string;
    expires?: Date;
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    sameSite?: 'lax' | 'strict' | 'none';
    secure?: boolean;
  };
}

export interface ApiRequestContextHeaders {
  [headerName: string]: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiContextHeaders?: ApiRequestContextHeaders;
    apiRequestId?: string;
    apiSession?: JWTPayload;
    apiTokenContext?: ApiTokenContext;
    rbacUser?: IUser;
    /**
     * Set when the response status was forwarded from an upstream model
     * provider rather than decided by our own auth layer, so a provider's 401
     * is not recorded in the security audit trail as a denied user request.
     */
    upstreamStatusForwarded?: boolean;
    /**
     * Set when the authorization engine refused this request (iam/enforce.ts), so
     * the audit row can carry the decisionId the caller was shown:
     * `forbidden` (403, a decision), `route_not_declared` (403) or
     * `authorization_unavailable` (503, the engine could not decide).
     */
    iamDenial?: {
      code: 'forbidden' | 'route_not_declared' | 'authorization_unavailable';
      decisionId?: string;
      service?: string;
      required?: string;
      /** Engine denials: the gate action, the project context and the deciding policies (audit only). */
      action?: string;
      projectId?: string | null;
      reasons?: string[];
      policyIds?: string[];
      /** The address the engine evaluated (getAuthzClientIp), so a replay of the decision uses the same one. */
      ip?: string;
    };
    /**
     * Decision id of a refusal made by a handler-level check
     * (authorizeServiceForRequest). A 403 answer carries it as X-Decision-Id.
     */
    iamDecisionId?: string;
  }
}

export type RouteInvocation = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;
