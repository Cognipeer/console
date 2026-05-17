/* global React, Icon, SERVICES, SERVICE_SUBNAV */
// Launcher-style navigation components

// ── Topbar v2 (with Services mega-menu trigger) ───────────────────
function TopbarV2({ onSearchClick, onLauncherClick, onToggleTheme, theme, project, onProjectClick }) {
  return (
    <header className="topbar glass">
      <div className="logo" style={{ width: 'auto', marginRight: 8 }}>
        <div className="logo-mark">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 8a4 4 0 0 1 4-4h2v6H4V8Z"/>
            <path d="M14 4h2a4 4 0 0 1 4 4v0a4 4 0 0 1-4 4h-2V4Z"/>
            <path d="M4 12h6v8H8a4 4 0 0 1-4-4v-4Z"/>
            <path d="M14 12h2a4 4 0 0 1 4 4v0a4 4 0 0 1-4 4h-2v-8Z"/>
          </svg>
        </div>
        <span>Cognipeer</span>
      </div>

      <button className="svc-trigger" onClick={onLauncherClick} aria-label="All services">
        <span className="dot-grid">
          {Array.from({ length: 9 }).map((_, i) => <i key={i} />)}
        </span>
        <span>Services</span>
        <Icon name="chevronDown" size={13} />
      </button>

      <div className="topbar-spacer" />

      <button className="search-box" onClick={onSearchClick} aria-label="Open command palette">
        <Icon name="search" size={15} />
        <span>Search services, resources, run commands…</span>
        <span className="kbd">⌘K</span>
      </button>

      <div className="topbar-spacer" />

      <button className="project-pill" onClick={onProjectClick}>
        <span className="dot" />
        <span>{project}</span>
        <Icon name="chevronDown" size={14} />
      </button>

      <button className="topbar-btn icon-only" onClick={onToggleTheme} aria-label="Toggle theme">
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
      </button>

      <button className="topbar-btn icon-only" aria-label="Notifications" style={{ position: 'relative' }}>
        <Icon name="bell" size={16} />
        <span style={{ position: 'absolute', top: 6, right: 6, width: 7, height: 7, borderRadius: '50%', background: 'var(--err)', boxShadow: '0 0 0 2px var(--surface-raised)' }} />
      </button>

      <div className="avatar">DK</div>
    </header>
  );
}

// ── Slim rail (pinboard) ──────────────────────────────────────────
function SlimRail({ pinned, recents, activeServiceId, onSelect, onLauncherClick, onHome }) {
  const renderBtn = (svc, opts = {}) => (
    <button
      key={`${opts.section || ''}-${svc.id}`}
      className={`rail-btn ${activeServiceId === svc.id ? 'active' : ''}`}
      onClick={() => onSelect(svc.id)}
      title={svc.name}
    >
      <Icon name={svc.icon} size={18} />
      {svc.badge && typeof svc.badge === 'number' && <span className="rail-badge">{svc.badge}</span>}
      {svc.badge === 'new' && <span className="rail-badge dot" />}
      <span className="rail-tip">{svc.name}</span>
    </button>
  );

  return (
    <aside className="rail">
      {/* Launcher / All services */}
      <button className="rail-btn" onClick={onLauncherClick} title="All services" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
        <span style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 4px)', gridTemplateRows: 'repeat(3, 4px)', gap: 2 }}>
          {Array.from({ length: 9 }).map((_, i) => <i key={i} style={{ width: 4, height: 4, background: 'currentColor', borderRadius: '50%' }} />)}
        </span>
        <span className="rail-tip">All services · ⌘K</span>
      </button>

      {/* Home / Overview */}
      <button
        className={`rail-btn ${activeServiceId === null ? 'active' : ''}`}
        onClick={onHome}
        title="Home"
      >
        <Icon name="dashboard" size={18} />
        <span className="rail-tip">Home</span>
      </button>

      <div className="rail-divider" />

      {/* Pinned */}
      {pinned.map(svc => renderBtn(svc, { section: 'pin' }))}

      {pinned.length > 0 && recents.length > 0 && <div className="rail-divider" />}

      {/* Recents */}
      {recents.map(svc => (
        <button
          key={`r-${svc.id}`}
          className={`rail-btn ${activeServiceId === svc.id ? 'active' : ''}`}
          onClick={() => onSelect(svc.id)}
          style={{ opacity: 0.7 }}
        >
          <Icon name={svc.icon} size={16} />
          <span className="rail-tip">{svc.name} · recent</span>
        </button>
      ))}

      <div style={{ flex: 1 }} />

      <div className="rail-divider" />
      <button className="rail-btn" title="Settings">
        <Icon name="settings" size={17} />
        <span className="rail-tip">Settings</span>
      </button>
      <button className="rail-btn" title="Help">
        <Icon name="help" size={17} />
        <span className="rail-tip">Help</span>
      </button>
    </aside>
  );
}

