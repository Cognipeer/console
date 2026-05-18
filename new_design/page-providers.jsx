/* global React, Icon, PROVIDER_TYPES, PROVIDER_CATALOG, CONFIGURED_PROVIDERS */
// Providers — list, add modal, detail

// ── Provider logo glyph (square with letters + brand color) ─────
function ProviderLogo({ catalogId, size = 36 }) {
  const p = PROVIDER_CATALOG.find(x => x.id === catalogId);
  if (!p) return null;
  // Render dark or light text based on luminance of brand color
  const hex = p.color.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const isDark = r * 0.299 + g * 0.587 + b * 0.114 < 160;
  return (
    <div
      style={{
        width: size, height: size,
        borderRadius: Math.round(size * 0.22),
        background: p.color,
        color: isDark ? '#fff' : 'rgba(0,0,0,0.85)',
        display: 'grid', placeItems: 'center',
        fontSize: Math.round(size * 0.36),
        fontWeight: 600,
        letterSpacing: '-0.02em',
        flexShrink: 0,
        boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
        fontFamily: 'var(--font)',
      }}
    >
      {p.glyph}
    </div>
  );
}

// ── Provider status badge ──────────────────────────────────────
function ProviderStatus({ status }) {
  const map = {
    connected: { cls: 'badge-ok',   label: 'Connected' },
    paused:    { cls: 'badge',      label: 'Paused' },
    degraded:  { cls: 'badge-warn', label: 'Degraded' },
    error:     { cls: 'badge-err',  label: 'Error' },
  };
  const c = map[status] || map.connected;
  return (
    <span className={`badge ${c.cls}`}>
      <span className="badge-dot" />
      {c.label}
    </span>
  );
}

