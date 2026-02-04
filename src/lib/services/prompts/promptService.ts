import slugify from 'slugify';
import Mustache from 'mustache';
import { getDatabase, type DatabaseProvider, type IPrompt, type IPromptVersion } from '@/lib/database';
import type { CreatePromptInput, PromptView, PromptVersionView, UpdatePromptInput } from './types';

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

function serializePromptVersion(version: IPromptVersion): PromptVersionView {
  const { _id, ...rest } = version;
  return {
    ...rest,
    id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
  } satisfies PromptVersionView;
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
  version?: number,
): Promise<PromptView | null> {
  const db = await withTenantDb(tenantDbName);
  const prompt = await db.findPromptByKey(key, projectId);
  
  if (!prompt) {
    return null;
  }

  // If specific version requested, get that version's data
  if (version !== undefined) {
    const promptId = typeof prompt._id === 'string' ? prompt._id : prompt._id?.toString() ?? '';
    const versionRecord = await db.findPromptVersionByNumber(promptId, version);
    if (!versionRecord) {
      return null; // Requested version not found
    }
    // Return prompt with version's content
    return {
      ...serializePrompt(prompt),
      name: versionRecord.name,
      description: versionRecord.description,
      template: versionRecord.template,
      metadata: versionRecord.metadata,
      currentVersion: versionRecord.version,
    };
  }

  // If prompt has a latestVersionId, get that version's content
  if (prompt.latestVersionId) {
    const latestVersion = await db.findPromptVersionById(prompt.latestVersionId);
    if (latestVersion) {
      return {
        ...serializePrompt(prompt),
        name: latestVersion.name,
        description: latestVersion.description,
        template: latestVersion.template,
        metadata: latestVersion.metadata,
        currentVersion: latestVersion.version,
      };
    }
  }

  return serializePrompt(prompt);
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

  // Create the prompt
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

  const promptId = typeof record._id === 'string' ? record._id : record._id?.toString() ?? '';

  // Create the first version
  const version = await db.createPromptVersion({
    promptId,
    tenantId,
    projectId,
    version: 1,
    name: payload.name,
    description: payload.description,
    template: payload.template,
    metadata: payload.metadata,
    isLatest: true,
    createdBy: userId,
  });

  const versionId = typeof version._id === 'string' ? version._id : version._id?.toString() ?? '';

  // Update prompt with latestVersionId
  await db.updatePrompt(promptId, {
    latestVersionId: versionId,
  });

  return {
    ...serializePrompt(record),
    latestVersionId: versionId,
  };
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

  // Check if there are content changes (not just metadata updates)
  const hasContentChanges = 
    (updates.name !== undefined && updates.name !== existing.name) ||
    (updates.description !== undefined && updates.description !== existing.description) ||
    (updates.template !== undefined && updates.template !== existing.template);

  if (hasContentChanges) {
    // Create a new version
    const newVersionNumber = existing.currentVersion + 1;
    
    const newVersion = await db.createPromptVersion({
      promptId: id,
      tenantId: existing.tenantId,
      projectId: existing.projectId,
      version: newVersionNumber,
      name: updates.name ?? existing.name,
      description: updates.description ?? existing.description,
      template: updates.template ?? existing.template,
      metadata: updates.metadata ?? existing.metadata,
      isLatest: true,
      createdBy: updates.updatedBy ?? existing.createdBy,
    });

    const versionId = typeof newVersion._id === 'string' ? newVersion._id : newVersion._id?.toString() ?? '';

    // Set all other versions to not latest
    await db.setPromptLatestVersion(id, versionId);

    // Update the prompt with new version info and content
    const updated = await db.updatePrompt(id, {
      name: updates.name ?? existing.name,
      description: updates.description ?? existing.description,
      template: updates.template ?? existing.template,
      metadata: updates.metadata ?? existing.metadata,
      currentVersion: newVersionNumber,
      latestVersionId: versionId,
      updatedBy: updates.updatedBy,
    });

    if (!updated) {
      return null;
    }

    return serializePrompt(updated);
  }

  // No content changes, just update metadata
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
  
  // Delete all versions first
  await db.deletePromptVersions(id);
  
  return db.deletePrompt(id);
}

// Version-specific functions

export async function listPromptVersions(
  tenantDbName: string,
  projectId: string,
  promptId: string,
): Promise<PromptVersionView[]> {
  const db = await withTenantDb(tenantDbName);
  
  // Verify the prompt exists and belongs to the project
  const prompt = await db.findPromptById(promptId, projectId);
  if (!prompt) {
    return [];
  }

  const versions = await db.listPromptVersions(promptId);
  return versions.map(serializePromptVersion);
}

export async function getPromptVersion(
  tenantDbName: string,
  projectId: string,
  promptId: string,
  versionId: string,
): Promise<PromptVersionView | null> {
  const db = await withTenantDb(tenantDbName);
  
  // Verify the prompt exists and belongs to the project
  const prompt = await db.findPromptById(promptId, projectId);
  if (!prompt) {
    return null;
  }

  const version = await db.findPromptVersionById(versionId);
  if (!version || version.promptId !== promptId) {
    return null;
  }

  return serializePromptVersion(version);
}

export async function setPromptLatestVersion(
  tenantDbName: string,
  projectId: string,
  promptId: string,
  versionId: string,
  userId: string,
): Promise<PromptView | null> {
  const db = await withTenantDb(tenantDbName);
  
  // Verify the prompt exists and belongs to the project
  const prompt = await db.findPromptById(promptId, projectId);
  if (!prompt) {
    return null;
  }

  // Get the version to set as latest
  const version = await db.findPromptVersionById(versionId);
  if (!version || version.promptId !== promptId) {
    return null;
  }

  // Set this version as latest
  await db.setPromptLatestVersion(promptId, versionId);

  // Update the prompt with the version's content
  const updated = await db.updatePrompt(promptId, {
    name: version.name,
    description: version.description,
    template: version.template,
    metadata: version.metadata,
    latestVersionId: versionId,
    updatedBy: userId,
  });

  if (!updated) {
    return null;
  }

  return serializePrompt(updated);
}

export function renderPromptTemplate(
  template: string,
  data?: Record<string, unknown>,
): string {
  const safeData = data ?? {};
  return Mustache.render(template, safeData);
}
