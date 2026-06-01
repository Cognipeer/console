'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import CollapsibleInfo from '@/components/layout/CollapsibleInfo';

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 950 };
const backdropButton: CSSProperties = { position: 'absolute', inset: 0, border: 'none', padding: 0, margin: 0, background: 'transparent', cursor: 'default' };
const sheet: CSSProperties = { position: 'relative', zIndex: 1, width: '92%', maxWidth: 680, background: 'var(--ds-surface, #fff)', color: 'inherit', borderRadius: 12, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' };
const codeBox: CSSProperties = { background: '#0b0f17', color: '#d1d5db', borderRadius: 8, padding: 12, fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 12.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 };
const btn: CSSProperties = { padding: '5px 12px', borderRadius: 6, border: '1px solid var(--ds-border, #d1d5db)', background: 'var(--ds-surface, #f9fafb)', cursor: 'pointer', fontSize: 12 };
const btnPrimary: CSSProperties = { ...btn, background: 'var(--ds-accent, #2563eb)', color: '#fff', border: 'none' };

function Copyable({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <pre style={codeBox}>{text}</pre>
      <button
        style={{ ...btn, position: 'absolute', top: 8, right: 8 }}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard may be blocked */
          }
        }}
      >
        {copied ? 'Copied ✓' : label}
      </button>
    </div>
  );
}

/* ----------------------------- Runner setup ----------------------------- */
export function RunnerSetup({ token, tenantSlug, onClose }: { token: string; tenantSlug: string; onClose: () => void }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const command = `CONSOLE_URL=${origin} \\\n  TENANT_SLUG=${tenantSlug} \\\n  REGISTRATION_TOKEN=${token} \\\n  node scripts/sb-test-agent.mjs`;

  return (
    <div style={overlay}>
      <button type="button" aria-label="Close runner setup" style={backdropButton} onClick={onClose} />
      <div style={sheet}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--ds-border, #e5e7eb)', fontWeight: 600 }}>
          Start the runner
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '72vh', overflow: 'auto' }}>
          <div style={{ fontSize: 13, color: 'var(--ds-muted, #6b7280)' }}>
            A <b>runner</b> is a machine with Docker that actually runs the sandbox containers. Run the agent below on
            that machine; it connects back to the console and brings the runner <b>online</b>.
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Prerequisites</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
              <li>Docker installed and running (<code>docker version</code>)</li>
              <li>Node.js 18+ (<code>node -v</code>)</li>
              <li>Network access to this console</li>
            </ul>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Quick start (local Docker-CLI agent)</div>
            <Copyable text={command} />
            <div style={{ fontSize: 12, color: 'var(--ds-muted, #6b7280)', marginTop: 6 }}>
              Run from the console repo root (the script is at <code>scripts/sb-test-agent.mjs</code>). The runner will
              appear as <b>online</b> within a few seconds.
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Registration token (shown once)</div>
            <Copyable text={token} label="Copy token" />
          </div>

          <div style={{ fontSize: 12, color: 'var(--ds-muted, #6b7280)' }}>
            Production runners use the <code>@cognipeer/sandbox-agent</code> package (DinD → Kubernetes) with the same
            env vars. The token can be rotated any time from the runner row.
          </div>
        </div>
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--ds-border, #e5e7eb)', display: 'flex', justifyContent: 'flex-end' }}>
          <button style={btnPrimary} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- Usage docs ----------------------------- */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
      <div style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 999, background: 'var(--ds-accent, #2563eb)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>{n}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

export function UsageSection() {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const curlCreate = `curl -X POST ${origin}/api/client/v1/sandbox/sandboxes \\\n  -H "authorization: Bearer <API_TOKEN>" -H "content-type: application/json" \\\n  -d '{"template":"python-data","env":{"FOO":"bar"}}'`;
  const curlExec = `curl -X POST ${origin}/api/client/v1/sandbox/sandboxes/<id>/exec \\\n  -H "authorization: Bearer <API_TOKEN>" -H "content-type: application/json" \\\n  -d '{"command":"echo $FOO && python3 --version"}'`;
  const curlCode = `curl -X POST ${origin}/api/client/v1/sandbox/sandboxes/<id>/code \\\n  -H "authorization: Bearer <API_TOKEN>" -H "content-type: application/json" \\\n  -d '{"code":"print(6*7)","language":"python"}'`;

  return (
    <CollapsibleInfo title="How to use · Agent Sandbox" color="blue">
      <div style={{ fontSize: 13, color: 'var(--ds-muted, #6b7280)', marginBottom: 12 }}>
        Remote, API-driven runtime sandboxes: run code (Node/Python), manage files, open terminals, build & preview
        sites. Storage is pluggable — <b>local</b> (no cloud creds), Azure Blob, or S3.
      </div>

      <Step n={1} title="Start a runner (a Docker host that runs sandboxes)">
        Click <b>Add runner</b> → copy the shown command and run it on a machine with Docker + Node. The runner turns
        <b> online</b>. (You can reopen the setup from a runner row via <b>Rotate&nbsp;token</b>.)
      </Step>
      <Step n={2} title="Create a sandbox">
        Click <b>New sandbox</b> → pick a template (base image), optionally attach a <b>volume</b> and set
        <b> environment variables</b>. Use <b>Seed defaults</b> first if you have no templates. The runner pulls the
        image and starts the container.
      </Step>
      <Step n={3} title="Run code from the Playground">
        Open <b>Playground</b> → select a running sandbox → choose <b>Code</b> (Python/JS/TS/Bash) or <b>Shell</b> →
        <b> Run</b>. Output (stdout/stderr + exit code) appears live.
      </Step>
      <Step n={4} title="Interactive terminal">
        On any running sandbox click <b>Terminal</b> for a live shell session over WebSocket.
      </Step>
      <Step n={5} title="Drive it from an AI agent (API token)">
        Create an API token (Settings → Tokens), then call the token-authenticated client API. Minimal in, minimal out:
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Copyable text={curlCreate} />
          <Copyable text={curlExec} />
          <Copyable text={curlCode} />
        </div>
      </Step>

      <div style={{ fontSize: 12, color: 'var(--ds-muted, #6b7280)', marginTop: 6 }}>
        <b>Volumes:</b> <code>local</code> bind-mounts a host directory (great for dev/self-hosted, no credentials);
        <code> azure-blob</code>/<code>s3</code> mount object storage via FUSE. Each volume mounts at <code>/workspace</code>.
      </div>
    </CollapsibleInfo>
  );
}
