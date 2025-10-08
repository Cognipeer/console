import type { ProviderDomain } from '@/lib/database';

export type ProviderCapabilityValue =
  | boolean
  | string
  | number
  | string[]
  | number[]
  | Record<string, unknown>;

export type ProviderCapabilityFlags = Record<string, ProviderCapabilityValue>;

export type ProviderFormFieldType =
  | 'text'
  | 'password'
  | 'textarea'
  | 'number'
  | 'select'
  | 'switch';

export interface ProviderFormFieldOption {
  label: string;
  value: string;
  description?: string;
}

export interface ProviderFormField {
  name: string;
  label: string;
  type: ProviderFormFieldType;
  required?: boolean;
  placeholder?: string;
  description?: string;
  options?: ProviderFormFieldOption[];
  defaultValue?: unknown;
  scope?: 'credentials' | 'settings' | 'metadata';
}

export interface ProviderFormSection {
  title?: string;
  description?: string;
  fields: ProviderFormField[];
}

export interface ProviderFormSchema {
  sections: ProviderFormSection[];
}

export interface ProviderDisplayConfig {
  label: string;
  description?: string;
  icon?: string;
}

export interface ProviderContext<TCredentials = Record<string, unknown>, TSettings = Record<string, unknown>> {
  tenantId: string;
  tenantSlug?: string;
  providerKey: string;
  credentials: TCredentials;
  settings: TSettings;
  metadata?: Record<string, unknown>;
  logger?: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export interface ProviderContract<TRuntime = unknown, TCredentials = Record<string, unknown>, TSettings = Record<string, unknown>> {
  id: string;
  version: string;
  domains: ProviderDomain[];
  display: ProviderDisplayConfig;
  form: ProviderFormSchema;
  capabilities?: ProviderCapabilityFlags;
  createRuntime: (
    context: ProviderContext<TCredentials, TSettings>,
  ) => Promise<TRuntime> | TRuntime;
}

export interface ProviderDescriptor {
  id: string;
  version: string;
  domains: ProviderDomain[];
  display: ProviderDisplayConfig;
  capabilities?: ProviderCapabilityFlags;
}

export type LooseProviderContract = ProviderContract<any, any, any>;
