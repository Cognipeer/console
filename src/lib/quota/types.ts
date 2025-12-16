import type { LicenseType } from '@/lib/license/license-manager';

// Scopes: from general to specific
export type QuotaScope = 'tenant' | 'user' | 'token' | 'resource' | 'provider';

// Domains: service areas
export type QuotaDomain = 'global' | 'llm' | 'embedding' | 'vector' | 'file' | 'tracing';

// Human-readable labels for UI
export const QUOTA_SCOPE_LABELS: Record<QuotaScope, string> = {
  tenant: 'Tenant',
  user: 'User',
  token: 'API Token',
  resource: 'Resource',
  provider: 'Provider',
};

export const QUOTA_DOMAIN_LABELS: Record<QuotaDomain, string> = {
  global: 'Global',
  llm: 'LLM / Chat',
  embedding: 'Embeddings',
  vector: 'Vector Store',
  file: 'Files',
  tracing: 'Agent Tracing',
};

export interface QuotaRequestWindow {
  perSecond?: number;
  perMinute?: number;
  perHour?: number;
  perDay?: number;
  perMonth?: number;
}

export interface QuotaRateLimit {
  requests?: QuotaRequestWindow;
  tokens?: QuotaRequestWindow;
  vectors?: QuotaRequestWindow;
  files?: QuotaRequestWindow;
  storage?: QuotaRequestWindow;
}

export interface QuotaPerRequestLimits {
  // LLM / Embedding
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  
  // Vector
  maxVectorsPerUpsert?: number;
  maxQueryResults?: number;
  maxDimensions?: number;
  
  // File
  maxFileSize?: number;
  maxFilesPerRequest?: number;
  
  // Tracing
  maxEventsPerSession?: number;
  maxSessionDurationMs?: number;
  
  // General
  maxConcurrentRequests?: number;
}

export interface QuotaResourceCaps {
  // Models
  maxModels?: number;
  
  // Vector
  maxVectorIndexes?: number;
  maxVectorsTotal?: number;
  
  // Files
  maxFileBuckets?: number;
  maxStorageBytes?: number;
  maxFilesTotal?: number;
  
  // Tracing
  maxTracingSessions?: number;
  maxTracingRetentionDays?: number;
  
  // Users/Tokens
  maxApiTokens?: number;
  maxUsers?: number;
  maxAgents?: number;
}

export interface QuotaBudget {
  dailySpendLimit?: number;
  monthlySpendLimit?: number;
  alertThresholds?: number[];
}

export interface QuotaLimits {
  rateLimit?: QuotaRateLimit;
  perRequest?: QuotaPerRequestLimits;
  quotas?: QuotaResourceCaps;
  budget?: QuotaBudget;
}

export interface PlanQuotaLimits extends QuotaResourceCaps {
  requestsPerMonth?: number;
}

export interface PlanLimitsConfig {
  plans: Record<LicenseType, PlanQuotaLimits>;
}

export interface QuotaPolicy {
  _id?: string;
  tenantId: string;
  projectId?: string;
  scope: QuotaScope;
  scopeId?: string;
  domain: QuotaDomain;
  priority: number;
  limits: QuotaLimits;
  enabled: boolean;
  label?: string;
  description?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface QuotaPolicyInput extends Omit<QuotaPolicy, '_id' | 'tenantId' | 'createdAt' | 'updatedAt'> {}
