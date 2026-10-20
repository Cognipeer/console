/**
 * `PROVIDER_PRIVATE_NETWORKS` and its deny list: how they are read, what a private address needs to pass, and what no
 * entry can open. The decision for an address is `guardRefusesAddress` (outboundFetch) over the allowance the policy
 * hands out for one organization; the provider endpoint guard and the connect-time lookups all ask it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getConfig } from '@/lib/core/config';
import { guardRefusesAddress, isPrivateIpAddress } from '@/lib/security/outboundFetch';
import {
  compileProviderPrivateNetworks,
  getProviderPrivateNetworks,
  logProviderPrivateNetworks,
  resetProviderPrivateNetworksForTests,
  type ProviderPrivateNetworksReport,
} from '@/lib/security/providerPrivateNetworks';
import { networkInterfacesSpy, restoreDeployment, SAAS, TENANT_A, TENANT_B, useDeployment } from '../helpers/providerNetworks';

afterEach(restoreDeployment);

const compile = (entries: string[], deny: string[] = [], ownAddresses: string[] | null = []) =>
  compileProviderPrivateNetworks({ entries, deny, ownAddresses });

/** Whether the block refuses `address` for `tenantId` under a policy. */
function refused(policy: ReturnType<typeof compile>, tenantId: string | undefined, address: string): boolean {
  const privateNetworks = policy.forTenant(tenantId);
  return guardRefusesAddress(address, { forceBlock: true, ...(privateNetworks ? { privateNetworks } : {}) });
}

