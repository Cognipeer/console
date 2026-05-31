/**
 * Helpers shared across platform adapters. None of these touch GPU-specific
 * tooling; they collect OS / CPU / NIC info that every adapter needs.
 */

import { hostname, platform, release, arch, cpus, totalmem, networkInterfaces } from 'node:os';
import type { HostInventory, SystemInventory } from '@cognipeer/gpu-fleet-protocol';
import { execFile } from '../exec';

const MIB = 1024 * 1024;

export async function safeRun(cmd: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFile(cmd, args, { timeoutMs: 10_000 });
    return result.stdout;
  } catch {
    return null;
  }
}

export async function detectDistro(): Promise<string | null> {
  const out = await safeRun('sh', ['-c', '. /etc/os-release && echo "$NAME $VERSION"']);
  return out?.trim() || null;
}

export async function detectDocker(): Promise<string | null> {
  const out = await safeRun('docker', ['version', '--format', '{{.Server.Version}}']);
  return out?.trim() || null;
}

export async function detectAzureMetadata(): Promise<HostInventory['cloud']> {
  // IMDS responds in <100ms when running on Azure, hangs forever when not —
  // the -m 1 timeout is what makes this safe to call on every inventory probe.
  const raw = await safeRun('curl', [
    '-s', '-H', 'Metadata: true', '-m', '1',
    'http://169.254.169.254/metadata/instance?api-version=2021-02-01',
  ]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      compute?: { vmSize?: string; location?: string; vmId?: string };
      network?: {
        interface?: Array<{
          ipv4?: {
            ipAddress?: Array<{ privateIpAddress?: string; publicIpAddress?: string }>;
          };
        }>;
      };
    };
    if (!parsed.compute?.vmSize) return null;
    let privateIp: string | null = null;
    let publicIp: string | null = null;
    for (const iface of parsed.network?.interface ?? []) {
      for (const addr of iface?.ipv4?.ipAddress ?? []) {
        if (!privateIp && addr.privateIpAddress) privateIp = addr.privateIpAddress;
        if (!publicIp && addr.publicIpAddress) publicIp = addr.publicIpAddress;
      }
    }
    return {
      provider: 'azure',
      vmSize: parsed.compute.vmSize,
      region: parsed.compute.location,
      instanceId: parsed.compute.vmId,
      privateIp,
      publicIp,
    };
  } catch {
    return null;
  }
}

export async function detectAwsMetadata(): Promise<HostInventory['cloud']> {
  // AWS IMDSv2 — token first, then queries. Token request times out fast on
  // non-AWS so this is safe to call everywhere.
  const token = await safeRun('curl', [
    '-s', '-X', 'PUT', '-m', '1',
    '-H', 'X-aws-ec2-metadata-token-ttl-seconds: 60',
    'http://169.254.169.254/latest/api/token',
  ]);
  if (!token) return null;
  const get = async (path: string) =>
    safeRun('curl', [
      '-s', '-m', '1', '-H', `X-aws-ec2-metadata-token: ${token.trim()}`,
      `http://169.254.169.254/latest/meta-data/${path}`,
    ]);
  const [instanceId, instanceType, region, privateIp, publicIp] = await Promise.all([
    get('instance-id'),
    get('instance-type'),
    get('placement/region'),
    get('local-ipv4'),
    get('public-ipv4'),
  ]);
  if (!instanceId) return null;
  return {
    provider: 'aws',
    instanceId: instanceId.trim(),
    vmSize: instanceType?.trim(),
    region: region?.trim(),
    privateIp: privateIp?.trim() || null,
    publicIp: publicIp?.trim() || null,
  };
}

export async function detectGcpMetadata(): Promise<HostInventory['cloud']> {
  // GCP metadata uses a unique header — won't accidentally match AWS/Azure.
  const get = async (path: string) =>
    safeRun('curl', [
      '-s', '-m', '1', '-H', 'Metadata-Flavor: Google',
      `http://metadata.google.internal/computeMetadata/v1/${path}`,
    ]);
  const [instanceId, machineType, zone, privateIp, accessConfig] = await Promise.all([
    get('instance/id'),
    get('instance/machine-type'),
    get('instance/zone'),
    get('instance/network-interfaces/0/ip'),
    get('instance/network-interfaces/0/access-configs/0/external-ip'),
  ]);
  if (!instanceId) return null;
  return {
    provider: 'gcp',
    instanceId: instanceId.trim(),
    vmSize: machineType?.trim().split('/').pop(),
    region: zone?.trim().split('/').pop(),
    privateIp: privateIp?.trim() || null,
    publicIp: accessConfig?.trim() || null,
  };
}

/**
 * Try every supported cloud's metadata service in parallel. Only ONE will
 * answer in <1 second; the rest return null after their respective timeouts.
 */
export async function detectCloudMetadata(): Promise<HostInventory['cloud']> {
  const results = await Promise.all([
    detectAzureMetadata(),
    detectAwsMetadata(),
    detectGcpMetadata(),
  ]);
  return results.find((c) => c != null) ?? null;
}

/**
 * Pick the address the console should use to reach this host.
 * Preference order:
 *   1. Cloud public IP (works across networks, VPN, etc.)
 *   2. Cloud private IP (works inside the VNet)
 *   3. First non-loopback IPv4 from local NICs (best effort)
 *
 * Operators can still override this from the UI; the override is persisted
 * server-side and survives heartbeats/re-handshakes.
 */
export function detectPreferredServiceAddress(
  cloud?: HostInventory['cloud'] | null,
): string | null {
  if (cloud?.publicIp) return cloud.publicIp;
  if (cloud?.privateIp) return cloud.privateIp;
  const nics = networkInterfaces();
  for (const list of Object.values(nics)) {
    if (!list) continue;
    for (const addr of list) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

export function baseSystemInventory(args: {
  agentVersion: string;
  dockerVersion: string | null;
  nvidiaContainerToolkit: string | null;
  nvidiaDriver?: string | null;
  cuda?: string | null;
}): SystemInventory {
  const cpuInfo = cpus();
  return {
    os: {
      platform: platform(),
      release: release(),
      distro: null,
      arch: arch(),
    },
    cpu: {
      model: cpuInfo[0]?.model ?? 'unknown',
      cores: cpuInfo.length,
      threads: cpuInfo.length,
    },
    memoryTotalMiB: Math.round(totalmem() / MIB),
    toolchain: {
      nvidiaDriver: args.nvidiaDriver ?? null,
      cuda: args.cuda ?? null,
      docker: args.dockerVersion,
      nvidiaContainerToolkit: args.nvidiaContainerToolkit,
      agent: args.agentVersion,
    },
  };
}

export function defaultHostname(override: string | null): string {
  return override ?? hostname();
}
