import slugify from 'slugify';
import Mustache from 'mustache';
import { getDatabase, type DatabaseProvider, type IPrompt } from '@/lib/database';
import type { CreatePromptInput, PromptView, UpdatePromptInput } from './types';

const SLUG_OPTIONS = {
  lower: true,
  strict: true,
  trim: true,
};

const FALLBACK_KEY = 'prompt';
const MAX_KEY_ATTEMPTS = 50;

function normalizeKeyCandidate(input: string | undefined): string {
  const fallback = input && input.trim().length > 0 ? input.trim() : FALLBACK_KEY;
  const slug = slugify(fallback, SLUG_OPTIONS);
  return slug.length > 0 ? slug : FALLBACK_KEY;
}

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function serializePrompt(prompt: IPrompt): PromptView {
  const { _id, ...rest } = prompt;
  return {
    ...rest,
    id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
  } satisfies PromptView;
}

async function generateUniqueKey(
  tenantDbName: string,
  projectId: string,
  desiredKey: string | undefined,
): Promise<string> {
  const db = await withTenantDb(tenantDbName);
  const base = normalizeKeyCandidate(desiredKey);
  let attempt = 0;
  let candidate = base;

  while (attempt < MAX_KEY_ATTEMPTS) {
    const existing = await db.findPromptByKey(candidate, projectId);
    if (!existing) {
      return candidate;
    }

    attempt += 1;
    candidate = `${base}-${attempt + 1}`;
  }

  throw new Error('Could not generate unique prompt key');
}

export async function listPrompts(
  tenantDbName: string,
  projectId: string,
  filters?: { search?: string },
): Promise<PromptView[]> {
  const db = await withTenantDb(tenantDbName);
  const records = await db.listPrompts({
    projectId,
    search: filters?.search,
  });

  return records.map(serializePrompt);
}

export async function getPromptById(
  tenantDbName: string,
  projectId: string,
  id: string,
): Promise<PromptView | null> {
  const db = await withTenantDb(tenantDbName);
  const record = await db.findPromptById(id, projectId);
  return record ? serializePrompt(record) : null;
}

export async function getPromptByKey(
  tenantDbName: string,
  projectId: string,
  key: string,
): Promise<PromptView | null> {
  const db = await withTenantDb(tenantDbName);
  const record = await db.findPromptByKey(key, projectId);
  return record ? serializePrompt(record) : null;
}

export async function createPrompt(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  userId: string,
  payload: CreatePromptInput,
): Promise<PromptView> {
  const db = await withTenantDb(tenantDbName);
  const keyCandidate = payload.key || payload.name;
  const key = await generateUniqueKey(tenantDbName, projectId, keyCandidate);

  const record = await db.createPrompt({
    tenantId,
    projectId,
    key,
    name: payload.name,
    description: payload.description,
    template: payload.template,
    metadata: payload.metadata,
    createdBy: userId,
  });

  return serializePrompt(record);
}

export async function updatePrompt(
  tenantDbName: string,
  projectId: string,
  id: string,
  updates: UpdatePromptInput,
): Promise<PromptView | null> {
  const db = await withTenantDb(tenantDbName);
  const existing = await db.findPromptById(id, projectId);
  if (!existing) {
    return null;
  }

  const updated = await db.updatePrompt(id, {
    ...updates,
    updatedBy: updates.updatedBy,
  });

  if (!updated) {
    return null;
  }

  return serializePrompt(updated);
}

export async function deletePrompt(
  tenantDbName: string,
  projectId: string,
  id: string,
): Promise<boolean> {
  const db = await withTenantDb(tenantDbName);
  const record = await db.findPromptById(id, projectId);
  if (!record) {
    return false;
  }
  return db.deletePrompt(id);
}

export function renderPromptTemplate(
  template: string,
  data?: Record<string, unknown>,
): string {
  const safeData = data ?? {};
  return Mustache.render(template, safeData);
}
