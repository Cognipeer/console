/* global React, Icon, MODELS, PROVIDERS, ProviderDot, Spark */
// Models list page — hybrid table/grid

function StatusBadge({ status }) {
  const map = {
    active:   { cls: 'badge-ok',   label: 'Active' },
    paused:   { cls: 'badge',      label: 'Paused' },
    degraded: { cls: 'badge-warn', label: 'Degraded' },
    failed:   { cls: 'badge-err',  label: 'Failed' },
  };
  const c = map[status] || map.active;
  return (
    <span className={`badge ${c.cls}`}>
      <span className="badge-dot" />
      {c.label}
    </span>
  );
}

function ProviderChip({ id }) {
  const p = PROVIDERS.find(x => x.id === id);
  if (!p) return null;
  return (
    <span className="row gap-xs" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
      <ProviderDot provider={id} />
      <span>{p.name}</span>
    </span>
  );
}

function ModelsPage({ onNavigate, onDeploy }) {
  const [view, setView] = React.useState('table');
  const [query, setQuery] = React.useState('');
  const [filterType, setFilterType] = React.useState('all');
  const [filterProvider, setFilterProvider] = React.useState('all');
  const [selected, setSelected] = React.useState(new Set());

  const filtered = MODELS.filter(m => {
    if (query && !m.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (filterType !== 'all' && m.type !== filterType) return false;
    if (filterProvider !== 'all' && m.provider !== filterProvider) return false;
    return true;
  });

  const toggle = (id) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };
  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(m => m.id)));
  };

  const typeOptions = ['all', 'chat', 'embedding', 'rerank', 'audio'];

  return (
    <div className="page" style={{ paddingTop: 24, paddingBottom: 24 }} data-screen-label="models">
      <div className="breadcrumb">
        <a>orion</a><span className="sep">/</span><span>Models</span>
      </div>
      <div className="page-header">
        <div>
          <h1 className="h1">Models</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Manage inference endpoints across providers. {MODELS.length} deployed in this project.
          </p>
        </div>
        <div className="row gap-sm">
          <button className="btn btn-secondary">
            <Icon name="external" size={14} />
            Browse catalog
          </button>
          <button className="btn btn-primary" onClick={onDeploy}>
            <Icon name="plus" size={14} />
            Deploy model
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        <button className="tab active">
          All <span className="tab-count">{MODELS.length}</span>
        </button>
        <button className="tab">
          Production <span className="tab-count">{MODELS.filter(m => m.tags.includes('production')).length}</span>
        </button>
        <button className="tab">
          Self-hosted <span className="tab-count">{MODELS.filter(m => m.tags.includes('self-hosted')).length}</span>
        </button>
        <button className="tab">Archived</button>
      </div>

      {/* Table card */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="toolbar">
          <div className="toolbar-search">
            <Icon name="search" size={14} style={{ color: 'var(--text-muted)' }} />
            <input placeholder="Filter by name…" value={query} onChange={e => setQuery(e.target.value)} />
          </div>

          <select className="select" style={{ width: 140 }} value={filterType} onChange={e => setFilterType(e.target.value)}>
            {typeOptions.map(t => (
              <option key={t} value={t}>{t === 'all' ? 'All types' : t.charAt(0).toUpperCase() + t.slice(1)}</option>
            ))}
          </select>

          <select className="select" style={{ width: 160 }} value={filterProvider} onChange={e => setFilterProvider(e.target.value)}>
            <option value="all">All providers</option>
            {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <div style={{ flex: 1 }} />

          {selected.size > 0 && (
            <>
              <span className="muted" style={{ fontSize: 13 }}>{selected.size} selected</span>
              <button className="btn btn-secondary btn-sm">
                <Icon name="pause" size={12} /> Pause
              </button>
              <button className="btn btn-secondary btn-sm" style={{ color: 'var(--err)' }}>
                <Icon name="trash" size={12} /> Delete
              </button>
              <div style={{ width: 1, height: 20, background: 'var(--border-soft)' }} />
            </>
          )}

          <button className="btn btn-ghost btn-sm" aria-label="Refresh">
            <Icon name="refresh" size={14} />
          </button>

          {/* View toggle */}
          <div style={{ display: 'flex', background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', padding: 2 }}>
            <button
              className={`btn btn-sm ${view === 'table' ? 'btn-secondary' : 'btn-ghost'}`}
              style={{ height: 24, padding: '0 8px', boxShadow: view === 'table' ? 'var(--shadow-xs)' : 'none', background: view === 'table' ? 'var(--surface-raised)' : 'transparent', border: 'none' }}
              onClick={() => setView('table')}
              aria-label="Table view"
            >
              <Icon name="dashboard" size={13} />
            </button>
            <button
              className={`btn btn-sm ${view === 'grid' ? 'btn-secondary' : 'btn-ghost'}`}
              style={{ height: 24, padding: '0 8px', boxShadow: view === 'grid' ? 'var(--shadow-xs)' : 'none', background: view === 'grid' ? 'var(--surface-raised)' : 'transparent', border: 'none' }}
              onClick={() => setView('grid')}
              aria-label="Grid view"
            >
              <Icon name="layers" size={13} />
            </button>
          </div>
        </div>

        {view === 'table' ? (
          <div style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input type="checkbox" className="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} />
                  </th>
                  <th>Name</th>
                  <th>Provider</th>
                  <th>Type</th>
                  <th>Context</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Calls (24h)</th>
                  <th style={{ textAlign: 'right' }}>P95</th>
                  <th style={{ textAlign: 'right' }}>Spend (24h)</th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(m => (
                  <tr
                    key={m.id}
                    className={selected.has(m.id) ? 'selected' : ''}
                    onClick={() => onNavigate('models', m.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td onClick={(e) => { e.stopPropagation(); toggle(m.id); }}>
                      <input type="checkbox" className="checkbox" checked={selected.has(m.id)} onChange={() => {}} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div className="col" style={{ gap: 2 }}>
                        <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{m.name}</span>
                        <span className="faint mono" style={{ fontSize: 11 }}>{m.version}</span>
                      </div>
                    </td>
                    <td><ProviderChip id={m.provider} /></td>
                    <td>
                      <span className="badge">{m.type}</span>
                    </td>
                    <td className="mono" style={{ fontSize: 12.5 }}>{m.context}</td>
                    <td><StatusBadge status={m.status} /></td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{m.calls.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      <span style={{ color: m.p95 > 800 ? 'var(--warn)' : 'var(--text)' }}>{m.p95}ms</span>
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{m.cost === 0 ? '—' : `$${m.cost.toFixed(2)}`}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-ghost btn-sm btn-icon" aria-label="Actions">
                        <Icon name="more" size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, padding: 16 }}>
            {filtered.map(m => (
              <div key={m.id} className="card interactive card-pad" onClick={() => onNavigate('models', m.id)}>
                <div className="row-between" style={{ marginBottom: 10 }}>
                  <ProviderChip id={m.provider} />
                  <StatusBadge status={m.status} />
                </div>
                <div className="mono" style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>{m.name}</div>
                <div className="faint mono" style={{ fontSize: 11, marginBottom: 12 }}>{m.version} · {m.type}</div>
                <Spark data={[8,12,10,16,14,20,22,18,26,24,30].map(v => v + Math.random() * 6)} height={28} />
                <div className="row-between" style={{ marginTop: 12, fontSize: 12 }}>
                  <span className="muted">{m.calls.toLocaleString()} calls</span>
                  <span className="muted">{m.p95}ms p95</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="row-between" style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)', fontSize: 12.5 }}>
          <span className="muted">Showing {filtered.length} of {MODELS.length} models</span>
          <div className="row gap-sm">
            <button className="btn btn-ghost btn-sm" disabled style={{ opacity: 0.5 }}>
              <Icon name="chevronLeft" size={12} /> Prev
            </button>
            <span className="muted">1 / 1</span>
            <button className="btn btn-ghost btn-sm" disabled style={{ opacity: 0.5 }}>
              Next <Icon name="chevronRight" size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ModelsPage, StatusBadge, ProviderChip });