describe('reading PROVIDER_PRIVATE_NETWORKS', () => {
  it('reads organization entries, the wildcard, IPv6 ranges and bare addresses', () => {
    const policy = compile([`${TENANT_A}=10.50.0.0/16,fd12:3456::/48`, '*=100.64.10.0/24', `${TENANT_B}=10.60.1.9,fd00:60::9`]);

    expect(refused(policy, TENANT_A, '10.50.1.5')).toBe(false);
    expect(refused(policy, TENANT_A, 'fd12:3456:0:7::1')).toBe(false);
    expect(refused(policy, TENANT_A, '100.64.10.77')).toBe(false);
    expect(refused(policy, TENANT_A, '10.51.0.1')).toBe(true);
    expect(refused(policy, TENANT_A, 'fd12:3457::1')).toBe(true);

    // a bare address is one host: /32 and /128
    expect(refused(policy, TENANT_B, '10.60.1.9')).toBe(false);
    expect(refused(policy, TENANT_B, '10.60.1.10')).toBe(true);
    expect(refused(policy, TENANT_B, 'fd00:60::9')).toBe(false);
    expect(refused(policy, TENANT_B, 'fd00:60::a')).toBe(true);

    expect(policy.report).toMatchObject({ tenants: 2, ranges: 5, wildcardRanges: 1, denyRanges: 0, invalid: [] });
  });

  it('ignores whitespace and merges two entries for one organization', () => {
    const policy = compile([`  ${TENANT_A}  =  10.50.0.0/16 , 192.168.7.0/24 `, '', `${TENANT_A}=172.20.0.0/16`, '   ']);

    for (const address of ['10.50.9.9', '192.168.7.4', '172.20.3.3']) expect(refused(policy, TENANT_A, address), address).toBe(false);
    expect(refused(policy, TENANT_A, '172.21.0.1')).toBe(true);
    expect(policy.report).toMatchObject({ tenants: 1, ranges: 3, invalid: [] });
  });

  it('gives an organization its own ranges and the wildcard ranges, never another organization\'s', () => {
    const policy = compile([`${TENANT_A}=10.50.0.0/16`, '*=100.64.10.0/24']);

    expect(refused(policy, TENANT_A, '10.50.1.5')).toBe(false);
    expect(refused(policy, TENANT_B, '10.50.1.5')).toBe(true);
    // the wildcard reaches every organization, one the entries never named included
    for (const tenant of [TENANT_A, TENANT_B, 'some-other-org']) expect(refused(policy, tenant, '100.64.10.5'), tenant).toBe(false);
    expect(refused(policy, TENANT_B, '100.64.11.5')).toBe(true);
  });

  it('opens nothing without an organization id', () => {
    const policy = compile([`${TENANT_A}=10.50.0.0/16`, '*=100.64.10.0/24']);

    expect(policy.forTenant(undefined)).toBeUndefined();
    expect(policy.forTenant('')).toBeUndefined();
    expect(refused(policy, undefined, '10.50.1.5')).toBe(true);
    expect(refused(policy, undefined, '100.64.10.5')).toBe(true);
    // an organization with no entry and no wildcard has nothing either
    expect(compile([`${TENANT_A}=10.50.0.0/16`]).forTenant(TENANT_B)).toBeUndefined();
  });

  it('an entry or range that cannot be read opens nothing, and the readable rest still works', () => {
    const policy = compile([
      'no-equals-sign',
      `=10.0.0.0/8`,
      `two words=10.0.0.0/8`,
      `a,b=10.0.0.0/8`,
      `${TENANT_B}=`,
      `${TENANT_B}=,`,
      `${TENANT_B}=not-an-address`,
      `${TENANT_B}=10.0.0.0/33`,
      `${TENANT_B}=fd00::/129`,
      `${TENANT_B}=10.0.0.0/-1`,
      `${TENANT_B}=minio.internal`,
      `${TENANT_B}=10.0.0.0/8/9`,
      `${TENANT_A}=10.50.0.0/16,garbage,192.168.7.0/24`,
    ]);

    // nothing of the unreadable entries is open for their organization ...
    for (const address of ['10.0.0.1', '10.255.255.1']) expect(refused(policy, TENANT_B, address), address).toBe(true);
    expect(policy.forTenant(TENANT_B)).toBeUndefined();
    // ... and one bad range does not take the good ones of its entry with it
    expect(refused(policy, TENANT_A, '10.50.2.2')).toBe(false);
    expect(refused(policy, TENANT_A, '192.168.7.2')).toBe(false);
    expect(policy.report.invalid).toEqual([
      'no-equals-sign',
      '=10.0.0.0/8',
      'two words=10.0.0.0/8',
      'a,b=10.0.0.0/8',
      `${TENANT_B}=`,
      `${TENANT_B}=,`,
      'not-an-address',
      '10.0.0.0/33',
      'fd00::/129',
      '10.0.0.0/-1',
      'minio.internal',
      '10.0.0.0/8/9',
      'garbage',
    ]);
    expect(policy.report).toMatchObject({ tenants: 1, ranges: 2 });
  });

  it('cuts the text it reports to 64 characters and replaces control characters', () => {
    const policy = compile([`${'x'.repeat(200)}`, `${TENANT_B}=${'9'.repeat(100)}`, 'bad\u0007entry\nwith control chars']);

    expect(policy.report.invalid).toHaveLength(3);
    for (const text of policy.report.invalid) expect(text.length).toBeLessThanOrEqual(64);
    expect(policy.report.invalid[2]).toBe('bad entry with control chars');
  });

  it('takes host names for what they are: not ranges', () => {
    // a name entry would trust whatever the name resolves to, the cluster's own addresses included
    const policy = compile([`${TENANT_A}=minio.corp.example`, `*=db.internal`]);
    expect(policy.forTenant(TENANT_A)).toBeUndefined();
    expect(policy.report).toMatchObject({ tenants: 0, ranges: 0 });
    expect(policy.report.invalid).toEqual(['minio.corp.example', 'db.internal']);
  });

  it('reads the two settings from the environment: entries split at ";", the deny list at ","', () => {
    useDeployment({
      ...SAAS,
      PROVIDER_PRIVATE_NETWORKS: ` ${TENANT_A}=10.50.0.0/16,fd12:3456::/48 ; *=100.64.10.0/24;; `,
      PROVIDER_PRIVATE_NETWORKS_DENY: '10.50.7.0/24, 10.50.8.0/24',
    });

    expect(getConfig().outboundHttp.providerPrivateNetworks).toEqual([`${TENANT_A}=10.50.0.0/16,fd12:3456::/48`, '*=100.64.10.0/24']);
    expect(getConfig().outboundHttp.providerPrivateNetworksDeny).toEqual(['10.50.7.0/24', '10.50.8.0/24']);
    const policy = getProviderPrivateNetworks();
    expect(policy.report).toMatchObject({ tenants: 1, ranges: 3, wildcardRanges: 1, denyRanges: 2, invalid: [] });
    expect(policy.forTenant(TENANT_A)?.permits('10.50.1.5')).toBe(true);
    expect(policy.forTenant(TENANT_A)?.permits('10.50.7.5')).toBe(false);
  });

  it('is empty by default: nothing opened, nothing reported, and the machine\'s addresses are not even read', () => {
    useDeployment(SAAS);

    expect(getConfig().outboundHttp.providerPrivateNetworks).toEqual([]);
    expect(getConfig().outboundHttp.providerPrivateNetworksDeny).toEqual([]);
    const policy = getProviderPrivateNetworks();
    expect(policy.forTenant(TENANT_A)).toBeUndefined();
    expect(policy.report).toMatchObject({ tenants: 0, ranges: 0, wildcardRanges: 0, denyRanges: 0, invalid: [], overlaps: [] });
    expect(networkInterfacesSpy()).not.toHaveBeenCalled();
  });

  it('is built once per configuration, and again when the configuration or the cluster address changes', () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=10.50.0.0/16` });
    const first = getProviderPrivateNetworks();
    expect(getProviderPrivateNetworks()).toBe(first);
    expect(networkInterfacesSpy()).toHaveBeenCalledTimes(1);

    resetProviderPrivateNetworksForTests();
    const second = getProviderPrivateNetworks();
    expect(second).not.toBe(first);

    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_B}=10.60.0.0/16` });
    const third = getProviderPrivateNetworks();
    expect(third.forTenant(TENANT_A)).toBeUndefined();
    expect(third.forTenant(TENANT_B)?.permits('10.60.1.1')).toBe(true);
  });
});

