'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { sandboxApi, type SandboxRunner, type SandboxTemplate, type SandboxVolume } from './_lib/api';

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 900,
};
const sheet: CSSProperties = {
  width: '90%', maxWidth: 540, background: 'var(--ds-surface, #fff)', color: 'inherit',
  borderRadius: 12, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
};
const headerBar: CSSProperties = { padding: '14px 18px', borderBottom: '1px solid var(--ds-border, #e5e7eb)', fontWeight: 600, fontSize: 15 };
const bodyBox: CSSProperties = { padding: 18, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '70vh', overflow: 'auto' };
const footer: CSSProperties = { padding: '12px 18px', borderTop: '1px solid var(--ds-border, #e5e7eb)', display: 'flex', justifyContent: 'flex-end', gap: 8 };
const label: CSSProperties = { fontSize: 12, color: 'var(--ds-muted, #6b7280)', marginBottom: 4, display: 'block', fontWeight: 600 };
const input: CSSProperties = { width: '100%', padding: '8px 11px', borderRadius: 6, border: '1px solid var(--ds-border, #d1d5db)', fontSize: 13, background: 'var(--ds-surface, #fff)', color: 'inherit' };
const btn: CSSProperties = { padding: '7px 14px', borderRadius: 6, border: '1px solid var(--ds-border, #d1d5db)', background: 'var(--ds-surface, #f9fafb)', cursor: 'pointer', fontSize: 13 };
const btnPrimary: CSSProperties = { ...btn, background: 'var(--ds-accent, #2563eb)', color: '#fff', border: 'none' };

function Modal({ title, onClose, children, footer: foot }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  return (
    <div style={overlay} onClick={onClose}>
      <div style={sheet} onClick={(e) => e.stopPropagation()}>
        <div style={headerBar}>{title}</div>
        <div style={bodyBox}>{children}</div>
        <div style={footer}>{foot}</div>
      </div>
    </div>
  );
}

function Field({ label: l, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label style={label}>{l}</label>
      {children}
    </div>
  );
}

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return { busy, err, submit };
}

/* --------------------------------- Runner -------------------------------- */
export function RunnerModal({ onClose, onCreated }: { onClose: () => void; onCreated: (r: SandboxRunner, token: string, tenantSlug: string) => void }) {
  const [name, setName] = useState('');
  const { busy, err, submit } = useSubmit(async () => {
    const res = await sandboxApi.createRunner(name.trim());
    onCreated(res.runner, res.registrationToken, res.tenantSlug);
  });
  return (
    <Modal
      title="New runner"
      onClose={onClose}
      footer={<>
        <button style={btn} onClick={onClose}>Cancel</button>
        <button style={btnPrimary} disabled={!name.trim() || busy} onClick={submit}>{busy ? 'Creating…' : 'Create runner'}</button>
      </>}
    >
      <Field label="Name">
        <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. dind-node-1" autoFocus />
      </Field>
      <p style={{ fontSize: 12, color: 'var(--ds-muted, #6b7280)', margin: 0 }}>
        After creating, a one-time registration token is shown. Start the sandbox-agent with it to bring the runner online.
      </p>
      {err && <div style={{ color: '#b91c1c', fontSize: 13 }}>{err}</div>}
    </Modal>
  );
}

