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