describe('what the decision is', () => {
  const policy = compile([`${TENANT_A}=10.50.0.0/16,fd12:3456::/48`, '*=100.64.10.0/24']);

  it('lets a public address through for everyone: the networks only ever open private space', () => {
    for (const address of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
      for (const tenant of [TENANT_A, TENANT_B, undefined]) expect(refused(policy, tenant, address), `${address} ${tenant}`).toBe(false);
    }
  });

  it('lets a private address through only inside the organization\'s own ranges', () => {
    expect(refused(policy, TENANT_A, '10.50.1.5')).toBe(false);
    expect(refused(policy, TENANT_B, '10.50.1.5')).toBe(true);
    expect(refused(policy, TENANT_A, '10.99.1.5')).toBe(true);
    expect(refused(policy, TENANT_A, '192.168.1.1')).toBe(true);
    expect(refused(policy, TENANT_A, 'fd12:3456::1')).toBe(false);
    expect(refused(policy, TENANT_B, 'fd12:3456::1')).toBe(true);
  });

  it('a range for every organization (*) reaches each of them', () => {
    expect(refused(policy, TENANT_A, '100.64.10.9')).toBe(false);
    expect(refused(policy, TENANT_B, '100.64.10.9')).toBe(false);
  });

  it('refuses what is not an address', () => {
    for (const text of ['', 'minio.internal', '10.50.1', '10.50.1.5.6', 'zzz', '10.50.1.5/32']) {
      expect(refused(policy, TENANT_A, text), text).toBe(true);
    }
  });

  it('matches an IPv4-mapped address as the IPv4 address it carries, in either spelling', () => {
    for (const mapped of ['::ffff:10.50.1.5', '::ffff:a32:105', '0:0:0:0:0:ffff:10.50.1.5', '::FFFF:A32:105']) {
      expect(isPrivateIpAddress(mapped), mapped).toBe(true);
      expect(refused(policy, TENANT_A, mapped), mapped).toBe(false);
      expect(refused(policy, TENANT_B, mapped), mapped).toBe(true);
    }
    // ... and the opened range may be written the same way
    const written = compile([`${TENANT_A}=::ffff:10.50.0.0/112`]);
    expect(refused(written, TENANT_A, '10.50.1.5')).toBe(false);
    expect(refused(written, TENANT_A, '10.51.1.5')).toBe(true);
  });
});