/* --------------------------------- Volume -------------------------------- */
export function VolumeModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<'local' | 'azure-blob' | 's3'>('local');
  const [container, setContainer] = useState('');
  const [prefix, setPrefix] = useState('');
  const { busy, err, submit } = useSubmit(async () => {
    await sandboxApi.createVolume({ name: name.trim(), provider, container: container.trim(), prefix: prefix.trim() });
    onCreated();
  });
  const containerLabel = provider === 'azure-blob' ? 'Blob container' : provider === 's3' ? 'S3 bucket' : 'Local volume name';
  return (
    <Modal
      title="New volume"
      onClose={onClose}
      footer={<>
        <button style={btn} onClick={onClose}>Cancel</button>
        <button style={btnPrimary} disabled={!name.trim() || !container.trim() || busy} onClick={submit}>{busy ? 'Creating…' : 'Create volume'}</button>
      </>}
    >
      <Field label="Name">
        <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. workspace-data" autoFocus />
      </Field>
      <Field label="Provider">
        <select style={input} value={provider} onChange={(e) => setProvider(e.target.value as 'local' | 'azure-blob' | 's3')}>
          <option value="local">Local (host directory — no cloud creds)</option>
          <option value="azure-blob">Azure Blob (blobfuse)</option>
          <option value="s3">S3 (mountpoint-s3)</option>
        </select>
      </Field>
      <Field label={containerLabel}>
        <input style={input} value={container} onChange={(e) => setContainer(e.target.value)} placeholder={provider === 'local' ? 'e.g. proj-data' : 'e.g. my-container'} />
      </Field>
      <Field label="Prefix / sub-path">
        <input style={input} value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="e.g. workspace" />
      </Field>
      {err && <div style={{ color: '#b91c1c', fontSize: 13 }}>{err}</div>}
    </Modal>
  );
}

/* -------------------------------- Instance ------------------------------- */
interface EnvRow { key: string; value: string }

export function InstanceModal({
  templates, runners, volumes, onClose, onCreated,
}: {
  templates: SandboxTemplate[];
  runners: SandboxRunner[];
  volumes: SandboxVolume[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [runnerId, setRunnerId] = useState('');
  const [volumeId, setVolumeId] = useState('');
  const [env, setEnv] = useState<EnvRow[]>([{ key: '', value: '' }]);

  const setRow = (i: number, patch: Partial<EnvRow>) => setEnv((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setEnv((rows) => [...rows, { key: '', value: '' }]);
  const removeRow = (i: number) => setEnv((rows) => rows.filter((_, idx) => idx !== i));

  const { busy, err, submit } = useSubmit(async () => {
    const envObj: Record<string, string> = {};
    for (const r of env) if (r.key.trim()) envObj[r.key.trim()] = r.value;
    await sandboxApi.createInstance({
      templateId,
      name: name.trim(),
      runnerId: runnerId || undefined,
      volumeId: volumeId || undefined,
      env: Object.keys(envObj).length ? envObj : undefined,
    });
    onCreated();
  });

  return (
    <Modal
      title="New sandbox"
      onClose={onClose}
      footer={<>
        <button style={btn} onClick={onClose}>Cancel</button>
        <button style={btnPrimary} disabled={!name.trim() || !templateId || busy} onClick={submit}>{busy ? 'Launching…' : 'Launch sandbox'}</button>
      </>}
    >
      <Field label="Name">
        <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. data-analysis-1" autoFocus />
      </Field>
      <Field label="Template">
        <select style={input} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.length === 0 && <option value="">No templates — seed defaults first</option>}
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.baseImage})</option>)}
        </select>
      </Field>
      <Field label="Runner (optional — auto-selects an online runner)">
        <select style={input} value={runnerId} onChange={(e) => setRunnerId(e.target.value)}>
          <option value="">Auto</option>
          {runners.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.status})</option>)}
        </select>
      </Field>
      <Field label="Volume (optional — mounted at /workspace)">
        <select style={input} value={volumeId} onChange={(e) => setVolumeId(e.target.value)}>
          <option value="">None (ephemeral)</option>
          {volumes.map((v) => <option key={v.id} value={v.id}>{v.name} [{v.provider}]</option>)}
        </select>
      </Field>
      <div>
        <label style={label}>Environment variables</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {env.map((row, i) => (
            <div key={i} style={{ display: 'flex', gap: 6 }}>
              <input style={{ ...input, flex: 1 }} value={row.key} onChange={(e) => setRow(i, { key: e.target.value })} placeholder="KEY" />
              <input style={{ ...input, flex: 1 }} value={row.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="value" />
              <button style={{ ...btn, padding: '6px 10px' }} onClick={() => removeRow(i)} aria-label="remove">−</button>
            </div>
          ))}
          <button style={{ ...btn, alignSelf: 'flex-start' }} onClick={addRow}>+ Add variable</button>
        </div>
      </div>
      {err && <div style={{ color: '#b91c1c', fontSize: 13 }}>{err}</div>}
    </Modal>
  );
}

