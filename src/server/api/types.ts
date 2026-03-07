import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JWTPayload } from '@/lib/license/token-manager';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';

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
  }

  interface FastifyReply {
    setCookie(
      name: string,
      value: string,
      options?: CookieMutation['options'],
    ): FastifyReply;
    clearCookie(
      name: string,
      options?: CookieMutation['options'],
    ): FastifyReply;
  }
}

export type RouteInvocation = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;
