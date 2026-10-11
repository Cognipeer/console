/**
 * The calls of the "acting for users" section: read, save and remove the delegation of one token. Failures carry the
 * server's code (and the problems it found in the body) so the screen can say what is wrong in the reader's language.
 */

import type { DelegationView } from './delegationModel';

export class DelegationApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The problems the server found in a body it refused (`field`, `message`). */
  readonly problems: Array<{ field: string; message: string }>;

  constructor(status: number, message: string, code: string | null, problems: Array<{ field: string; message: string }>) {
    super(message);
    this.name = 'DelegationApiError';
    this.status = status;
    this.code = code;
    this.problems = problems;
  }
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function failure(response: Response): Promise<DelegationApiError> {
  const body = await readBody(response);
  const problems = Array.isArray(body.problems)
    ? (body.problems as unknown[]).flatMap((item) => {
      const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return typeof entry.message === 'string' ? [{ field: typeof entry.field === 'string' ? entry.field : '', message: entry.message }] : [];
    })
    : [];
  return new DelegationApiError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : null,
    problems,
  );
}

export interface DelegationState {
  delegation: DelegationView | null;
  /** Whether the token has a scope of its own (an unscoped token is as wide as the people it acts for). */
  tokenScoped: boolean;
}

const url = (tokenId: string): string => `/api/tokens/${encodeURIComponent(tokenId)}/delegation`;

function parseState(body: Record<string, unknown>): DelegationState {
  const delegation = body.delegation && typeof body.delegation === 'object' ? (body.delegation as DelegationView) : null;
  return { delegation, tokenScoped: body.tokenScoped !== false };
}

export const delegationApi = {
  async get(tokenId: string, signal?: AbortSignal): Promise<DelegationState> {
    const response = await fetch(url(tokenId), { signal });
    if (!response.ok) throw await failure(response);
    return parseState(await readBody(response));
  },

  async save(tokenId: string, payload: Record<string, unknown>): Promise<DelegationState> {
    const response = await fetch(url(tokenId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw await failure(response);
    return parseState(await readBody(response));
  },

  async remove(tokenId: string): Promise<void> {
    const response = await fetch(url(tokenId), { method: 'DELETE' });
    if (!response.ok) throw await failure(response);
  },
};
