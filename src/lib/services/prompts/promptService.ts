import slugify from 'slugify';
import { getDatabase, type IPrompt, type IPromptVersion, type IPromptComment } from '@/lib/database';
import type {
	CreateCommentInput,
	CreatePromptInput,
	ListPromptsOptions,
	PromptCommentView,
	PromptVersionView,
	PromptView,
	UpdatePromptInput,
} from './types';

const SLUG_OPTIONS = {
	lower: true,
	strict: true,
	trim: true,
};

const MAX_KEY_ATTEMPTS = 50;

function normalizeKeyCandidate(input: string): string {
	const fallback = input?.trim().length ? input.trim() : 'prompt';
	return slugify(fallback, SLUG_OPTIONS);
}

function serializePrompt(record: IPrompt): PromptView {
	const { _id, ...rest } = record;
	return {
		...rest,
		id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
	} satisfies PromptView;
}

function serializeVersion(
	record: IPromptVersion,
	latestVersion?: number,
): PromptVersionView {
	const { _id, ...rest } = record;
	return {
		...rest,
		id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
		isLatest: latestVersion !== undefined ? record.version === latestVersion : undefined,
	} satisfies PromptVersionView;
}

async function generateUniqueKey(
	tenantDbName: string,
	projectId: string,
	desiredKey: string,
): Promise<string> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

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
	options?: ListPromptsOptions,
): Promise<PromptView[]> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const prompts = await db.listPrompts({
		projectId,
		search: options?.search,
	});

	return prompts.map((prompt) => serializePrompt(prompt));
}

export async function getPromptById(
	tenantDbName: string,
	projectId: string,
	id: string,
): Promise<PromptView | null> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const prompt = await db.findPromptById(id, projectId);
	return prompt ? serializePrompt(prompt) : null;
}

export async function getPromptByKey(
	tenantDbName: string,
	projectId: string,
	key: string,
): Promise<PromptView | null> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const prompt = await db.findPromptByKey(key, projectId);
	return prompt ? serializePrompt(prompt) : null;
}

export async function createPrompt(
	tenantDbName: string,
	tenantId: string,
	projectId: string,
	userId: string,
	payload: CreatePromptInput,
): Promise<PromptView> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const keyCandidate = payload.key || payload.name;
	const key = await generateUniqueKey(tenantDbName, projectId, keyCandidate);

	const newPrompt: Omit<IPrompt, '_id' | 'createdAt' | 'updatedAt'> = {
		tenantId,
		projectId,
		key,
		name: payload.name,
		description: payload.description,
		template: payload.template,
		metadata: payload.metadata ?? {},
		currentVersion: 1,
		createdBy: userId,
		updatedBy: userId,
	};

	const created = await db.createPrompt(newPrompt);
	const promptId = typeof created._id === 'string'
		? created._id
		: (created._id?.toString() ?? '');

	await db.createPromptVersion({
		tenantId,
		projectId,
		promptId,
		version: 1,
		name: created.name,
		description: created.description,
		template: created.template,
		metadata: created.metadata ?? {},
		comment: payload.versionComment,
		createdBy: userId,
	});

	return serializePrompt(created);
}

export async function updatePrompt(
	tenantDbName: string,
	projectId: string,
	id: string,
	updates: UpdatePromptInput & { updatedBy?: string },
): Promise<PromptView | null> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const existing = await db.findPromptById(id, projectId);
	if (!existing) {
		return null;
	}

	const nextVersion = (existing.currentVersion ?? 1) + 1;
	const updatedPrompt = await db.updatePrompt(id, {
		name: updates.name ?? existing.name,
		description: updates.description ?? existing.description,
		template: updates.template ?? existing.template,
		metadata: updates.metadata ?? existing.metadata,
		currentVersion: nextVersion,
		updatedBy: updates.updatedBy,
	});

	if (!updatedPrompt) {
		return null;
	}

	await db.createPromptVersion({
		tenantId: existing.tenantId,
		projectId: existing.projectId,
		promptId: id,
		version: nextVersion,
		name: updates.name ?? existing.name,
		description: updates.description ?? existing.description,
		template: updates.template ?? existing.template,
		metadata: updates.metadata ?? existing.metadata ?? {},
		comment: updates.versionComment,
		createdBy: updates.updatedBy ?? existing.updatedBy ?? existing.createdBy,
	});

	return serializePrompt(updatedPrompt);
}

export async function deletePrompt(
	tenantDbName: string,
	projectId: string,
	id: string,
): Promise<boolean> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	await db.deletePromptVersions(id, projectId);
	return db.deletePrompt(id);
}

export async function listPromptVersions(
	tenantDbName: string,
	projectId: string,
	promptId: string,
): Promise<PromptVersionView[]> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const prompt = await db.findPromptById(promptId, projectId);
	if (!prompt) {
		return [];
	}

	const versions = await db.listPromptVersions(promptId, projectId);
	return versions.map((version) => serializeVersion(version, prompt.currentVersion));
}

export async function setPromptLatestVersion(
	tenantDbName: string,
	projectId: string,
	promptId: string,
	versionId: string,
	userId: string,
): Promise<PromptView | null> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const version = await db.findPromptVersionById(versionId, promptId, projectId);
	if (!version) {
		return null;
	}

	const updated = await db.updatePrompt(promptId, {
		name: version.name,
		description: version.description,
		template: version.template,
		metadata: version.metadata,
		currentVersion: version.version,
		updatedBy: userId,
	});

	return updated ? serializePrompt(updated) : null;
}

// Comment functions
function serializeComment(record: IPromptComment): PromptCommentView {
	const { _id, ...rest } = record;
	return {
		...rest,
		id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
	} satisfies PromptCommentView;
}

export async function createPromptComment(
	tenantDbName: string,
	tenantId: string,
	projectId: string,
	promptId: string,
	userId: string,
	userName: string,
	input: CreateCommentInput,
): Promise<PromptCommentView> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const comment = await db.createPromptComment({
		tenantId,
		projectId,
		promptId,
		versionId: input.versionId,
		version: input.version,
		content: input.content,
		createdBy: userId,
		createdByName: userName,
	});

	return serializeComment(comment);
}

export async function listPromptComments(
	tenantDbName: string,
	projectId: string,
	promptId: string,
	versionId?: string,
): Promise<PromptCommentView[]> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const comments = await db.listPromptComments(promptId, { versionId, projectId });
	return comments.map(serializeComment);
}

export async function deletePromptComment(
	tenantDbName: string,
	commentId: string,
): Promise<boolean> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	return db.deletePromptComment(commentId);
}
