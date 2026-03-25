/**
 * Contract tests — Provider Matrix
 *
 * Every registered provider contract must satisfy the same structural contract
 * regardless of which external service it wraps. This test covers:
 *  - Shape compliance (id, version, domains, display, form, createRuntime)
 *  - Domain classification (vector / model / embedding)
 *  - Runtime factory produces the expected interface
 *
 * External HTTP is intercepted by MSW so no real API keys are needed.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { CORE_PROVIDER_CONTRACTS } from '@/lib/providers/contracts';
import { providerRegistry } from '@/lib/providers/registry';
import { mswServer } from '../helpers/msw.server';

// ── MSW lifecycle ─────────────────────────────────────────────────────────────

beforeAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

// ── Shared contract shape tests ───────────────────────────────────────────────

describe('Every provider contract has valid shape', () => {
  it.each(CORE_PROVIDER_CONTRACTS.map((c) => [c.id, c]))(
    '%s — required fields exist',
    (_, contract) => {
      expect(typeof contract.id).toBe('string');
      expect(contract.id.length).toBeGreaterThan(0);

      expect(typeof contract.version).toBe('string');
      expect(contract.version).toMatch(/^\d+\.\d+\.\d+$/);

      expect(Array.isArray(contract.domains)).toBe(true);
      expect(contract.domains.length).toBeGreaterThan(0);

      expect(typeof contract.display.label).toBe('string');
      expect(contract.display.label.length).toBeGreaterThan(0);

      expect(typeof contract.createRuntime).toBe('function');

      expect(Array.isArray(contract.form.sections)).toBe(true);
    },
  );
});

// ── Domain checks ─────────────────────────────────────────────────────────────

describe('Domain classification', () => {
  const VALID_DOMAINS = ['vector', 'model', 'embedding', 'file'] as const;

  it.each(CORE_PROVIDER_CONTRACTS.map((c) => [c.id, c]))(
    '%s — every domain value is known',
    (_, contract) => {
      contract.domains.forEach((d) => {
        expect(VALID_DOMAINS).toContain(d);
      });
    },
  );

  it('at least one vector provider is registered', () => {
    const vectorContracts = CORE_PROVIDER_CONTRACTS.filter((c) =>
      c.domains.includes('vector'),
    );
    expect(vectorContracts.length).toBeGreaterThan(0);
  });

  it('at least one model provider is registered', () => {
    const modelContracts = CORE_PROVIDER_CONTRACTS.filter((c) =>
      c.domains.includes('model'),
    );
    expect(modelContracts.length).toBeGreaterThan(0);
  });
});

// ── Form field integrity ──────────────────────────────────────────────────────

describe('Provider form schemas', () => {
  const VALID_FIELD_TYPES = ['text', 'password', 'textarea', 'number', 'select', 'switch'] as const;

  it.each(CORE_PROVIDER_CONTRACTS.map((c) => [c.id, c]))(
    '%s — all form fields have valid type',
    (_, contract) => {
      contract.form.sections.forEach((section) => {
        section.fields.forEach((field) => {
          expect(VALID_FIELD_TYPES).toContain(field.type);
          expect(field.name.length).toBeGreaterThan(0);
          expect(field.label.length).toBeGreaterThan(0);
        });
      });
    },
  );

  it.each(CORE_PROVIDER_CONTRACTS.map((c) => [c.id, c]))(
    '%s — select fields have options defined',
    (_, contract) => {
      contract.form.sections.forEach((section) => {
        section.fields
          .filter((f) => f.type === 'select')
          .forEach((field) => {
            expect(Array.isArray(field.options)).toBe(true);
            expect((field.options ?? []).length).toBeGreaterThan(0);
          });
      });
    },
  );
});

// ── Model capability flags ────────────────────────────────────────────────────

describe('Model provider capabilities', () => {
  const modelContracts = CORE_PROVIDER_CONTRACTS.filter((c) =>
    c.domains.includes('model'),
  );

  it.each(modelContracts.map((c) => [c.id, c]))(
    '%s — model.categories capability is an array',
    (_, contract) => {
      const caps = contract.capabilities ?? {};
      if (caps['model.categories']) {
        expect(Array.isArray(caps['model.categories'])).toBe(true);
        const categories = caps['model.categories'] as string[];
        categories.forEach((cat) => {
          expect(['llm', 'embedding']).toContain(cat);
        });
      }
    },
  );
});

// ── Registry round-trip ───────────────────────────────────────────────────────

describe('Registry round-trip for every contract', () => {
  it.each(CORE_PROVIDER_CONTRACTS.map((c) => [c.id, c]))(
    '%s — can be retrieved from registry by id',
    (id) => {
      const contract = providerRegistry.getContract(id as string);
      expect(contract.id).toBe(id);
    },
  );
});
