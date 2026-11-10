/**
 * Pure request-body parsing for memory store create/update, shared by the
 * dashboard and client memory routes. No request, reply or auth access: callers
 * pass the decoded JSON object and add the acting user themselves.
 *
 * The update parser is a whitelist: only `name`, `description`, `status` and
 * `config` are carried over, whatever else the body holds.
 */
import type { CreateMemoryStoreRequest, UpdateMemoryStoreRequest } from './types';

export type MemoryStoreCreateInput = Omit<CreateMemoryStoreRequest, 'createdBy'>;
export type MemoryStoreUpdateInput = Omit<UpdateMemoryStoreRequest, 'updatedBy'>;

export type MemoryStoreCreateParseResult =
  | { ok: true; value: MemoryStoreCreateInput }
  | { ok: false; status: 400; error: string };

export function parseCreateMemoryStoreBody(body: Record<string, unknown>): MemoryStoreCreateParseResult {
  if (typeof body.name !== 'string') {
    return { ok: false, status: 400, error: 'name is required' };
  }
  if (typeof body.vectorProviderKey !== 'string') {
    return { ok: false, status: 400, error: 'vectorProviderKey is required' };
  }
  if (typeof body.embeddingModelKey !== 'string') {
    return { ok: false, status: 400, error: 'embeddingModelKey is required' };
  }

  return {
    ok: true,
    value: {
      config: body.config as MemoryStoreCreateInput['config'],
      description: body.description as string | undefined,
      embeddingModelKey: body.embeddingModelKey,
      name: body.name,
      vectorProviderKey: body.vectorProviderKey,
    },
  };
}

export function parseUpdateMemoryStoreBody(body: Record<string, unknown>): MemoryStoreUpdateInput {
  return {
    config: body.config as MemoryStoreUpdateInput['config'],
    description: body.description as string | undefined,
    name: body.name as string | undefined,
    status: body.status as MemoryStoreUpdateInput['status'],
  };
}
