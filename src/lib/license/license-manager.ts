import fs from 'node:fs';
import { decodeProtectedHeader, importSPKI, jwtVerify, type JWTPayload } from 'jose';
import { getConfig } from '@/lib/core/config';
import type { ITenant } from '@/lib/database';
import type { QuotaLimits, QuotaResourceCaps } from '@/lib/quota/types';
import policies from '@/config/policies.json';

export interface FeaturePolicy {
  name: string;
  description: string;
  endpoints: string[];
  /**
   * When true this feature only resolves for an active ENTERPRISE license.
   * FREE (and any non-ENTERPRISE) license never receives it. PII is NEVER
   * gated regardless of this flag — see `isAlwaysFreeFeature`.
   */
  requiresEnterprise?: boolean;
}

export interface LicensePolicy {
  name: string;
  features?: string[];
  limits: {
    requestsPerMonth: number;
    maxAgents: number;
  };
}

export type LicenseType =
  | 'FREE'
  | 'STARTER'
  | 'PROFESSIONAL'
  | 'ENTERPRISE'
  | 'ON_PREMISE';

export type OfflineLicenseLimits = Pick<QuotaResourceCaps, 'maxProjects'>;

export interface OfflineLicensePayload extends JWTPayload {
  licenseId: string;
  licenseType: LicenseType;
  customerName?: string;
  tenantId?: string;
  tenantSlug?: string;
  features?: string[];
  limits?: OfflineLicenseLimits;
}

export interface EffectiveLicense {
  licenseId: string;
  licenseType: LicenseType;
  status: 'free' | 'active' | 'expired' | 'invalid';
  source: 'free' | 'offline';
  features: string[];
  limits: OfflineLicenseLimits;
  payload?: OfflineLicensePayload;
  expiresAt?: Date;
  error?: string;
}

const FREE_PROJECT_LIMIT = 2;
const ALLOWED_LICENSE_ALGORITHMS = new Set(['EdDSA', 'ES256', 'RS256', 'PS256']);

const endpointRegexCache = new Map<string, RegExp>();

function getEndpointRegex(pattern: string): RegExp {
  let regex = endpointRegexCache.get(pattern);
  if (!regex) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(`^${escaped.replace(/\\\*/g, '.*')}$`);
    endpointRegexCache.set(pattern, regex);
  }
  return regex;
}

function normalizePublicKey(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}

function isLicenseType(value: unknown): value is LicenseType {
  return (
    value === 'FREE'
    || value === 'STARTER'
    || value === 'PROFESSIONAL'
    || value === 'ENTERPRISE'
    || value === 'ON_PREMISE'
  );
}

/**
 * Two-tier gating: only an active ENTERPRISE license unlocks enterprise
 * features/modules. Legacy STARTER/PROFESSIONAL/ON_PREMISE values are treated
 * as FREE (see ARCHITECTURE.md §1).
 */
export function isEnterpriseLicenseType(value: unknown): boolean {
  return value === 'ENTERPRISE';
}

/**
 * Features that must ALWAYS be available regardless of tier. PII handling is
 * never license-gated (compliance/safety must not depend on a paid plan).
 */
function isAlwaysFreeFeature(featureKey: string): boolean {
  return featureKey.startsWith('PII');
}

function normalizeFeatureList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean),
  )];
}

function normalizeLimits(value: unknown): OfflineLicenseLimits | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const quotas = raw.quotas && typeof raw.quotas === 'object' && !Array.isArray(raw.quotas)
    ? raw.quotas as Record<string, unknown>
    : undefined;

  const maxProjects = quotas?.maxProjects ?? raw.maxProjects;
  if (typeof maxProjects !== 'number' || !Number.isFinite(maxProjects)) {
    return undefined;
  }

  return { maxProjects };
}

function mergeLicenseLimits(
  base: OfflineLicenseLimits,
  override?: OfflineLicenseLimits,
): OfflineLicenseLimits {
  if (!override || override.maxProjects === undefined) {
    return base;
  }

  return {
    ...base,
    maxProjects: override.maxProjects,
  };
}

function toQuotaLimits(limits: OfflineLicenseLimits): QuotaLimits {
  return {
    quotas: {
      maxProjects: limits.maxProjects,
    },
  };
}

