import type { IPrompt, IPromptVersion } from '@/lib/database';

export interface PromptView extends Omit<IPrompt, '_id'> {
  id: string;
}

export interface PromptVersionView extends Omit<IPromptVersion, '_id'> {
  id: string;
}

export interface CreatePromptInput {
  name: string;
  key?: string;
  description?: string;
  template: string;
  metadata?: Record<string, unknown>;
}

export interface UpdatePromptInput {
  name?: string;
  description?: string;
  template?: string;
  metadata?: Record<string, unknown>;
  updatedBy?: string;
}

export interface RenderPromptInput {
  data?: Record<string, unknown>;
}

export interface RenderPromptResult {
  rendered: string;
}