// ── Service sub-nav (when inside a service) ──────────────────────
function ServiceSubNav({ service, activePage, onSelectPage, onClose, isPinned, onTogglePin }) {
  const items = SERVICE_SUBNAV[service.id] || SERVICE_SUBNAV._default;
  return (
    <aside className="subnav">
      <div className="subnav-header">
        <div className="row-between" style={{ marginBottom: 8 }}>
          <div className="subnav-eyebrow">{service.category}</div>
          <button
            className="rail-btn"
            style={{ width: 22, height: 22, color: isPinned ? 'var(--accent)' : 'var(--text-faint)' }}
            onClick={onTogglePin}
            title={isPinned ? 'Unpin from rail' : 'Pin to rail'}
          >
            <Icon name="pin" size={13} />
          </button>
        </div>
        <div className="subnav-title">
          <span className="icon"><Icon name={service.icon} size={16} /></span>
          <span>{service.name}</span>
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.4 }}>{service.desc}</div>
      </div>
      <div className="subnav-body">
        {items.map(item => (
          <div
            key={item.id}
            className={`subnav-item ${activePage === item.id ? 'active' : ''}`}
            onClick={() => onSelectPage(item.id)}
          >
            <Icon name={item.icon} size={15} />
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.badge && <span className="badge-sm">{item.badge}</span>}
          </div>
        ))}

        <div className="subnav-section-title">Resources</div>
        <div className="subnav-item">
          <Icon name="doc" size={15} />
          <span>Documentation</span>
          <Icon name="external" size={11} style={{ marginLeft: 'auto', opacity: 0.5 }} />
        </div>
        <div className="subnav-item">
          <Icon name="api" size={15} />
          <span>API reference</span>
          <Icon name="external" size={11} style={{ marginLeft: 'auto', opacity: 0.5 }} />
        </div>
      </div>
    </aside>
  );
}

// ── Service Launcher (mega-menu) ─────────────────────────────────
function ServiceLauncher({ open, onClose, onSelect, pinnedIds, onTogglePin, recents }) {
  const [q, setQ] = React.useState('');
  const [activeCategory, setActiveCategory] = React.useState('All');
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (open) {
      setQ('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const categories = ['All', ...new Set(SERVICES.map(s => s.category))];
  const counts = Object.fromEntries(categories.map(c => [
    c,
    c === 'All' ? SERVICES.length : SERVICES.filter(s => s.category === c).length,
  ]));

  const query = q.toLowerCase().trim();
  const filtered = SERVICES.filter(s => {
    if (activeCategory !== 'All' && s.category !== activeCategory) return false;
    if (query) {
      return s.name.toLowerCase().includes(query) || s.desc.toLowerCase().includes(query);
    }
    return true;
  });

  return (
    <div className="launcher-overlay" onClick={onClose}>
      <div className="launcher" onClick={(e) => e.stopPropagation()}>
        <div className="launcher-header">
          <div className="launcher-search">
            <Icon name="search" size={17} style={{ color: 'var(--text-muted)' }} />
            <input
              ref={inputRef}
              placeholder="Search across 45 services…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <span className="kbd-key">ESC</span>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="launcher-body">
          <div className="launcher-sidebar">
            {categories.map(c => (
              <div
                key={c}
                className={`launcher-cat ${c === activeCategory ? 'active' : ''}`}
                onClick={() => setActiveCategory(c)}
              >
                <span>{c}</span>
                <span className="launcher-cat-count">{counts[c]}</span>
              </div>
            ))}
            <div style={{ height: 1, background: 'var(--border-soft)', margin: '12px 8px' }} />
            <div className="launcher-cat" style={{ color: 'var(--text-faint)' }}>
              <Icon name="pin" size={13} />
              <span>Pinned</span>
              <span className="launcher-cat-count">{pinnedIds.size}</span>
            </div>
            <div className="launcher-cat" style={{ color: 'var(--text-faint)' }}>
              <Icon name="star" size={13} />
              <span>Popular</span>
            </div>
          </div>

          <div className="launcher-main">
            {!query && recents.length > 0 && activeCategory === 'All' && (
              <>
                <div className="launcher-section-title">Recently visited</div>
                <div className="launcher-recent">
                  {recents.map(svc => (
                    <div
                      key={svc.id}
                      className="chip"
                      onClick={() => { onSelect(svc.id); onClose(); }}
                    >
                      <div style={{ width: 20, height: 20, borderRadius: 5, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'grid', placeItems: 'center' }}>
                        <Icon name={svc.icon} size={11} />
                      </div>
                      {svc.name}
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="launcher-section-title">
              {query
                ? `${filtered.length} result${filtered.length !== 1 ? 's' : ''} for "${query}"`
                : `${activeCategory} services · ${filtered.length}`}
            </div>

            {filtered.length === 0 ? (
              <div className="empty-state">
                <Icon name="search" size={24} style={{ color: 'var(--text-faint)', marginBottom: 8 }} />
                <div>No services match "{q}"</div>
              </div>
            ) : (
              <div className="svc-grid">
                {filtered.map(svc => {
                  const isPinned = pinnedIds.has(svc.id);
                  return (
                    <div key={svc.id} className="svc-card" onClick={() => { onSelect(svc.id); onClose(); }}>
                      <div className="svc-icon">
                        <Icon name={svc.icon} size={17} />
                      </div>
                      <div style={{ minWidth: 0, flex: 1, paddingRight: 24 }}>
                        <div className="svc-name">
                          {svc.name}
                          {svc.badge === 'new' && <span className="badge badge-teal" style={{ height: 16, padding: '0 6px', fontSize: 10 }}>NEW</span>}
                          {svc.popular && <Icon name="star" size={11} style={{ color: 'var(--warn)' }} />}
                        </div>
                        <div className="svc-desc">{svc.desc}</div>
                      </div>
                      <button
                        className={`svc-pin ${isPinned ? 'pinned' : ''}`}
                        onClick={(e) => { e.stopPropagation(); onTogglePin(svc.id); }}
                        title={isPinned ? 'Unpin' : 'Pin to rail'}
                      >
                        <Icon name="pin" size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: '10px 24px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 16, fontSize: 11.5, color: 'var(--text-faint)' }}>
          <span><span className="kbd-key">↑↓</span> navigate</span>
          <span><span className="kbd-key">⏎</span> open</span>
          <span><span className="kbd-key">⇧⏎</span> open in new tab</span>
          <span style={{ marginLeft: 'auto' }}>Drag services to the rail to pin</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { TopbarV2, SlimRail, ServiceSubNav, ServiceLauncher });