export class LicenseManager {
  private static policyConfig = policies;

  private static getFreeLimits(): OfflineLicenseLimits {
    return {
      maxProjects: FREE_PROJECT_LIMIT,
    };
  }

  private static getPublicKeyPem(): string | null {
    const cfg = getConfig().license;
    if (cfg.offlinePublicKey) {
      return normalizePublicKey(cfg.offlinePublicKey);
    }
    if (!cfg.offlinePublicKeyPath) {
      return null;
    }
    return fs.readFileSync(cfg.offlinePublicKeyPath, 'utf8').trim();
  }

  private static getAllFeatureKeys(): string[] {
    return Object.keys(this.policyConfig.features);
  }

  static getFeaturesForLicense(licenseType: LicenseType): string[] {
    if (!this.policyConfig.licenses[licenseType]) {
      return [];
    }
    const enterprise = isEnterpriseLicenseType(licenseType);
    return this.getAllFeatureKeys().filter((key) => {
      if (enterprise || isAlwaysFreeFeature(key)) {
        return true;
      }
      const feature = this.policyConfig.features[
        key as keyof typeof this.policyConfig.features
      ] as FeaturePolicy | undefined;
      return !feature?.requiresEnterprise;
    });
  }

  static getDefaultFreeLicense(): EffectiveLicense {
    return {
      features: this.getFeaturesForLicense('FREE'),
      licenseId: 'FREE',
      licenseType: 'FREE',
      limits: this.getFreeLimits(),
      source: 'free',
      status: 'free',
    };
  }

  static getEffectiveLicenseForTenant(tenant: Pick<
    ITenant,
    | '_id'
    | 'licenseError'
    | 'licenseExpiresAt'
    | 'licenseId'
    | 'licensePayload'
    | 'licenseStatus'
    | 'licenseType'
  > | null | undefined): EffectiveLicense {
    if (!tenant || tenant.licenseStatus !== 'active' || !tenant.licensePayload) {
      return this.getDefaultFreeLicense();
    }

    const payload = tenant.licensePayload as OfflineLicensePayload;
    const licenseType = isLicenseType(payload.licenseType)
      ? payload.licenseType
      : 'FREE';
    const features = this.getFeaturesForLicense(licenseType);
    const limits = mergeLicenseLimits(
      this.getFreeLimits(),
      normalizeLimits(payload.limits),
    );
    const expiresAt = tenant.licenseExpiresAt
      ?? (typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : undefined);

    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return {
        ...this.getDefaultFreeLicense(),
        error: 'License has expired',
        status: 'expired',
      };
    }

