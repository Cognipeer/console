'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import {
  IconBox,
  IconCode,
  IconDatabase,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconServer,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import TerminalModal from './TerminalModal';
import { InstanceModal, RunnerModal, TemplateModal, VolumeModal } from './SandboxModals';
import { RunnerSetup, UsageSection } from './SandboxHelp';
import { Pager, SearchBox, useListControls } from './_lib/listControls';
import {
  sandboxApi,
  type SandboxInstance,
  type SandboxRunner,
  type SandboxTemplate,
  type SandboxVolume,
} from './_lib/api';

const card: CSSProperties = { border: '1px solid var(--ds-border, #e5e7eb)', borderRadius: 10, padding: 16, marginBottom: 20, background: 'var(--ds-surface, #fff)' };
const th: CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--ds-border, #e5e7eb)', fontSize: 12, color: 'var(--ds-muted, #6b7280)', fontWeight: 600 };
const td: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--ds-border-subtle, #f3f4f6)', fontSize: 13 };
const btn: CSSProperties = { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--ds-border, #d1d5db)', background: 'var(--ds-surface, #f9fafb)', cursor: 'pointer', fontSize: 12, marginRight: 6, display: 'inline-flex', alignItems: 'center', gap: 4 };
const btnPrimary: CSSProperties = { ...btn, background: 'var(--ds-accent, #2563eb)', color: '#fff', border: 'none' };
const codeStyle: CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: 12 };

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 11, background: `${color}22`, color, border: `1px solid ${color}55` }}>
      {children}
    </span>
  );
}

const STATE_COLOR: Record<string, string> = {
  running: '#10b981',
  failed: '#ef4444',
  stopped: '#6b7280',
  creating: '#3b82f6',
  pending: '#3b82f6',
  starting: '#3b82f6',
  stopping: '#f59e0b',
  deleted: '#6b7280',
};

