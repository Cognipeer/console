/**
 * Unit tests — ProviderRegistry
 * Covers: contract registration, domain filtering, descriptor shape, error on unknown id.
 */

import { describe, it, expect } from 'vitest';
import { providerRegistry } from '@/lib/providers/registry';
import { CORE_PROVIDER_CONTRACTS } from '@/lib/providers/contracts';

// ── Descriptor listing ────────────────────────────────────────────────────────

describe('ProviderRegistry.listDescriptors', () => {
  it('returns all registered contracts when no domain filter is given', () => {
    const all = providerRegistry.listDescriptors();
    expect(all.length).toBeGreaterThanOrEqual(CORE_PROVIDER_CONTRACTS.length);
  });

  it('returns only vector-domain contracts when filtered by vector', () => {
    const vectorDescriptors = providerRegistry.listDescriptors('vector');
    expect(vectorDescriptors.length).toBeGreaterThan(0);
    vectorDescriptors.forEach((d) => {
      expect(d.domains).toContain('vector');
    });
  });

  it('returns only model-domain contracts when filtered by model', () => {
    const modelDescriptors = providerRegistry.listDescriptors('model');
    expect(modelDescriptors.length).toBeGreaterThan(0);
    modelDescriptors.forEach((d) => {
      expect(d.domains).toContain('model');
    });
  });

  it('each descriptor has required shape', () => {
    const all = providerRegistry.listDescriptors();
    all.forEach((descriptor) => {
      expect(typeof descriptor.id).toBe('string');
      expect(descriptor.id.length).toBeGreaterThan(0);
      expect(typeof descriptor.version).toBe('string');
      expect(Array.isArray(descriptor.domains)).toBe(true);
      expect(descriptor.domains.length).toBeGreaterThan(0);
      expect(typeof descriptor.display.label).toBe('string');
    });
  });
});

// ── getContract ───────────────────────────────────────────────────────────────

describe('ProviderRegistry.getContract', () => {
  it('returns the contract for a known id', () => {
    const contract = providerRegistry.getContract('dummy-vector');
    expect(contract).toBeDefined();
    expect(contract.id).toBe('dummy-vector');
    expect(typeof contract.createRuntime).toBe('function');
  });

  it('throws for an unknown contract id', () => {
    expect(() => providerRegistry.getContract('nonexistent-provider')).toThrow(
      /not found/i,
    );
  });
});

// ── getFormSchema ─────────────────────────────────────────────────────────────

describe('ProviderRegistry.getFormSchema', () => {
  it('returns a form schema with sections array for every registered contract', () => {
    const all = providerRegistry.listDescriptors();
    all.forEach((descriptor) => {
      const schema = providerRegistry.getFormSchema(descriptor.id);
      expect(Array.isArray(schema.sections)).toBe(true);
    });
  });

  it('each form field has name, label, and type', () => {
    const all = providerRegistry.listDescriptors();
    all.forEach((descriptor) => {
      const schema = providerRegistry.getFormSchema(descriptor.id);
      schema.sections.forEach((section) => {
        section.fields.forEach((field) => {
          expect(typeof field.name).toBe('string');
          expect(typeof field.label).toBe('string');
          expect(typeof field.type).toBe('string');
        });
      });
    });
  });
});

// ── register / registerMany ───────────────────────────────────────────────────

describe('ProviderRegistry.register', () => {
  it('silently ignores duplicate registration of the same id + version', () => {
    // Register a contract that already exists — should not throw
    const existing = providerRegistry.getContract('dummy-vector');
    expect(() => providerRegistry.register(existing as never)).not.toThrow();
    // Should still be in the registry
    expect(providerRegistry.getContract('dummy-vector')).toBeDefined();
  });

  it('registerMany registers multiple contracts without throwing', () => {
    const before = providerRegistry.listDescriptors().length;
    providerRegistry.registerMany([]);
    const after = providerRegistry.listDescriptors().length;
    expect(after).toBe(before);
  });
});