    return {
      expiresAt,
      features,
      licenseId: tenant.licenseId || payload.licenseId,
      licenseType,
      limits,
      payload,
      source: 'offline',
      status: 'active',
    };
  }

  static getQuotaLimitsForTenant(tenant: ITenant | null | undefined): QuotaLimits {
    return toQuotaLimits(this.getEffectiveLicenseForTenant(tenant).limits);
  }

  static async verifyOfflineLicenseKey(
    licenseKey: string,
    tenant: Pick<ITenant, '_id' | 'slug'>,
  ): Promise<EffectiveLicense> {
    const key = licenseKey.trim();
    if (!key) {
      throw new Error('License key is required');
    }

    const publicKeyPem = this.getPublicKeyPem();
    if (!publicKeyPem) {
      throw new Error('Offline license public key is not configured');
    }

    const header = decodeProtectedHeader(key);
    if (!header.alg || !ALLOWED_LICENSE_ALGORITHMS.has(header.alg)) {
      throw new Error('Unsupported license signature algorithm');
    }

    const publicKey = await importSPKI(publicKeyPem, header.alg);
    const cfg = getConfig().license;
    const verifyOptions = {
      audience: cfg.audience || undefined,
      issuer: cfg.issuer || undefined,
    };
    const { payload } = await jwtVerify(key, publicKey, verifyOptions);

    if (!payload.licenseId || typeof payload.licenseId !== 'string') {
      throw new Error('License payload is missing licenseId');
    }
    if (!isLicenseType(payload.licenseType)) {
      throw new Error('License payload has an invalid licenseType');
    }

    const tenantId = typeof tenant._id === 'string' ? tenant._id : tenant._id?.toString();
    const payloadTenantId = typeof payload.tenantId === 'string' ? payload.tenantId : undefined;
    const payloadTenantSlug = typeof payload.tenantSlug === 'string' ? payload.tenantSlug : undefined;

    if (!payloadTenantId && !payloadTenantSlug) {
      throw new Error('License is not bound to a tenant');
    }
    if (payloadTenantId && tenantId && payloadTenantId !== tenantId) {
      throw new Error('License tenant id does not match this tenant');
    }
    if (payloadTenantSlug && payloadTenantSlug !== tenant.slug) {
      throw new Error('License tenant slug does not match this tenant');
    }

    const normalizedPayload: OfflineLicensePayload = {
      ...payload,
      features: normalizeFeatureList(payload.features),
      licenseId: payload.licenseId,
      licenseType: payload.licenseType,
      limits: normalizeLimits(payload.limits),
    };

    return {
      expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : undefined,
      features: this.getFeaturesForLicense(normalizedPayload.licenseType),
      licenseId: normalizedPayload.licenseId,
      licenseType: normalizedPayload.licenseType,
      limits: mergeLicenseLimits(this.getFreeLimits(), normalizedPayload.limits),
      payload: normalizedPayload,
      source: 'offline',
      status: 'active',
    };
  }

  static hasFeature(licenseType: LicenseType, featureKey: string): boolean {
    return this.getFeaturesForLicense(licenseType).includes(featureKey);
  }

  static hasEndpointAccess(
    licenseType: LicenseType,
    endpoint: string,
  ): boolean {
    return this.hasEndpointAccessForFeatures(
      this.getFeaturesForLicense(licenseType),
      endpoint,
    );
  }

  static hasEndpointAccessForFeatures(
    _features: string[] | undefined,
    endpoint: string,
  ): boolean {
    for (const featureKey of this.getAllFeatureKeys()) {
      const feature =
        this.policyConfig.features[
        featureKey as keyof typeof this.policyConfig.features
        ];
      if (!feature) continue;

      for (const pattern of feature.endpoints) {
        if (this.matchEndpoint(endpoint, pattern)) {
          return true;
        }
      }
    }

    return false;
  }

  private static matchEndpoint(endpoint: string, pattern: string): boolean {
    if (pattern === endpoint) return true;

    if (pattern.includes('*')) {
      return getEndpointRegex(pattern).test(endpoint);
    }

    return false;
  }

  static getFeatureDetails(licenseType: LicenseType): FeaturePolicy[] {
    const featureKeys = this.getFeaturesForLicense(licenseType);
    return featureKeys
      .map(
        (key) =>
          this.policyConfig.features[key as keyof typeof this.policyConfig.features],
      )
      .filter(Boolean) as FeaturePolicy[];
  }

  static getLimits(): OfflineLicenseLimits {
    return this.getFreeLimits();
  }

  static getAllLicenses(): Record<LicenseType, LicensePolicy> {
    return this.policyConfig.licenses as Record<LicenseType, LicensePolicy>;
  }

  static getAllFeatures(): Record<string, FeaturePolicy> {
    return this.policyConfig.features as Record<string, FeaturePolicy>;
  }

  /**
   * Runtime gate helper. True when the license is an active ENTERPRISE license
   * that has not passed its expiry + grace window. Used by the API guard.
   * `expiresAt` of `undefined` = perpetual.
   */
  static isEnterpriseActive(
    licenseType: LicenseType | string | undefined,
    expiresAt?: Date | string | number | null,
  ): boolean {
    if (!isEnterpriseLicenseType(licenseType)) {
      return false;
    }
    if (expiresAt === undefined || expiresAt === null) {
      return true;
    }
    const expiryMs = expiresAt instanceof Date
      ? expiresAt.getTime()
      : typeof expiresAt === 'number'
        ? expiresAt
        : Date.parse(expiresAt);
    if (Number.isNaN(expiryMs)) {
      return true;
    }
    const graceMs = Math.max(0, getConfig().license.graceDays) * 86_400_000;
    return Date.now() <= expiryMs + graceMs;
  }
}
