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
  }
}

export type RouteInvocation = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;
