/* global React, Icon, MODELS, RECENT_RESOURCES, ALERTS, ACTIVITY, PROVIDERS */
// Overview / Dashboard page

function Spark({ data, color = 'var(--accent)', filled = true, height = 36 }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 200;
  const h = height;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x},${y}`;
  });
  const path = `M ${points.join(' L ')}`;
  const area = `${path} L ${w},${h} L 0,${h} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height }}>
      {filled && (
        <>
          <defs>
            <linearGradient id={`g-${color.replace(/[^a-z0-9]/gi, '')}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#g-${color.replace(/[^a-z0-9]/gi, '')})`} />
        </>
      )}
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatTile({ label, value, unit, delta, deltaDir, spark, icon, sparkColor }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {icon && <Icon name={icon} size={14} />}
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <div className="stat-value">{value}</div>
        {unit && <div className="muted" style={{ fontSize: 13 }}>{unit}</div>}
      </div>
      {delta != null && (
        <div className={`stat-delta ${deltaDir}`}>
          <Icon name={deltaDir === 'up' ? 'arrowUp' : 'arrowDown'} size={12} />
          {delta} vs last 24h
        </div>
      )}
      {spark && (
        <div style={{ marginTop: 12 }}>
          <Spark data={spark} color={sparkColor || 'var(--accent)'} />
        </div>
      )}
    </div>
  );
}

function ProviderDot({ provider, size = 8 }) {
  const p = PROVIDERS.find(x => x.id === provider);
  return <span style={{ width: size, height: size, borderRadius: '50%', background: p?.color || '#888', display: 'inline-block', flexShrink: 0 }} />;
}

const SPARK_CALLS = [22,28,24,32,38,42,40,52,58,54,62,68,64,72,78,84];
const SPARK_LAT = [420,408,432,418,402,394,386,402,378,392,386,374,382,378,392];
const SPARK_COST = [4,6,5,7,8,9,11,10,13,15,14,18,16,19,22];
const SPARK_ERR = [1.2,0.8,1.0,0.6,0.4,0.5,0.3,0.4,0.2,0.3,0.5,0.4,0.3,0.2,0.3];

