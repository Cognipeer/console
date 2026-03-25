import slugify from 'slugify';
import { randomUUID } from 'node:crypto';
import { getDatabase, type IPrompt, type IPromptVersion, type IPromptComment } from '@/lib/database';
import type {
	CreateCommentInput,
	CreatePromptInput,
	ListPromptsOptions,
	PromptCompareView,
	PromptCommentView,
	PromptDeploymentAction,
	PromptDeploymentEventView,
	PromptDeploymentInput,
	PromptDeploymentPlanInput,
	PromptDeploymentStateView,
	PromptEnvironment,
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
const DEPLOYMENT_ENVIRONMENTS: PromptEnvironment[] = ['dev', 'staging', 'prod'];

type PromptDeploymentStateRecord = Omit<PromptDeploymentStateView, 'updatedAt'> & {
	updatedAt?: Date;
};

type PromptDeploymentEventRecord = Omit<PromptDeploymentEventView, 'createdAt'> & {
	createdAt?: Date;
};

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

function serializeDeploymentEvent(
	event: PromptDeploymentEventRecord | PromptDeploymentEventView,
): PromptDeploymentEventView {
	return {
		...event,
		createdAt: event.createdAt,
	};
}

function appendDeploymentEvent(
	prompt: IPrompt,
	action: PromptDeploymentAction,
	environment: PromptEnvironment,
	versionId: string,
	version: number,
	userId: string,
	note?: string,
): PromptDeploymentEventRecord[] {
	const history = Array.isArray(prompt.deploymentHistory)
		? [...(prompt.deploymentHistory as PromptDeploymentEventRecord[])]
		: [];

	history.push({
		id: randomUUID(),
		environment,
		action,
		versionId,
		version,
		note,
		createdBy: userId,
		createdAt: new Date(),
	});

	return history;
}

function getVersionByNumber(versions: PromptVersionView[], version: number): PromptVersionView | null {
	return versions.find((item) => item.version === version) ?? null;
}

function buildTemplateDiff(fromTemplate: string, toTemplate: string): PromptCompareView['templateDiff'] {
	const fromLines = fromTemplate.split('\n');
	const toLines = toTemplate.split('\n');
	const max = Math.max(fromLines.length, toLines.length);
	const diff: PromptCompareView['templateDiff'] = [];

	for (let index = 0; index < max; index += 1) {
		const fromLine = fromLines[index];
		const toLine = toLines[index];

		if (fromLine === toLine && fromLine !== undefined) {
			diff.push({ type: 'unchanged', line: fromLine });
			continue;
		}

		if (fromLine !== undefined) {
			diff.push({ type: 'removed', line: fromLine });
		}

		if (toLine !== undefined) {
			diff.push({ type: 'added', line: toLine });
		}
	}

	return diff;
}

function buildMetadataDiff(
	fromMetadata?: Record<string, unknown>,
	toMetadata?: Record<string, unknown>,
): PromptCompareView['metadataDiff'] {
	const source = fromMetadata ?? {};
	const target = toMetadata ?? {};
	const keys = Array.from(new Set([...Object.keys(source), ...Object.keys(target)])).sort();

	return keys.map((key) => {
		const fromValue = source[key];
		const toValue = target[key];
		const changed = JSON.stringify(fromValue) !== JSON.stringify(toValue);

		return {
			key,
			fromValue,
			toValue,
			changed,
		};
	});
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

async function findPromptVersionOrNull(
	tenantDbName: string,
	projectId: string,
	promptId: string,
	versionId: string,
): Promise<PromptVersionView | null> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const version = await db.findPromptVersionById(versionId, promptId, projectId);
	return version ? serializeVersion(version) : null;
}

export async function listPromptDeployments(
	tenantDbName: string,
	projectId: string,
	promptId: string,
): Promise<{
	deployments: Partial<Record<PromptEnvironment, PromptDeploymentStateView>>;
	history: PromptDeploymentEventView[];
} | null> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const prompt = await db.findPromptById(promptId, projectId);
	if (!prompt) {
		return null;
	}

	const deploymentEntries = Object.entries(
		(prompt.deployments ?? {}) as Partial<Record<PromptEnvironment, PromptDeploymentStateRecord>>,
	) as Array<[PromptEnvironment, PromptDeploymentStateRecord]>;

	const deployments = deploymentEntries.reduce(
		(acc, [environment, state]) => {
			acc[environment] = {
				...state,
				updatedAt: state.updatedAt,
			};
			return acc;
		},
		{} as Partial<Record<PromptEnvironment, PromptDeploymentStateView>>,
	);

	const history = (prompt.deploymentHistory ?? [])
		.map((event) => serializeDeploymentEvent(event as PromptDeploymentEventRecord))
		.sort((left, right) => {
			const leftTs = left.createdAt ? new Date(left.createdAt).getTime() : 0;
			const rightTs = right.createdAt ? new Date(right.createdAt).getTime() : 0;
			return rightTs - leftTs;
		});

	return {
		deployments,
		history,
	};
}