/* ------------------------------- Template -------------------------------- */
export function TemplateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [baseImage, setBaseImage] = useState('');
  const [runtime, setRuntime] = useState('multi');
  const [isolation, setIsolation] = useState('runc');
  const [toolboxPort, setToolboxPort] = useState('8787');
  const [description, setDescription] = useState('');
  const [ports, setPorts] = useState('');
  const [env, setEnv] = useState<EnvRow[]>([{ key: '', value: '' }]);
  const setRow = (i: number, patch: Partial<EnvRow>) => setEnv((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const { busy, err, submit } = useSubmit(async () => {
    const envObj: Record<string, string> = {};
    for (const r of env) if (r.key.trim()) envObj[r.key.trim()] = r.value;
    const previewPorts = ports
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((p) => Number.isFinite(p) && p > 0)
      .map((port) => ({ port }));
    await sandboxApi.createTemplate({
      key: key.trim(),
      name: name.trim(),
      baseImage: baseImage.trim(),
      runtime,
      isolation,
      toolboxPort: Number(toolboxPort) || 8787,
      description: description.trim() || undefined,
      env: Object.keys(envObj).length ? envObj : undefined,
      previewPorts: previewPorts.length ? previewPorts : undefined,
    });
    onCreated();
  });

  return (
    <Modal
      title="New template"
      onClose={onClose}
      footer={<>
        <button style={btn} onClick={onClose}>Cancel</button>
        <button style={btnPrimary} disabled={!key.trim() || !name.trim() || !baseImage.trim() || busy} onClick={submit}>
          {busy ? 'Creating…' : 'Create template'}
        </button>
      </>}
    >
      <Field label="Key (unique)">
        <input style={input} value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. my-python-ml" autoFocus />
      </Field>
      <Field label="Name">
        <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Python + ML libs" />
      </Field>
      <Field label="Base image (Docker image the runner can pull)">
        <input style={input} value={baseImage} onChange={(e) => setBaseImage(e.target.value)} placeholder="e.g. python:3.12 or myregistry/myimage:tag" />
      </Field>
      <div style={{ display: 'flex', gap: 10 }}>
        <Field label="Runtime">
          <select style={input} value={runtime} onChange={(e) => setRuntime(e.target.value)}>
            <option value="multi">multi</option>
            <option value="python">python</option>
            <option value="node">node</option>
            <option value="custom">custom</option>
          </select>
        </Field>
        <Field label="Isolation">
          <select style={input} value={isolation} onChange={(e) => setIsolation(e.target.value)}>
            <option value="runc">runc</option>
            <option value="gvisor">gvisor</option>
            <option value="kata">kata</option>
          </select>
        </Field>
        <Field label="Toolbox port">
          <input style={input} value={toolboxPort} onChange={(e) => setToolboxPort(e.target.value)} />
        </Field>
      </div>
      <Field label="Description (optional)">
        <input style={input} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Preview ports (optional, comma-separated)">
        <input style={input} value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="e.g. 3000, 5173, 8000" />
      </Field>
      <div>
        <label style={label}>Default environment variables (optional)</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {env.map((row, i) => (
            <div key={i} style={{ display: 'flex', gap: 6 }}>
              <input style={{ ...input, flex: 1 }} value={row.key} onChange={(e) => setRow(i, { key: e.target.value })} placeholder="KEY" />
              <input style={{ ...input, flex: 1 }} value={row.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="value" />
            </div>
          ))}
          <button style={{ ...btn, alignSelf: 'flex-start' }} onClick={() => setEnv((r) => [...r, { key: '', value: '' }])}>+ Add variable</button>
        </div>
      </div>
      {err && <div style={{ color: '#b91c1c', fontSize: 13 }}>{err}</div>}
    </Modal>
  );
}
