import { getConfig } from '@/lib/core/config';
import policies from '@/config/policies.json';

export interface FeaturePolicy {
  name: string;
  description: string;
  endpoints: string[];
}

export interface LicensePolicy {
  name: string;
  features: string[];
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

/**
 * Compiled regex cache for endpoint patterns – avoids re-compiling on every request.
 */
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

export class LicenseManager {
  private static policies = policies;

  /**
   * On-premise / self-hosted deployments get unrestricted access by default.
   * Override with ENFORCE_LICENSE=true to enable license checks even on-prem.
   */
  private static isUnrestrictedLicense(licenseType: LicenseType): boolean {
    return licenseType === 'ON_PREMISE' && !getConfig().license.enforceLicense;
  }

  /**
   * Get features for a specific license type.
   * On-prem: returns ALL features when unrestricted.
   */
  static getFeaturesForLicense(licenseType: LicenseType): string[] {
    if (this.isUnrestrictedLicense(licenseType)) {
      return Object.keys(this.policies.features);
    }
    const license = this.policies.licenses[licenseType];
    return license?.features || [];
  }

  /**
   * Check if a license has access to a specific feature.
   * On-prem: always true when unrestricted.
   */
  static hasFeature(licenseType: LicenseType, featureKey: string): boolean {
    if (this.isUnrestrictedLicense(licenseType)) {
      return true;
    }
    const features = this.getFeaturesForLicense(licenseType);
    return features.includes(featureKey);
  }

  /**
   * Check if a license has access to a specific endpoint.
   * On-prem: always true when unrestricted.
   */
  static hasEndpointAccess(
    licenseType: LicenseType,
    endpoint: string,
  ): boolean {
    if (this.isUnrestrictedLicense(licenseType)) {
      return true;
    }

    const features = this.getFeaturesForLicense(licenseType);

    for (const featureKey of features) {
      const feature =
        this.policies.features[
        featureKey as keyof typeof this.policies.features
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

  /**
   * Match endpoint with wildcard pattern (uses cached regex).
   */
  private static matchEndpoint(endpoint: string, pattern: string): boolean {
    if (pattern === endpoint) return true;

    if (pattern.includes('*')) {
      return getEndpointRegex(pattern).test(endpoint);
    }

    return false;
  }

  /**
   * Get all feature details for a license.
   */
  static getFeatureDetails(licenseType: LicenseType): FeaturePolicy[] {
    const featureKeys = this.getFeaturesForLicense(licenseType);
    return featureKeys
      .map(
        (key) =>
          this.policies.features[key as keyof typeof this.policies.features],
      )
      .filter(Boolean) as FeaturePolicy[];
  }

  /**
   * Get license limits.
   * On-prem: returns unlimited when unrestricted.
   */
  static getLimits(licenseType: LicenseType) {
    if (this.isUnrestrictedLicense(licenseType)) {
      return { requestsPerMonth: Infinity, maxAgents: Infinity };
    }
    const license = this.policies.licenses[licenseType];
    return license?.limits || { requestsPerMonth: 0, maxAgents: 0 };
  }

  /**
   * Get all available license types
   */
  static getAllLicenses(): Record<LicenseType, LicensePolicy> {
    return this.policies.licenses as Record<LicenseType, LicensePolicy>;
  }

  /**
   * Get all available features
   */
  static getAllFeatures(): Record<string, FeaturePolicy> {
    return this.policies.features as Record<string, FeaturePolicy>;
  }
}
