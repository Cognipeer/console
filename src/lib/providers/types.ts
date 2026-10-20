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
  /**
   * Show this field only while another field of the same form holds one of the given values (an Azure Blob
   * credential belongs to one authentication method, for example). Presentation only: the runtime ignores the values
   * of fields that do not apply, and the server does not evaluate this.
   */
  visibleWhen?: { field: string; equals: string | string[] };
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
  projectId?: string;
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
  /**
   * Strict check of what is about to be saved or tested. The provider service calls it on create and on update
   * (with the credentials and settings the update will store: blank secrets keep the stored ones, settings replace
   * the stored ones), and "Test connection" calls it before it creates a runtime. Throw `ProviderSettingsError` to
   * refuse; the entry points answer 400 `{ error, code, field }`.
   *
   * Save-time only: `createRuntime` stays lenient for rows that are already stored.
   */
  validateSettings?(input: {
    credentials: TCredentials;
    settings: TSettings;
    /** `getConfig().deployment.isOnPrem`: some options are self-hosted only. */
    isOnPrem: boolean;
    /**
     * The organization the provider belongs to. A driver that vets the endpoints in its settings reads the private
     * networks opened for this organization; without it none are opened.
     */
    tenantId?: string;
    /**
     * Set when the person saving the provider administers providers (an owner or an admin), who may name directories
     * of this server: the base directory of the local disk driver. The route sets it from the caller's role, never from
     * a request body. A driver that takes no such setting ignores it.
     */
    allowHostPaths?: boolean;
  }): void | Promise<void>;
  /**
   * File providers only: where this provider's objects live, for display (for example
   * `s3://archive/console/<tenantId>/<providerKey>/`). Built from settings alone, never from credentials, and ends at
   * the runtime's base prefix with a trailing '/'; the Files service appends the bucket prefix. Return null when
   * there is nothing meaningful to show (the server's own disk).
   */
  describeStorageLocation?(input: { settings: TSettings; tenantId: string; providerKey: string }): string | null;
}

export interface ProviderDescriptor {
  id: string;
  version: string;
  domains: ProviderDomain[];
  display: ProviderDisplayConfig;
  capabilities?: ProviderCapabilityFlags;
}

export type LooseProviderContract = ProviderContract<unknown, unknown, unknown>;