// ── Add Provider modal (catalog browser) ───────────────────────
function AddProviderModal({ open, onClose, initialType, onSelect }) {
  const [q, setQ] = React.useState('');
  const [type, setType] = React.useState(initialType || 'all');

  React.useEffect(() => {
    if (open) { setQ(''); setType(initialType || 'all'); }
  }, [open, initialType]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const filtered = PROVIDER_CATALOG.filter(p => {
    if (type !== 'all' && p.type !== type) return false;
    if (q && !p.name.toLowerCase().includes(q.toLowerCase()) && !p.desc.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const counts = Object.fromEntries(
    PROVIDER_TYPES.map(t => [t.id, PROVIDER_CATALOG.filter(p => p.type === t.id).length])
  );
  counts.all = PROVIDER_CATALOG.length;

  return (
    <div className="launcher-overlay" onClick={onClose}>
      <div className="launcher" onClick={(e) => e.stopPropagation()} style={{ width: 'min(960px, 94vw)' }}>
        <div className="launcher-header" style={{ flexDirection: 'column', alignItems: 'stretch', padding: '20px 24px 12px', gap: 12 }}>
          <div className="row-between">
            <div>
              <div className="eyebrow" style={{ marginBottom: 4 }}>Workspace · orion</div>
              <div className="h2" style={{ margin: 0 }}>Add a provider</div>
            </div>
            <button className="btn btn-ghost btn-icon" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
            Choose where Cognipeer should send inference, retrieval, storage, and observability traffic. You can add multiple instances of the same provider for staging vs production.
          </div>
        </div>

        <div className="launcher-body">
          <div className="launcher-sidebar">
            <div
              className={`launcher-cat ${type === 'all' ? 'active' : ''}`}
              onClick={() => setType('all')}
            >
              <Icon name="layers" size={13} />
              <span>All</span>
              <span className="launcher-cat-count">{counts.all}</span>
            </div>
            <div style={{ height: 1, background: 'var(--border-soft)', margin: '8px 8px' }} />
            {PROVIDER_TYPES.map(t => (
              <div
                key={t.id}
                className={`launcher-cat ${type === t.id ? 'active' : ''}`}
                onClick={() => setType(t.id)}
              >
                <Icon name={t.icon} size={13} />
                <span>{t.label}</span>
                <span className="launcher-cat-count">{counts[t.id]}</span>
              </div>
            ))}
          </div>

          <div className="launcher-main">
            <div className="row gap-sm" style={{ marginBottom: 16 }}>
              <div className="toolbar-search" style={{ flex: 1, maxWidth: 'none', height: 36 }}>
                <Icon name="search" size={14} style={{ color: 'var(--text-muted)' }} />
                <input placeholder="Search providers…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <button className="btn btn-secondary">
                <Icon name="doc" size={13} /> Browse docs
              </button>
            </div>

            {type !== 'all' && (
              <div style={{ padding: '10px 12px', background: 'var(--accent-soft)', borderRadius: 'var(--r-sm)', marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
                <Icon name={PROVIDER_TYPES.find(t => t.id === type).icon} size={15} style={{ color: 'var(--accent)' }} />
                <div style={{ fontSize: 12.5 }}>
                  <strong style={{ color: 'var(--accent)' }}>{PROVIDER_TYPES.find(t => t.id === type).label}</strong>
                  <span className="muted"> · {PROVIDER_TYPES.find(t => t.id === type).desc}</span>
                </div>
              </div>
            )}

            {filtered.length === 0 ? (
              <div className="empty-state">
                <Icon name="search" size={24} style={{ color: 'var(--text-faint)', marginBottom: 8 }} />
                <div>No providers match "{q}"</div>
              </div>
            ) : (
              <div className="svc-grid">
                {filtered.map(p => (
                  <div key={p.id} className="svc-card" onClick={() => onSelect(p)} style={{ padding: 14 }}>
                    <ProviderLogo catalogId={p.id} size={36} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="svc-name">
                        {p.name}
                        {p.verified && (
                          <span title="Verified by Cognipeer">
                            <Icon name="check" size={11} style={{ color: 'var(--accent)' }} />
                          </span>
                        )}
                      </div>
                      <div className="svc-desc">{p.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Configure-provider drawer (step 2 after picking from catalog) ─
function ConfigureProviderDrawer({ catalog, onClose, onSave }) {
  if (!catalog) return null;

  const fieldsFor = (cat) => {
    switch (cat.type) {
      case 'llm':
      case 'embedding':
        return [
          { id: 'name',    label: 'Display name', type: 'text', placeholder: `${cat.name} · production`, required: true },
          { id: 'apiKey',  label: 'API key',      type: 'password', placeholder: 'sk-...', required: true, mono: true },
          { id: 'baseUrl', label: 'Base URL (override)', type: 'text', placeholder: cat.id === 'openai' ? 'https://api.openai.com/v1' : '', mono: true, optional: true },
          { id: 'org',     label: 'Organization ID', type: 'text', placeholder: 'org-...', mono: true, optional: true },
        ];
      case 'vectordb':
        return [
          { id: 'name',    label: 'Display name', type: 'text', placeholder: `${cat.name} · production`, required: true },
          { id: 'endpoint',label: 'Endpoint',     type: 'text', placeholder: 'https://...', mono: true, required: true },
          { id: 'apiKey',  label: 'API key',      type: 'password', mono: true, required: true },
          { id: 'index',   label: 'Default index/collection', type: 'text', mono: true, optional: true },
        ];
      case 'storage':
        return [
          { id: 'name',     label: 'Display name', type: 'text', required: true },
          { id: 'bucket',   label: 'Bucket name',  type: 'text', mono: true, required: true },
          { id: 'region',   label: 'Region',       type: 'text', mono: true, placeholder: 'us-east-1', required: true },
          { id: 'accessKey',label: 'Access key ID',type: 'text', mono: true, required: true },
          { id: 'secret',   label: 'Secret access key', type: 'password', mono: true, required: true },
        ];
      case 'obs':
        return [
          { id: 'name',    label: 'Display name', type: 'text', required: true },
          { id: 'endpoint',label: 'Ingest endpoint', type: 'text', mono: true, required: true },
          { id: 'apiKey',  label: 'API key',      type: 'password', mono: true, required: true },
        ];
      case 'auth':
        return [
          { id: 'name',       label: 'Display name', type: 'text', required: true },
          { id: 'domain',     label: 'Identity domain', type: 'text', mono: true, required: true },
          { id: 'clientId',   label: 'Client ID',    type: 'text', mono: true, required: true },
          { id: 'clientSecret',label: 'Client secret', type: 'password', mono: true, required: true },
        ];
      default:
        return [];
    }
  };

  const fields = fieldsFor(catalog);

  return (
    <div className="launcher-overlay" onClick={onClose}>
      <div
        className="launcher"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(640px, 94vw)', alignSelf: 'flex-start' }}
      >
        <div className="launcher-header" style={{ padding: 20, gap: 14 }}>
          <ProviderLogo catalogId={catalog.id} size={48} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row gap-sm" style={{ marginBottom: 2 }}>
              <div className="h3" style={{ margin: 0 }}>Connect {catalog.name}</div>
              {catalog.verified && <span className="badge badge-teal">Verified</span>}
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>{catalog.desc}</div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div style={{ padding: '20px 24px 0', overflowY: 'auto' }}>
          <div className="col gap-md">
            {fields.map(f => (
              <div key={f.id}>
                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <span className="eyebrow">
                    {f.label}
                    {f.required && <span style={{ color: 'var(--err)', marginLeft: 4 }}>*</span>}
                  </span>
                  {f.optional && <span className="faint" style={{ fontSize: 11 }}>optional</span>}
                </label>
                <input
                  className="input"
                  type={f.type === 'password' ? 'password' : 'text'}
                  placeholder={f.placeholder}
                  style={f.mono ? { fontFamily: 'var(--font-mono)', fontSize: 12.5 } : {}}
                />
              </div>
            ))}

            <div className="card card-pad" style={{ background: 'var(--surface-1)', borderStyle: 'solid' }}>
              <div className="row gap-sm" style={{ marginBottom: 8 }}>
                <Icon name="shield" size={15} style={{ color: 'var(--ok)' }} />
                <div className="h4" style={{ margin: 0 }}>Credentials are encrypted</div>
              </div>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                Stored using envelope encryption with a workspace-specific key. Decrypted only at inference time inside the Cognipeer runtime.
              </div>
            </div>
          </div>
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-ghost btn-sm">
            <Icon name="play" size={12} /> Test connection
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onSave(catalog)}>
            <Icon name="check" size={13} />
            Connect provider
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Providers list page ────────────────────────────────────────
function ProvidersPage({ onNavigate }) {
  const [view, setView] = React.useState('grouped'); // grouped | table
  const [query, setQuery] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState('all');
  const [addOpen, setAddOpen] = React.useState(false);
  const [configCatalog, setConfigCatalog] = React.useState(null);
  const [providers, setProviders] = React.useState(CONFIGURED_PROVIDERS);
  const [toast, setToast] = React.useState(null);

  const filtered = providers.filter(p => {
    if (typeFilter !== 'all' && p.type !== typeFilter) return false;
    if (query && !p.name.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const grouped = PROVIDER_TYPES.map(t => ({
    type: t,
    items: filtered.filter(p => p.type === t.id),
  })).filter(g => g.items.length > 0 || typeFilter === 'all');

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  return (
    <div className="page" data-screen-label="providers">
      <div className="breadcrumb">
        <a onClick={() => onNavigate && onNavigate('home')}>orion</a>
        <span className="sep">/</span>
        <span>Admin</span>
        <span className="sep">/</span>
        <span>Providers</span>
      </div>

      <div className="page-header">
        <div>
          <h1 className="h1">Providers</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            External services Cognipeer connects to for inference, retrieval, storage, and observability.
            <strong style={{ color: 'var(--text)' }}> {providers.length}</strong> connected ·{' '}
            <strong style={{ color: 'var(--text)' }}>{providers.filter(p => p.status === 'connected').length}</strong> healthy
          </p>
        </div>
        <div className="row gap-sm">
          <button className="btn btn-secondary">
            <Icon name="doc" size={14} /> Provider docs
          </button>
          <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
            <Icon name="plus" size={14} /> Add provider
          </button>
        </div>
      </div>

      {/* Type summary tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${PROVIDER_TYPES.length}, 1fr)`, gap: 10, marginBottom: 16 }}>
        {PROVIDER_TYPES.map(t => {
          const items = providers.filter(p => p.type === t.id);
          const healthy = items.filter(p => p.status === 'connected').length;
          const issues = items.filter(p => p.status === 'error' || p.status === 'degraded').length;
          const active = typeFilter === t.id;
          return (
            <div
              key={t.id}
              className="card interactive"
              style={{
                padding: 14,
                background: active ? 'var(--accent-soft)' : 'var(--surface-raised)',
                borderColor: active ? 'var(--accent)' : 'var(--border-soft)',
              }}
              onClick={() => setTypeFilter(typeFilter === t.id ? 'all' : t.id)}
            >
              <div className="row gap-sm" style={{ marginBottom: 8 }}>
                <div style={{ width: 28, height: 28, borderRadius: 7, background: active ? 'var(--accent)' : 'var(--surface-2)', color: active ? 'var(--text-on-accent)' : 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
                  <Icon name={t.icon} size={14} />
                </div>
                <span className="eyebrow" style={{ color: active ? 'var(--accent)' : undefined }}>{t.label}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 24, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{items.length}</span>
                {issues > 0 && (
                  <span className="badge badge-err" style={{ height: 18, fontSize: 10.5 }}>
                    <span className="badge-dot" /> {issues} issue{issues !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                {items.length === 0 ? 'None configured' : `${healthy} of ${items.length} healthy`}
              </div>
            </div>
          );
        })}
      </div>

      {/* Toolbar */}
      <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
        <div className="toolbar">
          <div className="toolbar-search">
            <Icon name="search" size={14} style={{ color: 'var(--text-muted)' }} />
            <input placeholder="Filter providers…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <select className="select" style={{ width: 160 }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">All types</option>
            {PROVIDER_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" aria-label="Refresh"><Icon name="refresh" size={14} /></button>
          <div style={{ display: 'flex', background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', padding: 2 }}>
            <button
              className="btn btn-sm"
              style={{ height: 24, padding: '0 8px', boxShadow: view === 'grouped' ? 'var(--shadow-xs)' : 'none', background: view === 'grouped' ? 'var(--surface-raised)' : 'transparent', border: 'none', color: view === 'grouped' ? 'var(--text)' : 'var(--text-muted)' }}
              onClick={() => setView('grouped')}
              aria-label="Grouped"
            >
              <Icon name="layers" size={13} />
            </button>
            <button
              className="btn btn-sm"
              style={{ height: 24, padding: '0 8px', boxShadow: view === 'table' ? 'var(--shadow-xs)' : 'none', background: view === 'table' ? 'var(--surface-raised)' : 'transparent', border: 'none', color: view === 'table' ? 'var(--text)' : 'var(--text-muted)' }}
              onClick={() => setView('table')}
              aria-label="Table"
            >
              <Icon name="dashboard" size={13} />
            </button>
          </div>
        </div>

        {/* Body */}
        {view === 'grouped' ? (
          <div className="col" style={{ padding: 16, gap: 24 }}>
            {grouped.map(g => (
              <div key={g.type.id}>
                <div className="row-between" style={{ marginBottom: 10 }}>
                  <div className="row gap-sm">
                    <Icon name={g.type.icon} size={15} style={{ color: 'var(--text-muted)' }} />
                    <span className="h4" style={{ margin: 0 }}>{g.type.label}</span>
                    <span className="faint" style={{ fontSize: 12 }}>{g.items.length}</span>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setAddOpen(true);
                      // pre-filter
                      setTimeout(() => setTypeFilter(g.type.id), 0);
                    }}
                  >
                    <Icon name="plus" size={12} /> Add {g.type.label.toLowerCase()}
                  </button>
                </div>
                {g.items.length === 0 ? (
                  <div className="card" style={{ padding: 24, textAlign: 'center', borderStyle: 'dashed', background: 'transparent' }}>
                    <div className="faint" style={{ fontSize: 12.5 }}>No {g.type.label.toLowerCase()} provider configured yet.</div>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                    {g.items.map(p => (
                      <div key={p.id} className="card interactive card-pad" onClick={() => onNavigate && onNavigate('provider-detail', p.id)}>
                        <div className="row gap-sm" style={{ marginBottom: 12 }}>
                          <ProviderLogo catalogId={p.catalogId} size={34} />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                            <div className="faint mono" style={{ fontSize: 11 }}>{p.region}</div>
                          </div>
                          <ProviderStatus status={p.status} />
                        </div>
                        <div className="row-between" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          {p.models > 0 && <span>{p.models} model{p.models !== 1 ? 's' : ''}</span>}
                          {p.latency > 0 && <span className="mono">{p.latency}ms p95</span>}
                          <span style={{ marginLeft: 'auto' }} className="mono">{p.usage24h}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Region</th>
                  <th style={{ textAlign: 'right' }}>Models</th>
                  <th style={{ textAlign: 'right' }}>Latency</th>
                  <th style={{ textAlign: 'right' }}>Usage (24h)</th>
                  <th>Added by</th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id} onClick={() => onNavigate && onNavigate('provider-detail', p.id)} style={{ cursor: 'pointer' }}>
                    <td>
                      <div className="row gap-sm">
                        <ProviderLogo catalogId={p.catalogId} size={26} />
                        <span style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</span>
                      </div>
                    </td>
                    <td>
                      <span className="badge">{PROVIDER_TYPES.find(t => t.id === p.type)?.label}</span>
                    </td>
                    <td><ProviderStatus status={p.status} /></td>
                    <td className="mono" style={{ fontSize: 12 }}>{p.region}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{p.models || '—'}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{p.latency ? `${p.latency}ms` : '—'}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} className="mono">{p.usage24h}</td>
                    <td className="muted" style={{ fontSize: 12.5 }}>{p.createdBy}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-ghost btn-sm btn-icon"><Icon name="more" size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AddProviderModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        initialType={typeFilter !== 'all' ? typeFilter : undefined}
        onSelect={(cat) => { setAddOpen(false); setConfigCatalog(cat); }}
      />
      {configCatalog && (
        <ConfigureProviderDrawer
          catalog={configCatalog}
          onClose={() => setConfigCatalog(null)}
          onSave={(cat) => {
            // Simulate add
            const newP = {
              id: 'p' + Math.random().toString(36).slice(2, 7),
              catalogId: cat.id,
              name: `${cat.name} · workspace`,
              type: cat.type,
              status: 'connected',
              models: 0,
              usage24h: '—',
              region: 'us-east-1',
              createdBy: 'You',
              createdAt: 'just now',
              latency: 0,
            };
            setProviders([newP, ...providers]);
            setConfigCatalog(null);
            showToast(`${cat.name} connected. Test your first call from the Playground.`);
          }}
        />
      )}

      {toast && (
        <div className="toast-wrap">
          <div className="toast">
            <Icon name="check" size={14} style={{ color: 'var(--ok)' }} />
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Single-provider detail ─────────────────────────────────────
function ProviderDetailPage({ providerId, onNavigate }) {
  const p = CONFIGURED_PROVIDERS.find(x => x.id === providerId);
  if (!p) return null;
  const cat = PROVIDER_CATALOG.find(x => x.id === p.catalogId);
  const [tab, setTab] = React.useState('overview');

  return (
    <div className="page" data-screen-label={`provider-${p.id}`}>
      <div className="breadcrumb">
        <a onClick={() => onNavigate && onNavigate('home')}>orion</a>
        <span className="sep">/</span>
        <a onClick={() => onNavigate && onNavigate('providers')}>Providers</a>
        <span className="sep">/</span>
        <span>{p.name}</span>
      </div>

      <div className="page-header" style={{ alignItems: 'center' }}>
        <div className="row gap-md" style={{ flex: 1, minWidth: 0 }}>
          <ProviderLogo catalogId={p.catalogId} size={52} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
              <h1 className="h2" style={{ margin: 0 }}>{p.name}</h1>
              <ProviderStatus status={p.status} />
              {cat.verified && <span className="badge badge-teal">Verified</span>}
            </div>
            <div className="row gap-md muted" style={{ fontSize: 12.5, flexWrap: 'wrap' }}>
              <span>{cat.name}</span>
              <span className="faint">·</span>
              <span className="mono">{p.region}</span>
              <span className="faint">·</span>
              <span>Added by {p.createdBy}</span>
              <span className="faint">·</span>
              <span>{p.createdAt}</span>
            </div>
          </div>
        </div>
        <div className="row gap-sm" style={{ flexShrink: 0 }}>
          <button className="btn btn-secondary">
            <Icon name="play" size={13} /> Test
          </button>
          <button className="btn btn-secondary">
            <Icon name="refresh" size={13} /> Rotate key
          </button>
          <button className="btn btn-secondary btn-icon"><Icon name="more" size={14} /></button>
        </div>
      </div>

      <div className="tabs">
        {[
          { id: 'overview',  label: 'Overview',     icon: 'dashboard' },
          { id: 'models',    label: cat.type === 'llm' ? 'Models' : cat.type === 'vectordb' ? 'Indexes' : 'Resources', icon: 'brain' },
          { id: 'credentials', label: 'Credentials', icon: 'key' },
          { id: 'usage',     label: 'Usage & cost', icon: 'graph' },
          { id: 'audit',     label: 'Audit',        icon: 'clipboard' },
        ].map(t => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={14} />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
          <div className="col gap-md">
            <div className="card card-pad-lg">
              <div className="h3" style={{ marginBottom: 16 }}>Connection</div>
              <div className="row gap-lg" style={{ marginBottom: 20, paddingBottom: 20, borderBottom: '1px solid var(--border-soft)' }}>
                <div style={{ flex: 1 }}>
                  <div className="muted" style={{ fontSize: 12 }}>Last health check</div>
                  <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>
                    {p.status === 'error' ? <span style={{ color: 'var(--err)' }}>Failed</span> : <span style={{ color: 'var(--ok)' }}>OK</span>}
                  </div>
                  <div className="faint" style={{ fontSize: 11.5 }}>34 seconds ago</div>
                </div>
                <div style={{ flex: 1 }}>
                  <div className="muted" style={{ fontSize: 12 }}>P95 latency</div>
                  <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{p.latency || '—'}{p.latency > 0 ? 'ms' : ''}</div>
                  <div className="faint" style={{ fontSize: 11.5 }}>last 24h</div>
                </div>
                <div style={{ flex: 1 }}>
                  <div className="muted" style={{ fontSize: 12 }}>Usage (24h)</div>
                  <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }} className="mono">{p.usage24h}</div>
                  <div className="faint" style={{ fontSize: 11.5 }}>budget OK</div>
                </div>
              </div>
              <div>
                <div className="row-between" style={{ marginBottom: 8 }}>
                  <span className="eyebrow">Endpoint</span>
                  <button className="btn btn-ghost btn-sm"><Icon name="copy" size={12} /> Copy</button>
                </div>
                <div className="code">
                  https://api.{cat.id}.com/v1
                </div>
              </div>
            </div>

            <div className="card card-pad-lg">
              <div className="h3" style={{ marginBottom: 12 }}>Recent events</div>
              <div className="col gap-sm">
                {[
                  { lvl: 'ok',   ts: '34s ago',  msg: 'Health check succeeded' },
                  { lvl: 'ok',   ts: '12m ago',  msg: 'Inference call · 482 tokens · 286ms' },
                  { lvl: 'warn', ts: '1h ago',   msg: 'Rate limit warning: 80% of 2,000 rpm' },
                  { lvl: 'ok',   ts: '4h ago',   msg: 'Models list refreshed (12 available)' },
                  { lvl: 'info', ts: '2 days ago', msg: 'API key rotated by Deniz K.' },
                ].map((e, i) => (
                  <div key={i} className="row" style={{ gap: 10, padding: '6px 0', borderTop: i ? '1px solid var(--border-soft)' : 'none' }}>
                    <span className="badge-dot" style={{ background: `var(--${e.lvl === 'ok' ? 'ok' : e.lvl === 'warn' ? 'warn' : 'info'})`, width: 8, height: 8 }} />
                    <span style={{ flex: 1, fontSize: 13 }}>{e.msg}</span>
                    <span className="faint" style={{ fontSize: 11.5 }}>{e.ts}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="col gap-md">
            <div className="card card-pad-lg">
              <div className="h4" style={{ marginBottom: 12 }}>Details</div>
              {[
                ['Provider', cat.name],
                ['Type', PROVIDER_TYPES.find(t => t.id === p.type)?.label],
                ['Region', p.region],
                ['Models', p.models],
                ['Added', p.createdAt],
                ['Added by', p.createdBy],
              ].map(([k, v], i) => (
                <div key={k} className="row-between" style={{ padding: '6px 0', borderTop: i ? '1px solid var(--border-soft)' : 'none', fontSize: 12.5 }}>
                  <span className="muted">{k}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>

            <div className="card card-pad-lg">
              <div className="h4" style={{ marginBottom: 12 }}>Quick actions</div>
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'flex-start' }}>
                <Icon name="play" size={12} /> Test connection
              </button>
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'flex-start' }}>
                <Icon name="refresh" size={12} /> Refresh model catalog
              </button>
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'flex-start' }}>
                <Icon name="copy" size={12} /> Copy provider ID
              </button>
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'flex-start', color: 'var(--err)' }}>
                <Icon name="trash" size={12} /> Remove provider
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'credentials' && (
        <div className="card card-pad-lg" style={{ maxWidth: 720 }}>
          <div className="h3" style={{ marginBottom: 4 }}>Credentials</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 20 }}>Keys are encrypted at rest. Only their last 4 characters are shown after creation.</div>
          <div className="col gap-md">
            <div>
              <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>API key</label>
              <div className="row gap-sm">
                <input className="input mono" value="sk-cgnp-prod-•••••••••••••••42" readOnly style={{ fontSize: 12.5 }} />
                <button className="btn btn-secondary">Rotate</button>
              </div>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>Last rotated 12 days ago by Deniz K.</div>
            </div>
            <div>
              <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Base URL</label>
              <input className="input mono" value={`https://api.${cat.id}.com/v1`} style={{ fontSize: 12.5 }} />
            </div>
            <div>
              <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Organization ID</label>
              <input className="input mono" value="org-Vw82ZQ" style={{ fontSize: 12.5 }} />
            </div>
          </div>
          <div className="divider" />
          <div className="row gap-sm">
            <button className="btn btn-primary">Save changes</button>
            <button className="btn btn-ghost">Discard</button>
          </div>
        </div>
      )}

      {tab !== 'overview' && tab !== 'credentials' && (
        <div className="card card-pad-lg">
          <div className="empty-state">
            <Icon name="layers" size={28} style={{ color: 'var(--text-faint)', marginBottom: 12 }} />
            <div className="h4" style={{ color: 'var(--text)', marginBottom: 4 }}>{({ models: 'Models', usage: 'Usage & cost', audit: 'Audit log' })[tab]}</div>
            <div className="muted" style={{ fontSize: 13 }}>Mirrors the same structure as Models {'>'} {({ models: 'Catalog', usage: 'Cost analyzer', audit: 'Audit log' })[tab]}.</div>
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { ProvidersPage, ProviderDetailPage, ProviderLogo, ProviderStatus, AddProviderModal });
