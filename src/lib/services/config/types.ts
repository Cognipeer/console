import type {
  IConfigGroup,
  IConfigItem,
  IConfigAuditLog,
  ConfigValueType,
} from '@/lib/database';

// ── Re-exports ───────────────────────────────────────────────────────────
export type { IConfigGroup, IConfigItem, IConfigAuditLog, ConfigValueType };

// ── Service-level types ──────────────────────────────────────────────────

// ── Group types ──────────────────────────────────────────────────────────

export interface CreateConfigGroupRequest {
  key?: string;
  name: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateConfigGroupRequest {
  name?: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  updatedBy: string;
}

// ── Item types ───────────────────────────────────────────────────────────

export interface CreateConfigItemRequest {
  key?: string;
  name: string;
  description?: string;
  value: string;
  valueType?: ConfigValueType;
  isSecret?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateConfigItemRequest {
  name?: string;
  description?: string;
  value?: string;
  valueType?: ConfigValueType;
  isSecret?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
  updatedBy: string;
}

export interface ConfigItemView extends Omit<IConfigItem, 'value'> {
  /** For secrets, value is masked. For non-secrets, actual value. */
  value: string;
}

// ── Resolve types ────────────────────────────────────────────────────────

export interface ResolveConfigRequest {
  keys: string[];
}

export interface ResolvedConfigMap {
  [key: string]: {
    value: string;
    valueType: ConfigValueType;
    version: number;
  };
}

// ── Aggregated group view (group + items) ────────────────────────────────

export interface ConfigGroupView extends IConfigGroup {
  items: ConfigItemView[];
}