/** Everything the policy never opens, written the way a resolver might hand it over. */
const NEVER_OPENED = [
  // IPv4: "this network", loopback, link-local with the metadata services, the Azure and Alibaba ones, IETF assignments, multicast, broadcast
  '0.0.0.0', '0.1.2.3', '127.0.0.1', '127.255.255.254', '169.254.169.254', '169.254.0.1', '168.63.129.16', '100.100.100.200',
  '192.0.0.1', '192.0.0.192', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  // IPv6: unspecified, loopback, link-local, multicast, the AWS metadata service
  '::', '::1', 'fe80::1', 'fe80::a00:27ff:fe4e:66a1', 'febf::1', 'ff02::1', 'ff0e::1', 'fd00:ec2::254',
  // IPv4-mapped spellings of the IPv4 ones
  '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:168.63.129.16', '::ffff:0.0.0.0',
];

describe('what no entry can open', () => {
  it.each([
    ['one organization', [`${TENANT_A}=0.0.0.0/0,::/0`]],
    ['every organization', ['*=0.0.0.0/0,::/0']],
  ])('a range that covers everything (%s) still leaves these refused', (_label, entries) => {
    const policy = compile(entries);

    for (const address of NEVER_OPENED) {
      expect(isPrivateIpAddress(address), `${address} is private`).toBe(true);
      expect(refused(policy, TENANT_A, address), address).toBe(true);
      expect(policy.isAlwaysRefused(address), address).toBe(true);
    }
    // while the private space around them is open
    for (const address of ['10.1.2.3', '172.16.0.9', '192.168.1.1', '100.64.0.1', 'fd12:3456::1', '::ffff:10.1.2.3']) {
      expect(refused(policy, TENANT_A, address), address).toBe(false);
    }
  });

  it('lists the overlap at startup and keeps the overlapping part refused', () => {
    const policy = compile([`${TENANT_A}=0.0.0.0/0`, `${TENANT_A}=169.254.0.0/16`, `${TENANT_B}=10.50.0.0/16`]);

    expect(policy.report.overlaps).toEqual([
      { range: '0.0.0.0/0', with: ['built-in'] },
      { range: '169.254.0.0/16', with: ['built-in'] },
    ]);
    expect(refused(policy, TENANT_A, '169.254.169.254')).toBe(true);
  });

  it('keeps every IPv6 form that carries an IPv4 address refused, whatever the opened ranges cover', () => {
    const policy = compile([`${TENANT_A}=0.0.0.0/0,::/0`]);
    const forms: Record<string, string[]> = {
      'IPv4-compatible': ['::10.50.1.5', '::a32:105', '::0.0.0.7'],
      'IPv4-translated': ['::ffff:0:10.50.1.5', '::ffff:0:a32:105', '0:0:0:0:ffff:0:a32:105'],
      'NAT64': ['64:ff9b::10.50.1.5', '64:ff9b::a32:105', '64:ff9b::7f00:1'],
      'local-use NAT64': ['64:ff9b:1::10.50.1.5', '64:ff9b:1:0:0:0:a32:105', '64:ff9b:1:ffff::1'],
      '6to4': ['2002:a32:105::', '2002:a32:105:1:2:3:4:5', '2002:7f00:1::1'],
      'Teredo': ['2001:0:4136:e378:8000:63bf:f5cd:fefa', '2001::1'],
    };
    for (const [form, addresses] of Object.entries(forms)) {
      for (const address of addresses) {
        // today's verdict is private, and no opened range changes it
        expect(isPrivateIpAddress(address), `${form} ${address}`).toBe(true);
        expect(refused(policy, TENANT_A, address), `${form} ${address}`).toBe(true);
      }
    }
  });

  it('leaves a public IPv4 address behind a translator to the verdict it always had', () => {
    const policy = compile([`${TENANT_A}=10.50.0.0/16`]);
    // 8.8.8.8 and 93.184.216.34 are public, so these were never refused; the networks do not change that
    for (const address of ['64:ff9b::808:808', '2002:808:808::', '::ffff:0:808:808', '::808:808']) {
      expect(isPrivateIpAddress(address), address).toBe(false);
      expect(refused(policy, TENANT_A, address), address).toBe(false);
      expect(refused(policy, undefined, address), address).toBe(false);
    }
  });

  it('keeps the deny ranges refused inside an opened network, and reports how many it read', () => {
    const policy = compile([`${TENANT_A}=10.0.0.0/8`, '*=172.16.0.0/12'], ['10.244.0.0/16', ' 10.96.0.0/12 ', '172.20.0.0/24', '', 'fd00:abcd::/48']);

    expect(policy.report.denyRanges).toBe(4);
    for (const address of ['10.244.1.1', '10.96.0.1', '10.111.255.255', '172.20.0.7']) expect(refused(policy, TENANT_A, address), address).toBe(true);
    for (const address of ['10.1.1.1', '10.50.0.9', '172.20.1.1', '172.31.0.1']) expect(refused(policy, TENANT_A, address), address).toBe(false);
    expect(refused(policy, TENANT_B, '172.20.0.7')).toBe(true);
    expect(policy.report.overlaps).toEqual([
      { range: '172.16.0.0/12', with: ['deny'] },
      { range: '10.0.0.0/8', with: ['deny'] },
    ]);
  });

  it('a deny list that cannot be read closes everything: what it was meant to keep out is unknown', () => {
    const policy = compile([`${TENANT_A}=10.50.0.0/16`, '*=100.64.10.0/24'], ['10.244.0.0/16', 'nonsense']);

    expect(policy.forTenant(TENANT_A)).toBeUndefined();
    expect(policy.forTenant(TENANT_B)).toBeUndefined();
    expect(refused(policy, TENANT_A, '10.50.1.5')).toBe(true);
    expect(policy.report.invalidDeny).toEqual(['nonsense']);
    expect(policy.report.closed).toMatch(/PROVIDER_PRIVATE_NETWORKS_DENY/);
  });

  it('keeps the addresses of this machine refused: every interface, IPv4 and IPv6', () => {
    const policy = compile(
      [`${TENANT_A}=10.50.0.0/16,fd12:3456::/48`],
      [],
      ['10.50.1.77', 'fd12:3456::77', '127.0.0.1', 'fe80::1', '::ffff:10.50.9.9'],
    );

    for (const address of ['10.50.1.77', 'fd12:3456::77', '10.50.9.9', '::ffff:10.50.1.77']) expect(refused(policy, TENANT_A, address), address).toBe(true);
    // the rest of the network is open
    expect(refused(policy, TENANT_A, '10.50.1.5')).toBe(false);
    expect(refused(policy, TENANT_A, '10.50.1.78')).toBe(false);
    expect(refused(policy, TENANT_A, 'fd12:3456::78')).toBe(false);
    expect(policy.report.overlaps).toEqual([{ range: '10.50.0.0/16', with: ['own-address'] }, { range: 'fd12:3456::/48', with: ['own-address'] }]);
  });

  it('opens nothing when the addresses of this machine cannot be read', () => {
    const policy = compile([`${TENANT_A}=10.50.0.0/16`], [], null);

    expect(policy.forTenant(TENANT_A)).toBeUndefined();
    expect(refused(policy, TENANT_A, '10.50.1.5')).toBe(true);
    expect(policy.report.closed).toMatch(/addresses of this machine/);
  });

  it('reads the addresses of this machine from its network interfaces when the policy is built', () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=10.50.0.0/16` }, ['10.50.1.77']);
    const policy = getProviderPrivateNetworks();

    expect(networkInterfacesSpy()).toHaveBeenCalledTimes(1);
    expect(policy.forTenant(TENANT_A)?.permits('10.50.1.77')).toBe(false);
    expect(policy.forTenant(TENANT_A)?.permits('10.50.1.5')).toBe(true);

    // an interface lookup that throws closes the policy
    networkInterfacesSpy().mockImplementation(() => { throw new Error('uv_interface_addresses returned an error'); });
    resetProviderPrivateNetworksForTests();
    expect(getProviderPrivateNetworks().forTenant(TENANT_A)).toBeUndefined();
  });

  it('keeps KUBERNETES_SERVICE_HOST refused when it is an address, and ignores it when it is a name', () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=10.50.0.0/16`, KUBERNETES_SERVICE_HOST: '10.50.0.1' });
    expect(getProviderPrivateNetworks().forTenant(TENANT_A)?.permits('10.50.0.1')).toBe(false);
    expect(getProviderPrivateNetworks().forTenant(TENANT_A)?.permits('10.50.0.2')).toBe(true);

    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=fd12:3456::/48`, KUBERNETES_SERVICE_HOST: 'fd12:3456::1' });
    expect(getProviderPrivateNetworks().forTenant(TENANT_A)?.permits('fd12:3456::1')).toBe(false);
    expect(getProviderPrivateNetworks().forTenant(TENANT_A)?.permits('fd12:3456::2')).toBe(true);

    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=10.50.0.0/16`, KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc' });
    expect(getProviderPrivateNetworks().forTenant(TENANT_A)?.permits('10.50.0.1')).toBe(true);
  });

  it('follows a change of KUBERNETES_SERVICE_HOST while the rest of the configuration stays as it is', () => {
    const env: Record<string, string> = { ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=10.50.0.0/16` };
    useDeployment(env);
    expect(getProviderPrivateNetworks().forTenant(TENANT_A)?.permits('10.50.0.1')).toBe(true);

    env.KUBERNETES_SERVICE_HOST = '10.50.0.1';
    expect(getProviderPrivateNetworks().forTenant(TENANT_A)?.permits('10.50.0.1')).toBe(false);
    expect(getProviderPrivateNetworks().forTenant(TENANT_A)?.permits('10.50.0.2')).toBe(true);
  });
});

describe('the startup report', () => {
  function logger() {
    const lines: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
    const at = (level: string) => (message: string, meta?: Record<string, unknown>) => { lines.push({ level, message, meta }); };
    return { lines, info: at('info'), warn: at('warn'), error: at('error') };
  }

  it('writes one line with the counts when everything reads', () => {
    useDeployment({
      ...SAAS,
      PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=10.50.0.0/16,fd12:3456::/48;${TENANT_B}=10.60.0.0/16;*=100.64.10.0/24`,
      PROVIDER_PRIVATE_NETWORKS_DENY: '10.244.0.0/16',
    });
    const log = logger();
    logProviderPrivateNetworks(log);

    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatchObject({ level: 'info', meta: { tenants: 2, ranges: 4, wildcardRanges: 1, denyRanges: 1 } });
    expect(log.lines[0]!.message).toMatch(/2 organization/);
    // the ranges themselves, and the organizations they belong to, are not written out
    expect(JSON.stringify(log.lines)).not.toMatch(/10\.50|fd12|100\.64|64f0c0ffee/);
  });

  it('writes the same line with zeros when nothing is configured', () => {
    useDeployment(SAAS);
    const log = logger();
    logProviderPrivateNetworks(log);
    expect(log.lines).toEqual([expect.objectContaining({ level: 'info', meta: { tenants: 0, ranges: 0, wildcardRanges: 0, denyRanges: 0 } })]);
  });

  it('adds an error line for what opens nothing, with the offending text cut to 64 characters', () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=10.50.0.0/16;${'y'.repeat(150)};${TENANT_B}=oops` });
    const log = logger();
    logProviderPrivateNetworks(log);

    const error = log.lines.find((line) => line.level === 'error');
    expect(error?.message).toMatch(/2 entries that cannot be read/);
    const invalid = error?.meta?.invalid as string[];
    expect(invalid).toEqual(['y'.repeat(64), 'oops']);
  });

  it('adds an error line for a deny list that cannot be read, and says nothing is opened', () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=10.50.0.0/16`, PROVIDER_PRIVATE_NETWORKS_DENY: '10.244.0.0/16,wat' });
    const log = logger();
    logProviderPrivateNetworks(log);

    const error = log.lines.find((line) => line.level === 'error');
    expect(error?.message).toMatch(/PROVIDER_PRIVATE_NETWORKS_DENY.*no private network is opened/);
    expect(error?.meta).toEqual({ invalid: ['wat'] });
  });

  it('adds a warning for a range that contains addresses that are never opened', () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=0.0.0.0/0` }, []);
    const log = logger();
    logProviderPrivateNetworks(log);

    const warning = log.lines.find((line) => line.level === 'warn');
    expect(warning?.message).toMatch(/never opened/);
    expect((warning?.meta?.ranges as ProviderPrivateNetworksReport['overlaps'])).toEqual([{ range: '0.0.0.0/0', with: ['built-in'] }]);
  });

  it('warns that nothing is opened when the machine\'s addresses cannot be read', () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${TENANT_A}=10.50.0.0/16` });
    networkInterfacesSpy().mockImplementation(() => { throw new Error('boom'); });
    resetProviderPrivateNetworksForTests();
    const log = logger();
    logProviderPrivateNetworks(log);

    expect(log.lines.some((line) => line.level === 'warn' && /No private network is opened.*addresses of this machine/.test(line.message))).toBe(true);
  });
});
