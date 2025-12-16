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

export class LicenseManager {
  private static policies = policies;

  /**
   * Get features for a specific license type
   */
  static getFeaturesForLicense(licenseType: LicenseType): string[] {
    const license = this.policies.licenses[licenseType];
    
    return license?.features || [];
  }

  /**
   * Check if a license has access to a specific feature
   */
  static hasFeature(licenseType: LicenseType, featureKey: string): boolean {
    const features = this.getFeaturesForLicense(licenseType);
    return features.includes(featureKey);
  }

  /**
   * Check if a license has access to a specific endpoint
   */
  static hasEndpointAccess(
    licenseType: LicenseType,
    endpoint: string,
  ): boolean {
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
   * Match endpoint with wildcard pattern
   */
  private static matchEndpoint(endpoint: string, pattern: string): boolean {
    if (pattern === endpoint) return true;

    if (pattern.includes('*')) {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escaped.replace(/\\\*/g, '.*')}$`);
      return regex.test(endpoint);
    }

    return false;
  }

  /**
   * Get all feature details for a license
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
   * Get license limits
   */
  static getLimits(licenseType: LicenseType) {
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
