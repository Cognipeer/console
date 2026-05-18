/* global React, Icon, MODELS, PROVIDERS, ProviderDot, Spark, StatusBadge, ProviderChip */
// Model detail page — tabbed

function MetricBlock({ label, value, unit, delta, deltaDir }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 4 }}>
        <span style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {unit && <span className="faint" style={{ fontSize: 12 }}>{unit}</span>}
      </div>
      {delta && (
        <div className={`stat-delta ${deltaDir}`} style={{ marginTop: 2 }}>
          <Icon name={deltaDir === 'up' ? 'arrowUp' : 'arrowDown'} size={10} />
          {delta}
        </div>
      )}
    </div>
  );
}

// ── Overview tab ────────────────────────────────────────────────────
function ModelOverviewTab({ model }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
      {/* Main column */}
      <div className="col gap-md">
        {/* Metrics card */}
        <div className="card card-pad-lg">
          <div className="row-between" style={{ marginBottom: 16 }}>
            <div className="h3">Performance · last 24h</div>
            <div className="row gap-xs">
              {['1h', '24h', '7d', '30d'].map((p, i) => (
                <button key={p} className={`btn btn-sm ${i === 1 ? 'btn-secondary' : 'btn-ghost'}`}>{p}</button>
              ))}
            </div>
          </div>
          <div className="row gap-lg" style={{ marginBottom: 20, paddingBottom: 20, borderBottom: '1px solid var(--border-soft)' }}>
            <MetricBlock label="Total calls"   value={model.calls.toLocaleString()} delta="+12.4%" deltaDir="up" />
            <MetricBlock label="P50 latency"   value="148" unit="ms" delta="-3.2%" deltaDir="down" />
            <MetricBlock label="P95 latency"   value={model.p95} unit="ms" delta="-4.1%" deltaDir="down" />
            <MetricBlock label="Error rate"    value="0.24" unit="%" delta="-0.08pp" deltaDir="down" />
            <MetricBlock label="Spend"         value={`$${model.cost.toFixed(2)}`} delta="+8.2%" deltaDir="up" />
          </div>
          <div>
            <div className="row-between" style={{ marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>Calls per minute</span>
              <span className="faint" style={{ fontSize: 11 }}>peak 1,420 / min</span>
            </div>
            <Spark data={Array.from({ length: 48 }, (_, i) => 200 + Math.sin(i / 4) * 80 + Math.random() * 60 + i * 4)} height={120} />
          </div>
        </div>

        {/* Endpoint / SDK */}
        <div className="card card-pad-lg">
          <div className="row-between" style={{ marginBottom: 12 }}>
            <div className="h3">Endpoint</div>
            <button className="btn btn-secondary btn-sm">
              <Icon name="copy" size={12} /> Copy curl
            </button>
          </div>
          <div className="code">
{`POST https://api.cognipeer.io/v1/inference/${model.id}
authorization: Bearer sk-cgnp-prod-***42
content-type: application/json

{
  "messages": [
    { "role": "user", "content": "Summarize the Q3 report." }
  ],
  "temperature": 0.2,
  "max_tokens": 512
}`}
          </div>
        </div>

        {/* Recent requests */}
        <div className="card">
          <div className="row-between" style={{ padding: '14px 20px' }}>
            <div className="h3">Recent requests</div>
            <button className="btn btn-ghost btn-sm">Open tracing <Icon name="arrowRight" size={12} /></button>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Request ID</th>
                <th>Started</th>
                <th>Tokens</th>
                <th>Latency</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {[
                { id: 'req_8f2a91', time: '12s ago',  tokens: '482', ms: 412, status: 'ok' },
                { id: 'req_8f2a8e', time: '34s ago',  tokens: '1,204',ms: 612, status: 'ok' },
                { id: 'req_8f2a8c', time: '1m ago',   tokens: '184', ms: 184, status: 'ok' },
                { id: 'req_8f2a8a', time: '2m ago',   tokens: '—',   ms: 8120, status: 'err' },
                { id: 'req_8f2a87', time: '3m ago',   tokens: '824', ms: 392, status: 'ok' },
              ].map(r => (
                <tr key={r.id} style={{ cursor: 'pointer' }}>
                  <td className="mono" style={{ fontSize: 12 }}>{r.id}</td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{r.time}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.tokens}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.ms}ms</td>
                  <td>{r.status === 'ok' ? <StatusBadge status="active" /> : <span className="badge badge-err"><span className="badge-dot"/>Failed</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Right sidebar */}
      <div className="col gap-md">
        <div className="card card-pad-lg">
          <div className="h4" style={{ marginBottom: 12 }}>Details</div>
          {[
            ['Model ID', <span className="mono" style={{ fontSize: 12 }}>{model.id}</span>],
            ['Provider', <ProviderChip id={model.provider} />],
            ['Type', <span className="badge">{model.type}</span>],
            ['Context window', <span className="mono" style={{ fontSize: 12.5 }}>{model.context}</span>],
            ['Status', <StatusBadge status={model.status} />],
            ['Version', <span className="mono" style={{ fontSize: 12 }}>{model.version}</span>],
            ['Created', <span className="faint" style={{ fontSize: 12.5 }}>Mar 12, 2026</span>],
            ['Last updated', <span className="faint" style={{ fontSize: 12.5 }}>2 days ago</span>],
          ].map(([k, v], i) => (
            <div key={k} className="row-between" style={{ padding: '6px 0', borderTop: i ? '1px solid var(--border-soft)' : 'none', fontSize: 12.5 }}>
              <span className="muted">{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>

        <div className="card card-pad-lg">
          <div className="h4" style={{ marginBottom: 12 }}>Tags</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {model.tags.length === 0 && <span className="faint" style={{ fontSize: 12.5 }}>No tags</span>}
            {model.tags.map(t => <span key={t} className="badge badge-teal">{t}</span>)}
            <button className="badge" style={{ background: 'transparent', border: '1px dashed var(--border-strong)', cursor: 'pointer' }}>
              <Icon name="plus" size={11} /> Add tag
            </button>
          </div>
        </div>

        <div className="card card-pad-lg">
          <div className="h4" style={{ marginBottom: 12 }}>Used by</div>
          <div className="col gap-sm">
            {[
              { icon: 'robot', name: 'customer-support-v2', type: 'agent' },
              { icon: 'robot', name: 'ops-runbook', type: 'agent' },
              { icon: 'sparkles', name: 'intent-classifier', type: 'prompt' },
              { icon: 'book', name: 'product-docs-kb', type: 'rag' },
            ].map(r => (
              <div key={r.name} className="row gap-sm" style={{ fontSize: 12.5 }}>
                <Icon name={r.icon} size={14} style={{ color: 'var(--text-muted)' }} />
                <span className="mono" style={{ flex: 1, fontSize: 12 }}>{r.name}</span>
                <span className="faint">{r.type}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Playground tab ──────────────────────────────────────────────────
function ModelPlaygroundTab({ model }) {
  const [system, setSystem] = React.useState('You are a helpful assistant for an enterprise AI platform. Answer concisely.');
  const [user, setUser] = React.useState('Summarize what RAG is in two sentences.');
  const [response, setResponse] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const [temperature, setTemperature] = React.useState(0.2);
  const [maxTokens, setMaxTokens] = React.useState(512);

  const run = () => {
    setRunning(true);
    setResponse('');
    const text = 'Retrieval-Augmented Generation grounds a language model in your own data by fetching relevant passages at query time and conditioning the response on them. It reduces hallucinations and keeps answers current without retraining the model.';
    let i = 0;
    const tick = () => {
      i += Math.max(2, Math.floor(Math.random() * 6));
      setResponse(text.slice(0, i));
      if (i < text.length) setTimeout(tick, 22);
      else setRunning(false);
    };
    setTimeout(tick, 350);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 280px', gap: 16, minHeight: 540 }}>
      {/* Input */}
      <div className="card card-pad-lg col gap-md">
        <div className="row-between">
          <div className="h4">Input</div>
          <button className="btn btn-ghost btn-sm">
            <Icon name="copy" size={12} /> Copy
          </button>
        </div>
        <div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>System</div>
          <textarea className="input" rows={3} value={system} onChange={e => setSystem(e.target.value)} style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }} />
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>User message</div>
          <textarea className="input" value={user} onChange={e => setUser(e.target.value)} style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, flex: 1, minHeight: 200 }} />
        </div>
        <div className="row gap-sm">
          <button className="btn btn-primary" onClick={run} disabled={running} style={{ flex: 1 }}>
            {running ? (
              <>
                <Icon name="spinner" size={14} style={{ animation: 'spin 1s linear infinite' }} />
                Running…
              </>
            ) : (
              <>
                <Icon name="play" size={12} /> Run · ⌘↵
              </>
            )}
          </button>
          <button className="btn btn-secondary">
            <Icon name="copy" size={14} />
          </button>
        </div>
      </div>

      {/* Output */}
      <div className="card card-pad-lg col gap-md">
        <div className="row-between">
          <div className="row gap-sm">
            <div className="h4">Output</div>
            {response && !running && (
              <span className="badge badge-ok">
                <span className="badge-dot" />
                412ms · 82 tokens
              </span>
            )}
          </div>
          <button className="btn btn-ghost btn-sm">
            <Icon name="copy" size={12} /> Copy
          </button>
        </div>
        <div style={{ flex: 1, padding: 16, background: 'var(--surface-1)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border-soft)', overflowY: 'auto', minHeight: 280 }}>
          {response ? (
            <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {response}
              {running && <span style={{ display: 'inline-block', width: 8, height: 14, background: 'var(--accent)', marginLeft: 2, verticalAlign: 'middle', animation: 'blink 1s infinite' }} />}
            </div>
          ) : (
            <div className="faint" style={{ fontSize: 13, fontStyle: 'italic' }}>
              {running ? 'Waiting for first token…' : 'Click "Run" to send a request.'}
            </div>
          )}
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}@keyframes blink{50%{opacity:0}}`}</style>
      </div>

      {/* Params */}
      <div className="card card-pad-lg col gap-md">
        <div className="h4">Parameters</div>
        <div>
          <div className="row-between" style={{ fontSize: 12, marginBottom: 6 }}>
            <span className="muted">Temperature</span>
            <span className="mono">{temperature.toFixed(2)}</span>
          </div>
          <input type="range" min="0" max="1" step="0.05" value={temperature} onChange={e => setTemperature(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--accent)' }} />
        </div>
        <div>
          <div className="row-between" style={{ fontSize: 12, marginBottom: 6 }}>
            <span className="muted">Max tokens</span>
            <span className="mono">{maxTokens}</span>
          </div>
          <input type="range" min="64" max="4096" step="64" value={maxTokens} onChange={e => setMaxTokens(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--accent)' }} />
        </div>
        <div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Top P</div>
          <input type="range" min="0" max="1" step="0.05" defaultValue="1" style={{ width: '100%', accentColor: 'var(--accent)' }} />
        </div>
        <div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Response format</div>
          <select className="select"><option>text</option><option>json_object</option></select>
        </div>
        <div className="divider" />
        <button className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }}>
          <Icon name="upload" size={12} /> Load preset
        </button>
        <button className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }}>
          <Icon name="download" size={12} /> Save as preset
        </button>
      </div>
    </div>
  );
}

// ── Configure tab ───────────────────────────────────────────────────
function ModelConfigureTab({ model }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16 }}>
      <div className="col gap-md">
        <div className="card card-pad-lg">
          <div className="h3" style={{ marginBottom: 4 }}>General</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>Display name and routing identifier for this deployment.</div>
          <div className="col gap-md">
            <div>
              <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Display name</label>
              <input className="input" defaultValue={model.name} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Endpoint ID</label>
                <input className="input mono" defaultValue={model.id} style={{ fontSize: 12.5 }} />
              </div>
              <div>
                <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Version</label>
                <input className="input mono" defaultValue={model.version} style={{ fontSize: 12.5 }} />
              </div>
            </div>
            <div>
              <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Description</label>
              <textarea className="input" rows={2} defaultValue={`Default ${model.type} endpoint for the orion project.`} />
            </div>
          </div>
        </div>

        <div className="card card-pad-lg">
          <div className="h3" style={{ marginBottom: 4 }}>Routing &amp; limits</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>Configure rate limits, fallbacks, and routing behavior.</div>
          <div className="col gap-md">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Requests / min</label>
                <input className="input mono" defaultValue="2000" />
              </div>
              <div>
                <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Tokens / min</label>
                <input className="input mono" defaultValue="2,000,000" />
              </div>
            </div>
            <div>
              <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Fallback model</label>
              <select className="select">
                <option>None</option>
                <option>gpt-4o-mini</option>
                <option>claude-haiku-3.5</option>
              </select>
            </div>
            <label className="row gap-sm" style={{ cursor: 'pointer' }}>
              <input type="checkbox" className="checkbox" defaultChecked />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Auto-retry on transient failure</div>
                <div className="muted" style={{ fontSize: 12 }}>Retries up to 2 times on 5xx and timeout errors.</div>
              </div>
            </label>
            <label className="row gap-sm" style={{ cursor: 'pointer' }}>
              <input type="checkbox" className="checkbox" defaultChecked />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Cache identical requests for 60s</div>
                <div className="muted" style={{ fontSize: 12 }}>Reduces cost on repeated identical prompts.</div>
              </div>
            </label>
          </div>
        </div>

        <div className="card card-pad-lg" style={{ borderColor: 'rgba(201, 59, 59, 0.2)' }}>
          <div className="h3" style={{ marginBottom: 4, color: 'var(--err)' }}>Danger zone</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>Irreversible actions for this deployment.</div>
          <div className="row-between" style={{ padding: '12px 0', borderTop: '1px solid var(--border-soft)' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Pause deployment</div>
              <div className="muted" style={{ fontSize: 12 }}>New requests will return 503 until resumed.</div>
            </div>
            <button className="btn btn-secondary btn-sm">Pause</button>
          </div>
          <div className="row-between" style={{ padding: '12px 0', borderTop: '1px solid var(--border-soft)' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Delete deployment</div>
              <div className="muted" style={{ fontSize: 12 }}>This cannot be undone.</div>
            </div>
            <button className="btn btn-secondary btn-sm" style={{ color: 'var(--err)', borderColor: 'rgba(201,59,59,0.3)' }}>Delete</button>
          </div>
        </div>
      </div>

      <div className="col gap-md">
        <div className="card card-pad-lg">
          <div className="h4" style={{ marginBottom: 12 }}>Save changes</div>
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
            Configuration changes take effect within ~60s on all replicas.
          </p>
          <button className="btn btn-primary" style={{ width: '100%' }}>
            <Icon name="check" size={14} /> Save changes
          </button>
          <button className="btn btn-ghost" style={{ width: '100%', marginTop: 6 }}>
            Discard
          </button>
        </div>
        <div className="card card-pad-lg">
          <div className="h4" style={{ marginBottom: 8 }}>Help</div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Learn how rate limits interact with fallback routing.
          </div>
          <a className="btn btn-ghost btn-sm" style={{ marginTop: 8, paddingLeft: 0 }}>
            Read docs <Icon name="external" size={11} />
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Logs tab ────────────────────────────────────────────────────────
function ModelLogsTab() {
  const logs = [
    { lvl: 'info', ts: '14:32:18.412', msg: 'POST /v1/inference req_8f2a91 ok 412ms 482 tok' },
    { lvl: 'info', ts: '14:32:17.984', msg: 'POST /v1/inference req_8f2a8e ok 612ms 1204 tok' },
    { lvl: 'info', ts: '14:32:14.221', msg: 'POST /v1/inference req_8f2a8c ok 184ms 184 tok' },
    { lvl: 'warn', ts: '14:32:09.842', msg: 'req_8f2a8a slow upstream, took 8120ms' },
    { lvl: 'err',  ts: '14:32:09.840', msg: 'req_8f2a8a upstream timeout after 8000ms — returning 504' },
    { lvl: 'info', ts: '14:32:01.184', msg: 'POST /v1/inference req_8f2a87 ok 392ms 824 tok' },
    { lvl: 'info', ts: '14:31:58.420', msg: 'cache hit req_8f2a83 → req_8f2a72 (saved 412ms)' },
    { lvl: 'info', ts: '14:31:42.881', msg: 'POST /v1/inference req_8f2a72 ok 412ms 482 tok' },
    { lvl: 'info', ts: '14:31:38.224', msg: 'rate limit consumed: 1842 / 2000 rpm' },
    { lvl: 'info', ts: '14:31:21.992', msg: 'POST /v1/inference req_8f2a5c ok 286ms 412 tok' },
  ];
  const colors = { info: 'var(--text-muted)', warn: 'var(--warn)', err: 'var(--err)' };
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="toolbar">
        <div className="toolbar-search">
          <Icon name="search" size={14} style={{ color: 'var(--text-muted)' }} />
          <input placeholder="Filter logs…" />
        </div>
        <select className="select" style={{ width: 120 }}>
          <option>All levels</option>
          <option>Errors only</option>
          <option>Warnings+</option>
        </select>
        <div style={{ flex: 1 }} />
        <span className="row gap-xs muted" style={{ fontSize: 12.5 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', boxShadow: '0 0 0 3px rgba(31,138,91,0.18)' }} />
          Live
        </span>
        <button className="btn btn-secondary btn-sm">
          <Icon name="pause" size={12} /> Pause
        </button>
        <button className="btn btn-ghost btn-sm">
          <Icon name="download" size={13} />
        </button>
      </div>
      <div style={{ background: 'var(--code-bg)', fontFamily: 'var(--font-mono)', fontSize: 12, padding: 16, maxHeight: 480, overflowY: 'auto' }}>
        {logs.map((l, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, padding: '3px 0', borderBottom: '1px solid var(--border-soft)' }}>
            <span className="faint">{l.ts}</span>
            <span style={{ color: colors[l.lvl], textTransform: 'uppercase', fontWeight: 500, width: 36, fontSize: 10.5, alignSelf: 'center' }}>{l.lvl}</span>
            <span style={{ flex: 1, color: 'var(--text)' }}>{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Versions tab ────────────────────────────────────────────────────
function ModelVersionsTab({ model }) {
  const versions = [
    { v: model.version, status: 'active',   traffic: 100, deployed: '2 days ago', by: 'Deniz K.', note: 'Production' },
    { v: '1.3',         status: 'archived', traffic: 0,   deployed: '3 weeks ago', by: 'Aylin Ö.', note: '' },
    { v: '1.2',         status: 'archived', traffic: 0,   deployed: '2 months ago',by: 'Aylin Ö.', note: '' },
    { v: '1.1',         status: 'archived', traffic: 0,   deployed: '3 months ago',by: 'Deniz K.', note: 'Initial release' },
  ];
  return (
    <div className="card">
      <table className="tbl">
        <thead>
          <tr>
            <th>Version</th>
            <th>Status</th>
            <th>Traffic</th>
            <th>Deployed</th>
            <th>By</th>
            <th>Note</th>
            <th style={{ width: 40 }}></th>
          </tr>
        </thead>
        <tbody>
          {versions.map(v => (
            <tr key={v.v}>
              <td className="mono" style={{ fontSize: 12.5 }}>{v.v}</td>
              <td>{v.status === 'active' ? <StatusBadge status="active" /> : <span className="badge">Archived</span>}</td>
              <td>
                <div className="row gap-sm" style={{ width: 140 }}>
                  <div style={{ flex: 1, height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${v.traffic}%`, height: '100%', background: v.traffic > 0 ? 'var(--accent)' : 'transparent', borderRadius: 3 }} />
                  </div>
                  <span className="mono faint" style={{ fontSize: 11.5 }}>{v.traffic}%</span>
                </div>
              </td>
              <td className="muted" style={{ fontSize: 12.5 }}>{v.deployed}</td>
              <td className="muted" style={{ fontSize: 12.5 }}>{v.by}</td>
              <td className="faint" style={{ fontSize: 12.5 }}>{v.note || '—'}</td>
              <td>
                <button className="btn btn-ghost btn-sm btn-icon"><Icon name="more" size={14} /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main detail page ───────────────────────────────────────────────
function ModelDetailPage({ modelId, onNavigate }) {
  const [tab, setTab] = React.useState('overview');
  const model = MODELS.find(m => m.id === modelId) || MODELS[0];

  const tabs = [
    { id: 'overview',   label: 'Overview',  icon: 'dashboard' },
    { id: 'playground', label: 'Playground',icon: 'play' },
    { id: 'configure',  label: 'Configure', icon: 'settings' },
    { id: 'logs',       label: 'Logs',      icon: 'timeline' },
    { id: 'versions',   label: 'Versions',  icon: 'layers' },
  ];

  return (
    <div className="page" style={{ paddingTop: 24, paddingBottom: 24 }} data-screen-label={`model-${model.id}`}>
      <div className="breadcrumb">
        <a onClick={() => onNavigate('overview')}>orion</a>
        <span className="sep">/</span>
        <a onClick={() => onNavigate('models')}>Models</a>
        <span className="sep">/</span>
        <span className="mono">{model.name}</span>
      </div>

      <div className="page-header" style={{ alignItems: 'center' }}>
        <div className="row gap-md" style={{ flex: 1, minWidth: 0 }}>
          <div style={{ width: 52, height: 52, borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <Icon name="brain" size={26} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
              <h1 className="h2 mono" style={{ margin: 0, whiteSpace: 'nowrap' }}>{model.name}</h1>
              <StatusBadge status={model.status} />
              {model.tags.map(t => <span key={t} className="badge badge-teal">{t}</span>)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-muted)' }}>
              <ProviderChip id={model.provider} />
              <span className="faint">·</span>
              <span style={{ whiteSpace: 'nowrap' }}>{model.context} context</span>
              <span className="faint">·</span>
              <span className="mono" style={{ whiteSpace: 'nowrap' }}>{model.version}</span>
            </div>
          </div>
        </div>
        <div className="row gap-sm" style={{ flexShrink: 0 }}>
          <button className="btn btn-ghost btn-icon" title="Pin">
            <Icon name="pin" size={14} />
          </button>
          <button className="btn btn-secondary">
            <Icon name="copy" size={14} /> Endpoint
          </button>
          <button className="btn btn-secondary">
            <Icon name="play" size={13} /> Test
          </button>
          <button className="btn btn-secondary btn-icon">
            <Icon name="more" size={14} />
          </button>
        </div>
      </div>

      <div className="tabs">
        {tabs.map(t => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={14} />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview'   && <ModelOverviewTab   model={model} />}
      {tab === 'playground' && <ModelPlaygroundTab model={model} />}
      {tab === 'configure'  && <ModelConfigureTab  model={model} />}
      {tab === 'logs'       && <ModelLogsTab />}
      {tab === 'versions'   && <ModelVersionsTab   model={model} />}
    </div>
  );
}

Object.assign(window, { ModelDetailPage });
