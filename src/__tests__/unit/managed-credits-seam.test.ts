import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getManagedCreditsHost,
  isManagedProviderRecord,
  registerManagedCreditsHost,
  resetManagedCreditsHostForTests,
  type ManagedCreditsHost,
} from '@/enterprise/managed-credits';

const host = (managed: (ref: { driver?: string }) => boolean): ManagedCreditsHost => ({
  isManagedProvider: vi.fn(managed),
  reserve: vi.fn(),
});

afterEach(() => resetManagedCreditsHostForTests());

describe('managed credits seam', () => {
  it('has no host by default and nothing is managed', () => {
    expect(getManagedCreditsHost()).toBeNull();
    expect(isManagedProviderRecord({ driver: 'anything' })).toBe(false);
    expect(isManagedProviderRecord(null)).toBe(false);
    expect(isManagedProviderRecord(undefined)).toBe(false);
  });

  it('asks the registered host, and reset removes it', () => {
    const registered = host((ref) => ref.driver === 'managed');
    registerManagedCreditsHost(registered);
    expect(getManagedCreditsHost()).toBe(registered);
    expect(isManagedProviderRecord({ driver: 'managed' })).toBe(true);
    expect(isManagedProviderRecord({ driver: 'openai' })).toBe(false);
    expect(isManagedProviderRecord(null)).toBe(false);
    resetManagedCreditsHostForTests();
    expect(isManagedProviderRecord({ driver: 'managed' })).toBe(false);
    expect(registered.isManagedProvider).toHaveBeenCalledTimes(2);
  });

  it('a second registration replaces the first', () => {
    registerManagedCreditsHost(host(() => true));
    registerManagedCreditsHost(host(() => false));
    expect(isManagedProviderRecord({ driver: 'x' })).toBe(false);
  });

  it('a host that throws fails closed: the provider reads as managed', () => {
    registerManagedCreditsHost(host(() => { throw new Error('boom'); }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(isManagedProviderRecord({ driver: 'x' })).toBe(true);
    spy.mockRestore();
  });
});
