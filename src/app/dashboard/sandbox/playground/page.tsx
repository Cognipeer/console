'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { IconArrowLeft, IconPlayerPlay, IconPlus, IconRefresh } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { InstanceModal, RunnerModal } from '../SandboxModals';
import { RunnerSetup } from '../SandboxHelp';
import {
  sandboxApi,
  type SandboxInstance,
  type SandboxRunner,
  type SandboxTemplate,
  type SandboxVolume,
} from '../_lib/api';

const card: CSSProperties = { border: '1px solid var(--ds-border, #e5e7eb)', borderRadius: 10, padding: 16, background: 'var(--ds-surface, #fff)' };
const input: CSSProperties = { padding: '7px 10px', borderRadius: 6, border: '1px solid var(--ds-border, #d1d5db)', fontSize: 13, background: 'var(--ds-surface, #fff)', color: 'inherit' };
const btn: CSSProperties = { padding: '7px 14px', borderRadius: 6, border: '1px solid var(--ds-border, #d1d5db)', background: 'var(--ds-surface, #f9fafb)', cursor: 'pointer', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 };
const btnPrimary: CSSProperties = { ...btn, background: 'var(--ds-accent, #2563eb)', color: '#fff', border: 'none' };
const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

type Lang = 'python' | 'javascript' | 'typescript' | 'bash';
const SAMPLES: Record<Lang, string> = {
  python: 'import sys, os\nprint("hello from python", sys.version.split()[0])\nprint("env FOO =", os.environ.get("FOO"))',
  javascript: 'console.log("hello from node", process.version);\nconsole.log("env FOO =", process.env.FOO);',
  typescript: 'const msg: string = "hello from tsx";\nconsole.log(msg, process.version);',
  bash: 'echo "hello from bash"; uname -a; echo "FOO=$FOO"',
};

// Toolbox (fs / git / sessions) operation presets. `:sid` / `:cmdId` in the
// path are substituted from the body fields of the same name (then removed).
interface ToolboxOp { id: string; method: 'GET' | 'POST'; body: Record<string, unknown> }
const TOOLBOX_OPS: ToolboxOp[] = [
  { id: 'fs/list', method: 'POST', body: { path: '/workspace' } },
  { id: 'fs/info', method: 'POST', body: { path: '/workspace' } },
  { id: 'fs/read', method: 'POST', body: { path: '/workspace/README' } },
  { id: 'fs/write', method: 'POST', body: { path: '/workspace/note.txt', content: 'hello toolbox\n' } },
  { id: 'fs/mkdir', method: 'POST', body: { path: '/workspace/newdir' } },
  { id: 'fs/delete', method: 'POST', body: { path: '/workspace/note.txt', recursive: false } },
  { id: 'fs/move', method: 'POST', body: { source: '/workspace/a.txt', destination: '/workspace/b.txt' } },
  { id: 'fs/find', method: 'POST', body: { path: '/workspace', pattern: 'TODO' } },
  { id: 'fs/replace', method: 'POST', body: { files: ['/workspace/note.txt'], pattern: 'hello', newValue: 'hi' } },
  { id: 'fs/permissions', method: 'POST', body: { path: '/workspace/note.txt', mode: '644' } },
  { id: 'git/clone', method: 'POST', body: { url: 'https://github.com/octocat/Hello-World.git', path: '/workspace/hello' } },
  { id: 'git/status', method: 'POST', body: { path: '/workspace/hello' } },
  { id: 'git/branches', method: 'POST', body: { path: '/workspace/hello' } },
  { id: 'git/log', method: 'POST', body: { path: '/workspace/hello', limit: 10 } },
  { id: 'git/checkout', method: 'POST', body: { path: '/workspace/hello', branch: 'master' } },
  { id: 'git/add', method: 'POST', body: { path: '/workspace/hello', files: [] } },
  { id: 'git/commit', method: 'POST', body: { path: '/workspace/hello', message: 'update', author: 'Me', email: 'me@example.com' } },
  { id: 'sessions', method: 'POST', body: {} },
  { id: 'sessions/:sid/exec', method: 'POST', body: { sid: '<sessionId>', command: 'for i in 1 2 3; do echo line-$i; sleep 1; done', cwd: '/workspace' } },
  { id: 'sessions/:sid/commands/:cmdId/logs', method: 'GET', body: { sid: '<sessionId>', cmdId: '<commandId>' } },
];

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  ms: number;
}

