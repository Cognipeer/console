/**
 * CRUD for the skill library — the project-scoped set of `IAgentSkill`
 * records an agent's Skills tab picks from by key.
 *
 * No versioning, unlike Prompts: a skill's `body` is meant to be edited in
 * place (it is instructions, not something an operator diffs across
 * releases), and every agent referencing the key picks up the latest text on
 * its next run — the same "one row, referenced by key" model `IMemoryStore`
 * and `ITool` already use.
 */

import slugify from 'slugify';
import { getDatabase, type IAgentSkill } from '@/lib/database';

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 20;

function normalizeKeyCandidate(input: string): string {
    const slug = slugify(input, SLUG_OPTIONS);
    return slug.length > 0 ? slug : `skill-${Date.now()}`;
}

async function generateUniqueKey(tenantDbName: string, projectId: string, desired: string): Promise<string> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const base = normalizeKeyCandidate(desired);
    for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
        const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
        if (!(await db.findSkillByKey(candidate, projectId))) return candidate;
    }
    return `${base}-${Date.now()}`;
}

export interface CreateSkillInput {
    key?: string;
    title: string;
    header: string;
    body: string;
    minModelTier?: IAgentSkill['minModelTier'];
    status?: IAgentSkill['status'];
}

export interface UpdateSkillInput {
    title?: string;
    header?: string;
    body?: string;
    minModelTier?: IAgentSkill['minModelTier'] | null;
    status?: IAgentSkill['status'];
}

export async function listSkills(
    tenantDbName: string,
    projectId: string,
    options?: { status?: IAgentSkill['status']; search?: string },
): Promise<IAgentSkill[]> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.listSkills({ projectId, ...options });
}

export async function getSkillById(
    tenantDbName: string,
    projectId: string,
    id: string,
): Promise<IAgentSkill | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.findSkillById(id, projectId);
}

export async function createSkill(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    payload: CreateSkillInput,
): Promise<IAgentSkill> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const key = await generateUniqueKey(tenantDbName, projectId, payload.key || payload.title);

    return db.createSkill({
        tenantId,
        projectId,
        key,
        title: payload.title,
        header: payload.header,
        body: payload.body,
        minModelTier: payload.minModelTier,
        status: payload.status ?? 'active',
        createdBy: userId,
        updatedBy: userId,
    });
}

export async function updateSkill(
    tenantDbName: string,
    projectId: string,
    id: string,
    userId: string,
    updates: UpdateSkillInput,
): Promise<IAgentSkill | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const existing = await db.findSkillById(id, projectId);
    if (!existing) return null;

    return db.updateSkill(id, {
        title: updates.title,
        header: updates.header,
        body: updates.body,
        minModelTier: updates.minModelTier === null ? undefined : (updates.minModelTier ?? existing.minModelTier),
        status: updates.status,
        updatedBy: userId,
    });
}

export async function deleteSkill(tenantDbName: string, projectId: string, id: string): Promise<boolean> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const existing = await db.findSkillById(id, projectId);
    if (!existing) return false;
    return db.deleteSkill(id);
}