export async function promotePromptVersion(
	tenantDbName: string,
	projectId: string,
	promptId: string,
	userId: string,
	input: PromptDeploymentInput,
): Promise<PromptView | null> {
	if (!DEPLOYMENT_ENVIRONMENTS.includes(input.environment)) {
		throw new Error('Invalid environment');
	}

	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const prompt = await db.findPromptById(promptId, projectId);
	if (!prompt) {
		return null;
	}

	const version = await db.findPromptVersionById(input.versionId, promptId, projectId);
	if (!version) {
		throw new Error('Version not found');
	}

	const deployments = {
		...(prompt.deployments ?? {}),
	} as Partial<Record<PromptEnvironment, PromptDeploymentStateRecord>>;
	const existing = deployments[input.environment];

	deployments[input.environment] = {
		environment: input.environment,
		versionId: typeof version._id === 'string' ? version._id : (version._id?.toString() ?? input.versionId),
		version: version.version,
		rolloutStatus: 'planned',
		rolloutStrategy: 'manual',
		rollbackVersionId:
			existing?.rolloutStatus === 'active' && existing.versionId !== input.versionId
				? existing.versionId
				: existing?.rollbackVersionId,
		rollbackVersion:
			existing?.rolloutStatus === 'active' && existing.versionId !== input.versionId
				? existing.version
				: existing?.rollbackVersion,
		note: input.note,
		updatedBy: userId,
		updatedAt: new Date(),
	};

	const deploymentHistory = appendDeploymentEvent(
		prompt,
		'promote',
		input.environment,
		deployments[input.environment]?.versionId ?? input.versionId,
		version.version,
		userId,
		input.note,
	);

	const updated = await db.updatePrompt(promptId, {
		deployments,
		deploymentHistory,
		updatedBy: userId,
	});

	return updated ? serializePrompt(updated) : null;
}

export async function planPromptDeployment(
	tenantDbName: string,
	projectId: string,
	promptId: string,
	userId: string,
	input: PromptDeploymentPlanInput,
): Promise<PromptView | null> {
	if (!DEPLOYMENT_ENVIRONMENTS.includes(input.environment)) {
		throw new Error('Invalid environment');
	}

	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const prompt = await db.findPromptById(promptId, projectId);
	if (!prompt) {
		return null;
	}

	const deployments = {
		...(prompt.deployments ?? {}),
	} as Partial<Record<PromptEnvironment, PromptDeploymentStateRecord>>;
	const environmentState = deployments[input.environment];

	if (!environmentState) {
		throw new Error('Promote a version before planning deployment');
	}

	deployments[input.environment] = {
		...environmentState,
		rolloutStatus: 'planned',
		rolloutStrategy: 'manual',
		note: input.note ?? environmentState.note,
		updatedBy: userId,
		updatedAt: new Date(),
	};

	const deploymentHistory = appendDeploymentEvent(
		prompt,
		'plan',
		input.environment,
		environmentState.versionId,
		environmentState.version,
		userId,
		input.note,
	);

	const updated = await db.updatePrompt(promptId, {
		deployments,
		deploymentHistory,
		updatedBy: userId,
	});

	return updated ? serializePrompt(updated) : null;
}

export async function activatePromptDeployment(
	tenantDbName: string,
	projectId: string,
	promptId: string,
	userId: string,
	environment: PromptEnvironment,
	note?: string,
): Promise<PromptView | null> {
	if (!DEPLOYMENT_ENVIRONMENTS.includes(environment)) {
		throw new Error('Invalid environment');
	}

	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const prompt = await db.findPromptById(promptId, projectId);
	if (!prompt) {
		return null;
	}

	const deployments = {
		...(prompt.deployments ?? {}),
	} as Partial<Record<PromptEnvironment, PromptDeploymentStateRecord>>;
	const environmentState = deployments[environment];

	if (!environmentState) {
		throw new Error('Promote a version before activation');
	}

	deployments[environment] = {
		...environmentState,
		rolloutStatus: 'active',
		note: note ?? environmentState.note,
		updatedBy: userId,
		updatedAt: new Date(),
	};

	const deploymentHistory = appendDeploymentEvent(
		prompt,
		'activate',
		environment,
		environmentState.versionId,
		environmentState.version,
		userId,
		note,
	);

	const updated = await db.updatePrompt(promptId, {
		deployments,
		deploymentHistory,
		updatedBy: userId,
	});

	return updated ? serializePrompt(updated) : null;
}