function OverviewPage({ onNavigate }) {
  const topModels = MODELS
    .filter(m => m.status === 'active' && m.type === 'chat')
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 5);

  return (
    <div className="page" data-screen-label="overview">
      <div className="breadcrumb">
        <a>orion</a><span className="sep">/</span><span>Overview</span>
      </div>
      <div className="page-header">
        <div>
          <h1 className="h1">Welcome back, Deniz</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Project <strong style={{ color: 'var(--text)' }}>orion</strong> · last 24 hours
          </p>
        </div>
        <div className="row gap-sm">
          <button className="btn btn-secondary">
            <Icon name="download" size={14} />
            Export
          </button>
          <button className="btn btn-primary">
            <Icon name="plus" size={14} />
            Deploy model
          </button>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="stat-grid">
        <StatTile label="Inference calls" icon="zap" value="1.18M" delta="+12.4%" deltaDir="up" spark={SPARK_CALLS} sparkColor="#16b3ab" />
        <StatTile label="P95 latency"     icon="bolt" value="392" unit="ms" delta="-4.1%" deltaDir="down" spark={SPARK_LAT} sparkColor="#2a6fdb" />
        <StatTile label="Error rate"      icon="shield" value="0.31" unit="%" delta="-0.08pp" deltaDir="down" spark={SPARK_ERR} sparkColor="#1f8a5b" />
        <StatTile label="Spend"           icon="graph" value="$4,824" delta="+8.2%" deltaDir="up" spark={SPARK_COST} sparkColor="#c97a16" />
      </div>

      {/* Two-column grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, marginTop: 16 }}>
        {/* Quick start */}
        <div className="card card-pad-lg">
          <div className="row-between" style={{ marginBottom: 16 }}>
            <div className="h3">Get started</div>
            <button className="btn btn-ghost btn-sm">Dismiss</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {[
              { icon: 'brain',    title: 'Deploy a model',     desc: 'Choose a provider and create an inference endpoint.', cta: 'models', step: '01' },
              { icon: 'sparkles', title: 'Publish a prompt',   desc: 'Version-controlled templates with test cases.',        cta: 'prompts', step: '02' },
              { icon: 'robot',    title: 'Wire up an agent',   desc: 'Connect tools and memory into a runnable agent.',     cta: 'agents', step: '03' },
            ].map(s => (
              <div key={s.cta} className="card card-pad interactive" onClick={() => onNavigate(s.cta)} style={{ background: 'var(--surface-1)' }}>
                <div className="row gap-sm" style={{ marginBottom: 10 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'grid', placeItems: 'center' }}>
                    <Icon name={s.icon} size={16} />
                  </div>
                  <span className="eyebrow">Step {s.step}</span>
                </div>
                <div className="h4" style={{ marginBottom: 4 }}>{s.title}</div>
                <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.45 }}>{s.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent activity */}
        <div className="card card-pad-lg">
          <div className="row-between" style={{ marginBottom: 12 }}>
            <div className="h3">Activity</div>
            <button className="btn btn-ghost btn-sm">View all</button>
          </div>
          <div className="col gap-sm">
            {ACTIVITY.map(a => (
              <div key={a.id} className="row" style={{ gap: 10, padding: '4px 0' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: a.who === 'system' ? 'var(--surface-2)' : 'linear-gradient(135deg, var(--teal-6), var(--teal-4))', color: 'white', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
                  {a.who === 'system' ? <Icon name="bolt" size={12} style={{ color: 'var(--text-muted)' }} /> : a.who.split(' ').map(s => s[0]).join('')}
                </div>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.35 }}>
                  <span style={{ fontWeight: 500 }}>{a.who}</span>
                  <span className="muted"> {a.action} </span>
                  <span className="mono" style={{ fontSize: 12.5 }}>{a.target}</span>
                </div>
                <span className="faint" style={{ fontSize: 11.5 }}>{a.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Top models + alerts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, marginTop: 16 }}>
        <div className="card">
          <div className="row-between" style={{ padding: '16px 20px' }}>
            <div>
              <div className="h3">Top models by traffic</div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>Last 24 hours</div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => onNavigate('models')}>
              All models <Icon name="arrowRight" size={12} />
            </button>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Model</th>
                <th style={{ textAlign: 'right' }}>Calls</th>
                <th style={{ textAlign: 'right' }}>P95</th>
                <th style={{ textAlign: 'right' }}>Spend</th>
                <th style={{ width: 120 }}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {topModels.map(m => (
                <tr key={m.id} onClick={() => onNavigate('models', m.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <div className="row gap-sm">
                      <ProviderDot provider={m.provider} />
                      <span className="mono" style={{ fontSize: 12.5 }}>{m.name}</span>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{m.calls.toLocaleString()}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{m.p95}ms</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>${m.cost.toFixed(2)}</td>
                  <td style={{ width: 120, padding: '0 20px 0 12px' }}>
                    <Spark data={[12,18,16,22,20,28,24,32,30,38].map(v => v + Math.random() * 8)} height={24} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="col gap-md">
          <div className="card card-pad-lg">
            <div className="row-between" style={{ marginBottom: 12 }}>
              <div className="h3">Active alerts</div>
              <span className="badge badge-err">{ALERTS.length}</span>
            </div>
            <div className="col gap-sm">
              {ALERTS.map(a => (
                <div key={a.id} className="row" style={{ gap: 10, padding: 12, background: 'var(--surface-1)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border-soft)' }}>
                  <div style={{ width: 26, height: 26, borderRadius: 7, background: `var(--${a.sev === 'err' ? 'err' : 'warn'})`, opacity: 0.12, display: 'grid', placeItems: 'center', flexShrink: 0, position: 'relative' }}>
                    <Icon name={a.sev === 'err' ? 'bell' : 'flag'} size={13} style={{ color: `var(--${a.sev === 'err' ? 'err' : 'warn'})`, opacity: 8 }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{a.title}</div>
                    <div className="faint" style={{ fontSize: 11.5 }}>{a.time}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card card-pad-lg">
            <div className="h3" style={{ marginBottom: 12 }}>Recent resources</div>
            <div className="col">
              {RECENT_RESOURCES.map(r => (
                <div key={r.id} className="row" style={{ gap: 10, padding: '8px 0', borderTop: '1px solid var(--border-soft)' }}>
                  <Icon name={({ agent: 'robot', model: 'brain', rag: 'book', prompt: 'sparkles', tool: 'tool' })[r.type]} size={15} style={{ color: 'var(--text-muted)' }} />
                  <span className="mono" style={{ fontSize: 12.5, flex: 1 }}>{r.name}</span>
                  <span className="faint" style={{ fontSize: 11.5 }}>{r.meta}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { OverviewPage, Spark, ProviderDot });
