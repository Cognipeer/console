import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getManagedCreditsHost,
  isManagedModel,
  isManagedProviderRecord,
  listManagedRoutes,
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

describe('managed models and routes', () => {
  const route = { id: 'route-a', connectionId: 'conn-a', driver: 'driver-a' };

  it('isManagedModel asks the host by key and driver, and is false without a host or a key', () => {
    expect(isManagedModel({ providerKey: 'managed', providerDriver: 'driver-a' })).toBe(false);
    const registered = host((ref) => ref.driver === 'driver-a');
    registerManagedCreditsHost(registered);
    expect(isManagedModel({ providerKey: 'managed', providerDriver: 'driver-a' })).toBe(true);
    expect(isManagedModel({ providerKey: 'managed', providerDriver: 'openai' })).toBe(false);
    expect(isManagedModel({ providerDriver: 'driver-a' })).toBe(false);
    expect(isManagedModel(null)).toBe(false);
  });

  it('listManagedRoutes returns the host routes, dropping malformed ones', () => {
    const query = { providerKey: 'managed', kind: 'chat' as const };
    expect(listManagedRoutes(query)).toEqual([]);
    registerManagedCreditsHost({ ...host(() => true), listRoutes: () => [route, { id: '', connectionId: 'c', driver: 'd' }] });
    expect(listManagedRoutes(query)).toEqual([route]);
  });

  it('listManagedRoutes is empty without the method, on a throw and on a non-array', () => {
    const query = { providerKey: 'managed', kind: 'chat' as const };
    registerManagedCreditsHost(host(() => true));
    expect(listManagedRoutes(query)).toEqual([]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerManagedCreditsHost({ ...host(() => true), listRoutes: () => { throw new Error('boom'); } });
    expect(listManagedRoutes(query)).toEqual([]);
    registerManagedCreditsHost({ ...host(() => true), listRoutes: () => 'x' as never });
    expect(listManagedRoutes(query)).toEqual([]);
    spy.mockRestore();
  });
});
