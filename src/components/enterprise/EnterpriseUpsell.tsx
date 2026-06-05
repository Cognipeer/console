'use client';

/**
 * Placeholder shown in the COMMUNITY (FREE) build for services that require an
 * ENTERPRISE license. In the enterprise build, the overlay overwrites the page
 * files under src/app/dashboard/{module}/ with the real implementations, so this
 * component is never rendered there.
 *
 * Keep this dependency-light: it must render in a build where the enterprise
 * module code is entirely absent.
 */

export type EnterpriseUpsellProps = {
  module: string;
};

const MODULE_LABELS: Record<string, string> = {
  'gpu-fleet': 'GPU Fleet',
  sandbox: 'Agent Sandbox',
  cluster: 'Cluster (multi-node)',
};

export function EnterpriseUpsell({ module }: EnterpriseUpsellProps) {
  const label = MODULE_LABELS[module] ?? module;
  return (
    <div
      style={{
        alignItems: 'center',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        justifyContent: 'center',
        minHeight: '60vh',
        padding: 32,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: 1, opacity: 0.6, textTransform: 'uppercase' }}>
        Enterprise
      </div>
      <h2 style={{ margin: 0 }}>{label} is an Enterprise feature</h2>
      <p style={{ maxWidth: 520, opacity: 0.75 }}>
        This module is available in the Cognipeer Console Enterprise edition. Activate an
        Enterprise license to enable {label}.
      </p>
      <a
        href="/dashboard/license"
        style={{
          background: '#111',
          borderRadius: 8,
          color: '#fff',
          fontWeight: 600,
          marginTop: 8,
          padding: '10px 18px',
          textDecoration: 'none',
        }}
      >
        View license &amp; upgrade
      </a>
    </div>
  );
}

export default EnterpriseUpsell;