export default function PlaygroundPage() {
  const [instances, setInstances] = useState<SandboxInstance[]>([]);
  const [templates, setTemplates] = useState<SandboxTemplate[]>([]);
  const [runners, setRunners] = useState<SandboxRunner[]>([]);
  const [volumes, setVolumes] = useState<SandboxVolume[]>([]);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'code' | 'shell' | 'toolbox'>('code');
  const [lang, setLang] = useState<Lang>('python');
  const [code, setCode] = useState(SAMPLES.python);
  const [command, setCommand] = useState('echo "FOO=$FOO" && ls -la /workspace');
  const [tbOp, setTbOp] = useState<string>(TOOLBOX_OPS[0].id);
  const [tbBody, setTbBody] = useState<string>(JSON.stringify(TOOLBOX_OPS[0].body, null, 2));
  const [tbResult, setTbResult] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showRunner, setShowRunner] = useState(false);
  const [runnerSetup, setRunnerSetup] = useState<{ token: string; slug: string } | null>(null);

  const onlineRunners = runners.filter((r) => r.status === 'online').length;

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const [i, t, r, v] = await Promise.all([
        sandboxApi.listInstances(),
        sandboxApi.listTemplates(),
        sandboxApi.listRunners(),
        sandboxApi.listVolumes(),
      ]);
      setInstances(i.instances);
      setTemplates(t.templates);
      setRunners(r.runners);
      setVolumes(v.volumes);
      setSelected((cur) => cur || i.instances.find((x) => x.actualState === 'running')?.id || i.instances[0]?.id || '');
      setError(null);
      return (
        i.instances.some((x) => ['pending', 'creating', 'starting', 'stopping'].includes(x.actualState)) ||
        r.runners.some((x) => x.status === 'pending')
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  // Adaptive polling: faster while sandboxes/runners are still settling.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const tick = async () => {
      const transitional = await load();
      if (cancelled) return;
      timer = setTimeout(tick, transitional ? 2000 : 6000);
    };
    void load().then((t) => { if (!cancelled) timer = setTimeout(tick, t ? 2000 : 6000); });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [load]);

  const current = instances.find((i) => i.id === selected) ?? null;

  const onLangChange = (l: Lang) => {
    setLang(l);
    if (!code.trim() || Object.values(SAMPLES).includes(code)) setCode(SAMPLES[l]);
  };

  const onTbOpChange = (opId: string) => {
    setTbOp(opId);
    const def = TOOLBOX_OPS.find((o) => o.id === opId);
    if (def) setTbBody(JSON.stringify(def.body, null, 2));
  };

  const run = async () => {
    if (!selected) {
      setError('Select a sandbox first.');
      return;
    }
    setRunning(true);
    setResult(null);
    setTbResult(null);
    setError(null);
    const t0 = Date.now();
    try {
      if (mode === 'toolbox') {
        const def = TOOLBOX_OPS.find((o) => o.id === tbOp);
        if (!def) throw new Error('unknown operation');
        let body: Record<string, unknown>;
        try {
          body = tbBody.trim() ? (JSON.parse(tbBody) as Record<string, unknown>) : {};
        } catch {
          throw new Error('Request body is not valid JSON');
        }
        let sub = def.id;
        if (sub.includes(':sid')) { sub = sub.replace(':sid', encodeURIComponent(String(body.sid ?? ''))); delete body.sid; }
        if (sub.includes(':cmdId')) { sub = sub.replace(':cmdId', encodeURIComponent(String(body.cmdId ?? ''))); delete body.cmdId; }
        const res = await sandboxApi.toolbox(selected, sub, def.method, body);
        setTbResult(JSON.stringify(res, null, 2));
        setResult({ exitCode: 0, stdout: '', stderr: '', ms: Date.now() - t0 });
      } else {
        const res =
          mode === 'code'
            ? await sandboxApi.codeInstance(selected, { code, language: lang })
            : await sandboxApi.execInstance(selected, { command });
        setResult({ ...res, ms: Date.now() - t0 });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const stateColor = (s?: string) => (s === 'running' ? '#10b981' : s === 'failed' ? '#ef4444' : '#6b7280');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Agent Sandbox"
        title="Playground"
        subtitle="Pick a running sandbox and execute code or shell commands — see the output live."
        actions={
          <Link href="/dashboard/sandbox" style={{ ...btn, textDecoration: 'none', color: 'inherit' }}>
            <IconArrowLeft size={15} /> Back
          </Link>
        }
      />

      {error && (
        <div style={{ ...card, borderColor: '#fca5a5', background: '#fef2f2', color: '#b91c1c', marginBottom: 16 }}>{error}</div>
      )}

      {/* Sandbox picker */}
      <div style={{ ...card, marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--ds-muted, #6b7280)', fontWeight: 600 }}>Sandbox</span>
        <select style={{ ...input, minWidth: 280 }} value={selected} onChange={(e) => setSelected(e.target.value)}>
          {instances.length === 0 && <option value="">No sandboxes — create one →</option>}
          {instances.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} · {i.actualState}
            </option>
          ))}
        </select>
        {current && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: stateColor(current.actualState) }} />
            {current.actualState}
          </span>
        )}
        <button style={btn} onClick={() => void load()}><IconRefresh size={14} /> Refresh</button>
        <button style={btn} onClick={() => setShowRunner(true)}><IconPlus size={14} /> Add runner</button>
        <button style={btn} onClick={() => setShowCreate(true)}><IconPlus size={14} /> New sandbox</button>
        {onlineRunners === 0 && (
          <span style={{ fontSize: 12, color: '#b45309' }}>
            No online runner — click “Add runner” for the one-line command to start one.
          </span>
        )}
        {current && current.actualState !== 'running' && (
          <span style={{ fontSize: 12, color: current.actualState === 'failed' ? '#b91c1c' : '#b45309' }}>
            {current.lastError
              ? `${current.actualState}: ${current.lastError}`
              : `Sandbox is “${current.actualState}” — first run may take a moment while the image is prepared.`}
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Editor */}
        <div style={card}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
            <div style={{ display: 'inline-flex', border: '1px solid var(--ds-border, #d1d5db)', borderRadius: 6, overflow: 'hidden' }}>
              <button
                onClick={() => setMode('code')}
                style={{ ...btn, border: 'none', borderRadius: 0, background: mode === 'code' ? 'var(--ds-accent, #2563eb)' : 'transparent', color: mode === 'code' ? '#fff' : 'inherit' }}
              >
                Code
              </button>
              <button
                onClick={() => setMode('shell')}
                style={{ ...btn, border: 'none', borderRadius: 0, background: mode === 'shell' ? 'var(--ds-accent, #2563eb)' : 'transparent', color: mode === 'shell' ? '#fff' : 'inherit' }}
              >
                Shell
              </button>
              <button
                onClick={() => setMode('toolbox')}
                style={{ ...btn, border: 'none', borderRadius: 0, background: mode === 'toolbox' ? 'var(--ds-accent, #2563eb)' : 'transparent', color: mode === 'toolbox' ? '#fff' : 'inherit' }}
              >
                API
              </button>
            </div>
            {mode === 'code' && (
              <select style={input} value={lang} onChange={(e) => onLangChange(e.target.value as Lang)}>
                <option value="python">Python</option>
                <option value="javascript">JavaScript (node)</option>
                <option value="typescript">TypeScript (tsx)</option>
                <option value="bash">Bash</option>
              </select>
            )}
            {mode === 'toolbox' && (
              <select style={{ ...input, minWidth: 240 }} value={tbOp} onChange={(e) => onTbOpChange(e.target.value)}>
                {TOOLBOX_OPS.map((o) => (
                  <option key={o.id} value={o.id}>{o.method} {o.id}</option>
                ))}
              </select>
            )}
            <div style={{ flex: 1 }} />
            <button style={btnPrimary} disabled={running || !selected} onClick={run}>
              <IconPlayerPlay size={15} /> {running ? 'Running…' : 'Run'}
            </button>
          </div>

          {mode === 'code' && (
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              style={{ width: '100%', height: 320, fontFamily: mono, fontSize: 13, padding: 12, borderRadius: 8, border: '1px solid var(--ds-border, #d1d5db)', background: '#0b0f17', color: '#d1d5db', resize: 'vertical' }}
            />
          )}
          {mode === 'shell' && (
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
              spellCheck={false}
              placeholder="shell command (runs via sh -c)"
              style={{ width: '100%', fontFamily: mono, fontSize: 13, padding: 12, borderRadius: 8, border: '1px solid var(--ds-border, #d1d5db)', background: '#0b0f17', color: '#d1d5db' }}
            />
          )}
          {mode === 'toolbox' && (
            <>
              <div style={{ fontSize: 12, color: 'var(--ds-muted, #6b7280)', marginBottom: 6 }}>
                Request body (JSON) for <code>{TOOLBOX_OPS.find((o) => o.id === tbOp)?.method} /…/{tbOp}</code>.
                {tbOp.includes(':sid') && ' Fill sid / cmdId from a previous “sessions” / “exec” response.'}
              </div>
              <textarea
                value={tbBody}
                onChange={(e) => setTbBody(e.target.value)}
                spellCheck={false}
                style={{ width: '100%', height: 290, fontFamily: mono, fontSize: 13, padding: 12, borderRadius: 8, border: '1px solid var(--ds-border, #d1d5db)', background: '#0b0f17', color: '#d1d5db', resize: 'vertical' }}
              />
            </>
          )}
        </div>

        {/* Output */}
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{mode === 'toolbox' ? 'Response' : 'Output'}</span>
            {result && (
              <span style={{ fontSize: 12, color: result.exitCode === 0 ? '#10b981' : '#ef4444' }}>
                {mode === 'toolbox' ? 'ok' : `exit ${result.exitCode}${result.timedOut ? ' (timeout)' : ''}`} · {result.ms} ms
              </span>
            )}
          </div>
          <pre style={{ margin: 0, height: 360, overflow: 'auto', padding: 12, borderRadius: 8, background: '#0b0f17', color: '#d1d5db', fontFamily: mono, fontSize: 13, whiteSpace: 'pre-wrap' }}>
            {running
              ? '⏳ running…'
              : mode === 'toolbox'
                ? tbResult ?? 'Pick an operation, edit the JSON body, then Run.'
                : result
                  ? `${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}` || '(no output)'
                  : 'Run code or a command to see output here.'}
          </pre>
        </div>
      </div>

      {showCreate && (
        <InstanceModal
          templates={templates}
          runners={runners}
          volumes={volumes}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); void load(); }}
        />
      )}
      {showRunner && (
        <RunnerModal
          onClose={() => setShowRunner(false)}
          onCreated={(r, token, slug) => {
            setShowRunner(false);
            void (async () => {
              try {
                await sandboxApi.startRunner(r.id);
              } catch {
                setRunnerSetup({ token, slug });
              }
              await load();
            })();
          }}
        />
      )}
      {runnerSetup && (
        <RunnerSetup token={runnerSetup.token} tenantSlug={runnerSetup.slug} onClose={() => setRunnerSetup(null)} />
      )}
    </PageContainer>
  );
}
