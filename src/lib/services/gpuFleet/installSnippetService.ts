/**
 * Render the install one-liner the UI shows in the onboarding wizard.
 *
 * Branches on:
 *   - tenant `agentDistributionMode` (console-served vs external-url)
 *   - host OS / arch (linux-x64 / darwin-arm64 / …)
 *
 * The fleet token is interpolated as the live token value. Never log this
 * function's output to anything except the caller's response — that token
 * grants `pending_claim` registration for the whole tenant.
 */

import { listAvailableBundles, type AgentPlatform } from './agentBundleService';
import { getOrInitFleetSettings, rotateFleetToken } from './settingsService';

export interface InstallSnippet {
  /** Bash one-liner suitable for `curl ... | sudo bash -s -- ...`. */
  curl: string;
  /** Same fields broken out so the UI can render alternative views (Ansible, cloud-init). */
  consoleUrl: string;
  tenantSlug: string;
  fleetToken: string;
  /** URL the host will download the agent tarball from. */
  assetUrl: string;
  /** URL the host will pipe install.sh from. */
  installerUrl: string;
}

export interface InstallSnippetInput {
  tenantDbName: string;
  tenantId: string;
  tenantSlug: string;
  /** Resolved by the API plugin from the inbound request. */
  consoleBaseUrl: string;
  /** Optional host platform; defaults to linux-x64. */
  platform?: AgentPlatform;
  /** Identity of the admin requesting (for audit). */
  actorUserId: string;
  /** When true, mint a fresh fleet token (replacing any prior one). */
  rotateToken?: boolean;
}

export async function renderInstallSnippet(input: InstallSnippetInput): Promise<InstallSnippet> {
  const platform: AgentPlatform = input.platform ?? 'linux-x64';
  // Settings are lazily initialised on first call per tenant; we read them
  // back after the rotation to render the asset URL with the right mode.
  await getOrInitFleetSettings(input.tenantDbName, input.tenantId);

  // We can't show an existing fleet token — only its hash is stored. So
  // generating an install snippet ALWAYS rotates the fleet token. The
  // `rotateToken` flag is accepted for backwards-compat but no longer
  // changes behaviour; "view existing token" is not a valid operation.
  void input.rotateToken;
  const result = await rotateFleetToken({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    rotatedBy: input.actorUserId,
  });
  const token = result.token;

  // Re-read settings to pick up the freshly-rotated hash + current
  // distribution mode (in case it changed mid-flight).
  const settings = await getOrInitFleetSettings(input.tenantDbName, input.tenantId);

  const baseUrl = input.consoleBaseUrl.replace(/\/$/, '');
  const installerUrl = `${baseUrl}/api/gpu-fleet/installer.sh`;
  const assetUrl = resolveAssetUrl({
    baseUrl,
    mode: settings.agentDistributionMode,
    externalTemplate: settings.agentDistributionExternalUrlTemplate,
    platform,
  });

  // macOS installs per-user (no sudo). Linux platforms require root to write
  // to /opt + /etc + systemd. We pipe to `bash` (user) or `sudo bash` (root)
  // accordingly. The installer itself rejects mis-matched privileges, so the
  // operator gets a clear error instead of a half-applied install.
  const shell = platform.startsWith('darwin') ? 'bash' : 'sudo bash';

  const curl = [
    `curl -fsSL ${installerUrl} | ${shell} -s -- \\`,
    `  --console-url ${baseUrl} \\`,
    `  --tenant-slug ${input.tenantSlug} \\`,
    `  --fleet-token ${token} \\`,
    `  --asset-url ${assetUrl} \\`,
    `  --auto-install-prereqs`,
  ].join('\n');

  return {
    curl,
    consoleUrl: baseUrl,
    tenantSlug: input.tenantSlug,
    fleetToken: token,
    assetUrl,
    installerUrl,
  };
}

function resolveAssetUrl(args: {
  baseUrl: string;
  mode: 'console-served' | 'external-url';
  externalTemplate: string | null;
  platform: AgentPlatform;
}): string {
  if (args.mode === 'external-url' && args.externalTemplate) {
    return args.externalTemplate.replace('{{platform}}', args.platform);
  }
  return `${args.baseUrl}/api/gpu-fleet/agent-bundle/${args.platform}.tar.gz`;
}

export function availablePlatforms(): AgentPlatform[] {
  return listAvailableBundles().map((b) => b.platform);
}