export default function SandboxOverviewPage() {
  const [runners, setRunners] = useState<SandboxRunner[]>([]);
  const [templates, setTemplates] = useState<SandboxTemplate[]>([]);
  const [volumes, setVolumes] = useState<SandboxVolume[]>([]);
  const [instances, setInstances] = useState<SandboxInstance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runnerSetup, setRunnerSetup] = useState<{ token: string; slug: string } | null>(null);
  const [terminal, setTerminal] = useState<{ id: string; name: string } | null>(null);
  const [modal, setModal] = useState<'runner' | 'volume' | 'instance' | 'template' | null>(null);

  const TRANSITIONAL = ['pending', 'creating', 'starting', 'stopping'];
  const load = useCallback(async (silent = false): Promise<boolean> => {
    try {
      const [r, t, v, i] = await Promise.all([
        sandboxApi.listRunners(),
        sandboxApi.listTemplates(),
        sandboxApi.listVolumes(),
        sandboxApi.listInstances(),
      ]);
      setRunners(r.runners);
      setTemplates(t.templates);
      setVolumes(v.volumes);
      setInstances(i.instances);
      setError(null);
      // Something still settling? Poll faster until it does.
      return (
        i.instances.some((x) => TRANSITIONAL.includes(x.actualState)) ||
        r.runners.some((x) => x.status === 'pending')
      );
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, []);

  // Adaptive polling: ~2s while things are transitioning, ~6s when settled.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const tick = async () => {
      const transitional = await load(true);
      if (cancelled) return;
      timer = setTimeout(tick, transitional ? 2000 : 6000);
    };
    void load(true).then((transitional) => {
      if (!cancelled) timer = setTimeout(tick, transitional ? 2000 : 6000);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  const run = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const insCtl = useListControls(instances, (i) => `${i.name} ${i.actualState} ${i.isolation} ${i.containerId ?? ''}`);
  const runCtl = useListControls(runners, (r) => `${r.name} ${r.status}`);
  const tplCtl = useListControls(templates, (t) => `${t.key} ${t.name} ${t.baseImage} ${t.runtime} ${t.isolation}`);
  const volCtl = useListControls(volumes, (v) => `${v.name} ${v.provider} ${v.container} ${v.prefix}`);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Agent Sandbox"
        title="Agent Sandbox"
        subtitle="Remote, API-driven runtime sandboxes — run code, manage files, open terminals and preview apps."
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Link href="/dashboard/sandbox/playground" style={{ ...btn, textDecoration: 'none', color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <IconPlayerPlay size={15} /> Playground
            </Link>
            <button style={btnPrimary} onClick={() => setModal('instance')}>
              <IconPlus size={15} /> New sandbox
            </button>
          </div>
        }
      />

      <div style={{ marginBottom: 16 }}>
        <UsageSection />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        <StatTile label="Instances" value={instances.length} icon={<IconBox size={16} />} />
        <StatTile label="Runners" value={runners.length} icon={<IconServer size={16} />} />
        <StatTile label="Templates" value={templates.length} icon={<IconCode size={16} />} />
        <StatTile label="Volumes" value={volumes.length} icon={<IconDatabase size={16} />} />
      </div>

      {error && (
        <div style={{ ...card, borderColor: '#fca5a5', background: '#fef2f2', color: '#b91c1c' }}>
          {error}
          <button style={{ ...btn, marginLeft: 12 }} onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}


      {/* Instances */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>Instances</h2>
          <SearchBox value={insCtl.query} onChange={insCtl.setQuery} placeholder="Search instances…" />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr><th style={th}>Name</th><th style={th}>State</th><th style={th}>Isolation</th><th style={th}>Container</th><th style={th}>Actions</th></tr>
          </thead>
          <tbody>
            {insCtl.items.map((i) => (
              <tr key={i.id}>
                <td style={td}>{i.name}</td>
                <td style={td}>
                  <Badge color={STATE_COLOR[i.actualState] ?? '#6b7280'}>{i.actualState}</Badge>{' '}
                  <small style={{ color: '#9ca3af' }}>/ {i.desiredState}</small>
                  {i.lastError && (
                    <div style={{ fontSize: 11, color: i.actualState === 'failed' ? '#b91c1c' : '#6b7280', marginTop: 2 }}>{i.lastError}</div>
                  )}
                </td>
                <td style={td}>{i.isolation}</td>
                <td style={td}><code style={codeStyle}>{i.containerId?.slice(0, 12) ?? '—'}</code></td>
                <td style={td}>
                  <button style={{ ...btn, opacity: i.actualState === 'running' ? 1 : 0.45 }} disabled={i.actualState !== 'running'} title={i.actualState === 'running' ? 'Open terminal' : 'Sandbox must be running'} onClick={() => setTerminal({ id: i.id, name: i.name })}><IconTerminal2 size={13} /> Terminal</button>
                  <button style={btn} onClick={run(() => sandboxApi.startInstance(i.id))}><IconPlayerPlay size={13} /> Start</button>
                  <button style={btn} onClick={run(() => sandboxApi.stopInstance(i.id))}><IconPlayerStop size={13} /> Stop</button>
                  <button style={{ ...btn, color: '#b91c1c' }} onClick={run(() => sandboxApi.deleteInstance(i.id))}><IconTrash size={13} /> Delete</button>
                </td>
              </tr>
            ))}
            {instances.length === 0 && <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={5}>No instances yet. Click “New sandbox”.</td></tr>}
            {instances.length > 0 && insCtl.items.length === 0 && <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={5}>No instances match “{insCtl.query}”.</td></tr>}
          </tbody>
        </table>
        <Pager {...insCtl} />
      </div>

      {/* Runners */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>Runners</h2>
          <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <SearchBox value={runCtl.query} onChange={runCtl.setQuery} placeholder="Search runners…" />
            <button style={btnPrimary} onClick={() => setModal('runner')}><IconPlus size={14} /> Add runner</button>
          </div>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr><th style={th}>Name</th><th style={th}>Status</th><th style={th}>Last seen</th><th style={th}>Actions</th></tr>
          </thead>
          <tbody>
            {runCtl.items.map((r) => (
              <tr key={r.id}>
                <td style={td}>{r.name}</td>
                <td style={td}>
                  <Badge color={r.status === 'online' ? '#10b981' : '#6b7280'}>{r.status}</Badge>
                  {r.managedRunning && <span style={{ marginLeft: 6, fontSize: 11, color: '#2563eb' }}>● managed</span>}
                </td>
                <td style={td}>{r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : '—'}</td>
                <td style={td}>
                  {r.managedRunning || r.status === 'online' ? (
                    <button style={btn} onClick={run(() => sandboxApi.stopRunner(r.id))}><IconPlayerStop size={13} /> Stop</button>
                  ) : (
                    <button style={btn} onClick={run(() => sandboxApi.startRunner(r.id))}><IconPlayerPlay size={13} /> Start</button>
                  )}
                  <button style={btn} onClick={run(async () => { const res = await sandboxApi.rotateRunnerToken(r.id); setRunnerSetup({ token: res.registrationToken, slug: res.tenantSlug }); })}><IconRefresh size={13} /> Rotate &amp; setup</button>
                  <button style={{ ...btn, color: '#b91c1c' }} onClick={run(() => sandboxApi.deleteRunner(r.id))}><IconTrash size={13} /> Delete</button>
                </td>
              </tr>
            ))}
            {runners.length === 0 && <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={4}>No runners. Add one, then run the sandbox-agent with the token.</td></tr>}
            {runners.length > 0 && runCtl.items.length === 0 && <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={4}>No runners match “{runCtl.query}”.</td></tr>}
          </tbody>
        </table>
        <Pager {...runCtl} />
      </div>

      {/* Templates */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>Templates</h2>
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <SearchBox value={tplCtl.query} onChange={tplCtl.setQuery} placeholder="Search templates…" />
            <button style={btnPrimary} onClick={() => setModal('template')}><IconPlus size={14} /> New template</button>
            <button style={btn} onClick={run(() => sandboxApi.seedTemplates())}>Seed defaults</button>
          </span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr><th style={th}>Key</th><th style={th}>Name</th><th style={th}>Image</th><th style={th}>Runtime</th><th style={th}>Isolation</th></tr>
          </thead>
          <tbody>
            {tplCtl.items.map((t) => (
              <tr key={t.id}>
                <td style={td}><code style={codeStyle}>{t.key}</code></td>
                <td style={td}>{t.name}</td>
                <td style={td}><code style={codeStyle}>{t.baseImage}</code></td>
                <td style={td}>{t.runtime}</td>
                <td style={td}>{t.isolation}</td>
              </tr>
            ))}
            {templates.length === 0 && <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={5}>No templates. Click “Seed defaults”.</td></tr>}
            {templates.length > 0 && tplCtl.items.length === 0 && <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={5}>No templates match “{tplCtl.query}”.</td></tr>}
          </tbody>
        </table>
        <Pager {...tplCtl} />
      </div>

      {/* Volumes */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>Volumes</h2>
          <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <SearchBox value={volCtl.query} onChange={volCtl.setQuery} placeholder="Search volumes…" />
            <button style={btnPrimary} onClick={() => setModal('volume')}><IconPlus size={14} /> Add volume</button>
          </div>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr><th style={th}>Name</th><th style={th}>Provider</th><th style={th}>Container</th><th style={th}>Prefix</th></tr>
          </thead>
          <tbody>
            {volCtl.items.map((v) => (
              <tr key={v.id}>
                <td style={td}>{v.name}</td>
                <td style={td}>{v.provider}</td>
                <td style={td}>{v.container}</td>
                <td style={td}>{v.prefix}</td>
              </tr>
            ))}
            {volumes.length === 0 && <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={4}>No volumes.</td></tr>}
            {volumes.length > 0 && volCtl.items.length === 0 && <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={4}>No volumes match “{volCtl.query}”.</td></tr>}
          </tbody>
        </table>
        <Pager {...volCtl} />
      </div>

      {terminal && (
        <TerminalModal instanceId={terminal.id} instanceName={terminal.name} onClose={() => setTerminal(null)} />
      )}

      {modal === 'runner' && (
        <RunnerModal
          onClose={() => setModal(null)}
          onCreated={(_r, registrationToken, tenantSlug) => {
            setRunnerSetup({ token: registrationToken, slug: tenantSlug });
            setModal(null);
            void load();
          }}
        />
      )}
      {runnerSetup && (
        <RunnerSetup token={runnerSetup.token} tenantSlug={runnerSetup.slug} onClose={() => setRunnerSetup(null)} />
      )}
      {modal === 'volume' && (
        <VolumeModal onClose={() => setModal(null)} onCreated={() => { setModal(null); void load(); }} />
      )}
      {modal === 'template' && (
        <TemplateModal onClose={() => setModal(null)} onCreated={() => { setModal(null); void load(); }} />
      )}
      {modal === 'instance' && (
        <InstanceModal
          templates={templates}
          runners={runners}
          volumes={volumes}
          onClose={() => setModal(null)}
          onCreated={() => { setModal(null); void load(); }}
        />
      )}
    </PageContainer>
  );
}
