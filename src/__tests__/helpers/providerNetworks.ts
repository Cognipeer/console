/**
 * The environment a test of the provider endpoint guard needs: which deployment it is, which private networks the
 * operator has opened (`PROVIDER_PRIVATE_NETWORKS`), and which addresses "this machine" has (the policy never opens
 * those, and reads them from `os.networkInterfaces()` when it is built).
 *
 *   afterEach(restoreDeployment);
 *   it('...', () => { useDeployment({ DEPLOYMENT_MODE: 'saas', PROVIDER_PRIVATE_NETWORKS: `${A}=10.50.0.0/16` }); ... });
 *
 * The settings this file masks (the ones the policy reads) are taken from the overrides only, never from the
 * environment of the machine the tests run on.
 */
import os from 'node:os';
import { vi, type MockInstance } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { resetProviderPrivateNetworksForTests } from '@/lib/security/providerPrivateNetworks';

/** Two organizations, as the databases write ids. */
export const TENANT_A = '64f0c0ffee0000000000aaaa';
export const TENANT_B = '64f0c0ffee0000000000bbbb';

const MASKED = new Set([
  'PROVIDER_PRIVATE_NETWORKS',
  'PROVIDER_PRIVATE_NETWORKS_DENY',
  'KUBERNETES_SERVICE_HOST',
  'OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK',
  'OUTBOUND_HTTP_ALLOWED_HOSTS',
]);

const originalSource = getConfigSource();
let interfaces: MockInstance<typeof os.networkInterfaces> | undefined;

/** The shape `os.networkInterfaces()` answers with, for the given addresses. */
export function interfacesOf(addresses: readonly string[]): ReturnType<typeof os.networkInterfaces> {
  return {
    eth0: addresses.map((address) => (address.includes(':')
      ? { address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/64`, scopeid: 0 }
      : { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/24` })),
  } as unknown as ReturnType<typeof os.networkInterfaces>;
}

/** The spy on `os.networkInterfaces`, for a test that counts how often the policy reads it. */
export function networkInterfacesSpy(): MockInstance<typeof os.networkInterfaces> {
  if (!interfaces) throw new Error('call useDeployment first');
  return interfaces;
}

export function useDeployment(overrides: Record<string, string> = {}, ownAddresses: readonly string[] = ['127.0.0.1']): void {
  setConfigSource({
    get: (key: string) => overrides[key] ?? (MASKED.has(key) ? undefined : process.env[key]),
  } as ConfigSource);
  interfaces?.mockRestore();
  interfaces = vi.spyOn(os, 'networkInterfaces').mockReturnValue(interfacesOf(ownAddresses));
  resetProviderPrivateNetworksForTests();
}

export function restoreDeployment(): void {
  interfaces?.mockRestore();
  interfaces = undefined;
  setConfigSource(originalSource);
  resetProviderPrivateNetworksForTests();
}

export const SAAS = { DEPLOYMENT_MODE: 'saas' };
export const ONPREM = { DEPLOYMENT_MODE: 'onprem' };