export async function rollbackPromptDeployment(
	tenantDbName: string,
	projectId: string,
	promptId: string,
	userId: string,
	environment: PromptEnvironment,
	note?: string,
): Promise<PromptView | null> {
	if (!DEPLOYMENT_ENVIRONMENTS.includes(environment)) {
		throw new Error('Invalid environment');
	}

	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const prompt = await db.findPromptById(promptId, projectId);
	if (!prompt) {
		return null;
	}

	const deployments = {
		...(prompt.deployments ?? {}),
	} as Partial<Record<PromptEnvironment, PromptDeploymentStateRecord>>;
	const environmentState = deployments[environment];

	if (!environmentState?.rollbackVersionId || !environmentState.rollbackVersion) {
		throw new Error('Rollback target not available for this environment');
	}

	const rollbackVersion = await findPromptVersionOrNull(
		tenantDbName,
		projectId,
		promptId,
		environmentState.rollbackVersionId,
	);

	if (!rollbackVersion) {
		throw new Error('Rollback version not found');
	}

	deployments[environment] = {
		...environmentState,
		versionId: rollbackVersion.id,
		version: rollbackVersion.version,
		rolloutStatus: 'active',
		rollbackVersionId: environmentState.versionId,
		rollbackVersion: environmentState.version,
		note: note ?? environmentState.note,
		updatedBy: userId,
		updatedAt: new Date(),
	};

	const deploymentHistory = appendDeploymentEvent(
		prompt,
		'rollback',
		environment,
		rollbackVersion.id,
		rollbackVersion.version,
		userId,
		note,
	);

	const updated = await db.updatePrompt(promptId, {
		deployments,
		deploymentHistory,
		updatedBy: userId,
	});

	return updated ? serializePrompt(updated) : null;
}

export async function comparePromptVersions(
	tenantDbName: string,
	projectId: string,
	promptId: string,
	fromVersionId: string,
	toVersionId: string,
): Promise<PromptCompareView | null> {
	const db = await getDatabase();
	await db.switchToTenant(tenantDbName);

	const prompt = await db.findPromptById(promptId, projectId);
	if (!prompt) {
		return null;
	}

	const [fromVersionRecord, toVersionRecord] = await Promise.all([
		db.findPromptVersionById(fromVersionId, promptId, projectId),
		db.findPromptVersionById(toVersionId, promptId, projectId),
	]);

	if (!fromVersionRecord || !toVersionRecord) {
		return null;
	}

	const fromVersion = serializeVersion(fromVersionRecord);
	const toVersion = serializeVersion(toVersionRecord);

	const comments = await db.listPromptComments(promptId, { projectId });
	const relatedComments = comments
		.filter((comment) => {
			const versionId = comment.versionId;
			if (versionId && (versionId === fromVersionId || versionId === toVersionId)) {
				return true;
			}

			return comment.version === fromVersion.version || comment.version === toVersion.version;
		})
		.map(serializeComment);

	const deploymentHistory = ((prompt.deploymentHistory ?? []) as PromptDeploymentEventRecord[])
		.filter((event) => event.versionId === fromVersionId || event.versionId === toVersionId)
		.map(serializeDeploymentEvent)
		.sort((left, right) => {
			const leftTs = left.createdAt ? new Date(left.createdAt).getTime() : 0;
			const rightTs = right.createdAt ? new Date(right.createdAt).getTime() : 0;
			return rightTs - leftTs;
		});

	return {
		fromVersion,
		toVersion,
		templateDiff: buildTemplateDiff(fromVersion.template, toVersion.template),
		metadataDiff: buildMetadataDiff(fromVersion.metadata, toVersion.metadata),
		deploymentHistory,
		comments: relatedComments,
	};
}

export async function resolvePromptForEnvironment(
	tenantDbName: string,
	projectId: string,
	key: string,
	environment?: PromptEnvironment,
	version?: number,
): Promise<{ prompt: PromptView; resolvedVersion: PromptVersionView | null } | null> {
	const prompt = await getPromptByKey(tenantDbName, projectId, key);
	if (!prompt) {
		return null;
	}

	const versions = await listPromptVersions(tenantDbName, projectId, prompt.id);

	let resolvedVersion: PromptVersionView | null = null;

	if (typeof version === 'number') {
		resolvedVersion = getVersionByNumber(versions, version);
	} else if (environment && prompt.deployments?.[environment]?.versionId) {
		resolvedVersion = versions.find((item) => item.id === prompt.deployments?.[environment]?.versionId) ?? null;
	} else if (typeof prompt.currentVersion === 'number') {
		resolvedVersion = getVersionByNumber(versions, prompt.currentVersion);
	}

	if (!resolvedVersion) {
		return { prompt, resolvedVersion: null };
	}

	return {
		prompt: {
			...prompt,
			name: resolvedVersion.name,
			description: resolvedVersion.description,
			template: resolvedVersion.template,
			metadata: resolvedVersion.metadata,
			currentVersion: resolvedVersion.version,
		},
		resolvedVersion,
	};
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
