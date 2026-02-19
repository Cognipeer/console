export interface PromptView {
	id: string;
	tenantId?: string;
	projectId?: string;
	key: string;
	name: string;
	description?: string;
	template: string;
	metadata?: Record<string, unknown>;
	currentVersion?: number;
	createdBy?: string;
	updatedBy?: string;
	createdAt?: string | Date;
	updatedAt?: string | Date;
	deployments?: Partial<Record<PromptEnvironment, PromptDeploymentStateView>>;
	deploymentHistory?: PromptDeploymentEventView[];
}

export type PromptEnvironment = 'dev' | 'staging' | 'prod';

export type PromptDeploymentAction = 'promote' | 'plan' | 'activate' | 'rollback';

export interface PromptDeploymentStateView {
	environment: PromptEnvironment;
	versionId: string;
	version: number;
	rolloutStatus: 'planned' | 'active';
	rolloutStrategy: 'manual';
	rollbackVersionId?: string;
	rollbackVersion?: number;
	note?: string;
	updatedBy?: string;
	updatedAt?: string | Date;
}

export interface PromptDeploymentEventView {
	id: string;
	environment: PromptEnvironment;
	action: PromptDeploymentAction;
	versionId: string;
	version: number;
	note?: string;
	createdBy?: string;
	createdAt?: string | Date;
}

export interface PromptVersionView {
	id: string;
	promptId?: string;
	version: number;
	name: string;
	description?: string;
	template: string;
	metadata?: Record<string, unknown>;
	comment?: string;
	createdBy?: string;
	createdAt?: string | Date;
	isLatest?: boolean;
}

export interface CreatePromptInput {
	name: string;
	key?: string;
	description?: string;
	template: string;
	metadata?: Record<string, unknown>;
	versionComment?: string;
}

export interface UpdatePromptInput {
	name?: string;
	description?: string;
	template?: string;
	metadata?: Record<string, unknown>;
	versionComment?: string;
}

export interface PromptDeploymentInput {
	environment: PromptEnvironment;
	versionId: string;
	note?: string;
}

export interface PromptDeploymentPlanInput {
	environment: PromptEnvironment;
	note?: string;
}

export interface PromptCompareView {
	fromVersion: PromptVersionView;
	toVersion: PromptVersionView;
	templateDiff: Array<{
		type: 'added' | 'removed' | 'unchanged';
		line: string;
	}>;
	metadataDiff: Array<{
		key: string;
		fromValue: unknown;
		toValue: unknown;
		changed: boolean;
	}>;
	deploymentHistory: PromptDeploymentEventView[];
	comments: PromptCommentView[];
}

export interface ListPromptsOptions {
	search?: string;
}

export interface PromptCommentView {
	id: string;
	promptId: string;
	versionId?: string;
	version?: number;
	content: string;
	createdBy?: string;
	createdByName?: string;
	createdAt?: string | Date;
	updatedAt?: string | Date;
}

export interface CreateCommentInput {
	content: string;
	versionId?: string;
	version?: number;
}
