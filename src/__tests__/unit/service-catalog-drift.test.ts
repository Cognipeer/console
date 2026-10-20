/**
 * The Add Provider picker is driven by `service-catalog.json`, the drivers by the provider registry. Nothing
 * ties the two together at build time, so this keeps them honest: every catalog entry must name a driver the
 * registry knows, and every domain an entry advertises must be one that driver serves.
 */
import { describe, expect, it } from 'vitest';
import { providerRegistry } from '@/lib/providers';
import { SERVICE_CATALOG } from '@/lib/services/serviceCatalog';

describe('service catalog and provider registry', () => {
  it('has a registered driver behind every catalog entry', () => {
    const missing = SERVICE_CATALOG.filter((entry) => {
      try {
        providerRegistry.getContract(entry.driver);
        return false;
      } catch {
        return true;
      }
    }).map((entry) => `${entry.id} -> ${entry.driver}`);
    expect(missing).toEqual([]);
  });

  it('only advertises domains the driver serves', () => {
    const mismatched = SERVICE_CATALOG.flatMap((entry) => {
      const contract = providerRegistry.getContract(entry.driver);
      const unserved = entry.domains.filter((domain) => !contract.domains.includes(domain));
      return unserved.length > 0 ? [`${entry.id} (${entry.driver}): ${unserved.join(', ')}`] : [];
    });
    expect(mismatched).toEqual([]);
  });

  it('keeps catalog ids unique and aliases lower-case', () => {
    const ids = SERVICE_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const notLower = SERVICE_CATALOG.flatMap((entry) =>
      entry.aliases.filter((alias) => alias !== alias.toLowerCase()).map((alias) => `${entry.id}: ${alias}`),
    );
    expect(notLower).toEqual([]);
  });

  it('lists the S3-compatible card with its own driver, and no longer claims its names for Amazon S3', () => {
    const compatible = SERVICE_CATALOG.find((entry) => entry.id === 's3-compatible-files');
    expect(compatible?.driver).toBe('s3-compatible-files');
    expect(compatible?.domains).toEqual(['file']);
    expect(compatible?.aliases).toEqual(expect.arrayContaining(['minio', 's3-compatible']));

    const amazon = SERVICE_CATALOG.find((entry) => entry.id === 'aws-s3-files');
    expect(amazon?.aliases).toContain('s3');
    expect(amazon?.aliases).not.toContain('minio');
    expect(amazon?.aliases).not.toContain('s3-compatible');
  });
});
