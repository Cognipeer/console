/* global React, Icon */
// Shell components: Sidebar, Topbar, CommandPalette

// ── Navigation definition ──────────────────────────────────────────
const NAV_SECTIONS = [
  {
    title: 'Operate',
    items: [
      { id: 'overview',   label: 'Overview',   icon: 'dashboard' },
      { id: 'tracing',    label: 'Tracing',    icon: 'timeline' },
      { id: 'monitoring', label: 'Monitoring', icon: 'graph' },
      { id: 'alerts',     label: 'Alerts',     icon: 'bell', badge: 3 },
    ],
  },
  {
    title: 'Build',
    items: [
      { id: 'models',   label: 'Models',   icon: 'brain', badge: 24 },
      { id: 'prompts',  label: 'Prompts',  icon: 'sparkles' },
      { id: 'agents',   label: 'Agents',   icon: 'robot' },
      { id: 'tools',    label: 'Tools',    icon: 'tool' },
      { id: 'mcp',      label: 'MCP',      icon: 'api' },
    ],
  },
  {
    title: 'Data',
    items: [
      { id: 'vector', label: 'Vector',  icon: 'vector' },
      { id: 'memory', label: 'Memory',  icon: 'bulb' },
      { id: 'files',  label: 'Files',   icon: 'folder' },
      { id: 'rag',    label: 'RAG',     icon: 'book' },
    ],
  },
  {
    title: 'Admin',
    items: [
      { id: 'members',   label: 'Members',   icon: 'users' },
      { id: 'providers', label: 'Providers', icon: 'plug' },
      { id: 'tokens',    label: 'Tokens',    icon: 'key' },
      { id: 'guardrails',label: 'Guardrails',icon: 'shield' },
      { id: 'audit',     label: 'Audit log', icon: 'clipboard' },
      { id: 'license',   label: 'License',   icon: 'certificate' },
    ],
  },
];

// Flat lookup for command palette
const ALL_NAV = NAV_SECTIONS.flatMap(s => s.items.map(i => ({ ...i, section: s.title })));

// ── Sidebar ─────────────────────────────────────────────────────────
function Sidebar({ active, onNavigate, collapsed }) {
  return (
    <aside className="sidebar glass">
      {NAV_SECTIONS.map((section) => (
        <div className="sidebar-section" key={section.title}>
          <div className="sidebar-section-title">{section.title}</div>
          {section.items.map((item) => (
            <div
              key={item.id}
              className={`nav-item ${active === item.id ? 'active' : ''}`}
              onClick={() => onNavigate(item.id)}
              title={collapsed ? item.label : undefined}
              data-screen-label={`nav-${item.id}`}
            >
              <span className="nav-icon"><Icon name={item.icon} size={17} /></span>
              <span className="nav-label">{item.label}</span>
              {item.badge != null && <span className="nav-badge">{item.badge}</span>}
            </div>
          ))}
        </div>
      ))}
    </aside>
  );
}

// ── Topbar ──────────────────────────────────────────────────────────
function Topbar({ onSearchClick, onToggleSidebar, onToggleTheme, theme, sidebarCollapsed, project, onProjectClick }) {
  return (
    <header className="topbar glass">
      <div className="logo">
        <div className="logo-mark">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 8a4 4 0 0 1 4-4h2v6H4V8Z"/>
            <path d="M14 4h2a4 4 0 0 1 4 4v0a4 4 0 0 1-4 4h-2V4Z"/>
            <path d="M4 12h6v8H8a4 4 0 0 1-4-4v-4Z"/>
            <path d="M14 12h2a4 4 0 0 1 4 4v0a4 4 0 0 1-4 4h-2v-8Z"/>
          </svg>
        </div>
        {!sidebarCollapsed && <span>Cognipeer</span>}
      </div>

      <button className="topbar-btn icon-only" onClick={onToggleSidebar} aria-label="Toggle sidebar" title="Toggle sidebar">
        <Icon name={sidebarCollapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
      </button>

      <div className="topbar-spacer" />

      <button className="search-box" onClick={onSearchClick} aria-label="Open command palette">
        <Icon name="search" size={15} />
        <span>Search resources, run commands…</span>
        <span className="kbd">⌘K</span>
      </button>

      <div className="topbar-spacer" />

      <button className="project-pill" onClick={onProjectClick} aria-label="Switch project">
        <span className="dot" />
        <span>{project}</span>
        <Icon name="chevronDown" size={14} />
      </button>

      <button className="topbar-btn icon-only" onClick={onToggleTheme} aria-label="Toggle theme" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'}`}>
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
      </button>

      <button className="topbar-btn icon-only" aria-label="Docs" title="Documentation">
        <Icon name="doc" size={16} />
      </button>

      <button className="topbar-btn icon-only" aria-label="Notifications" title="Notifications" style={{ position: 'relative' }}>
        <Icon name="bell" size={16} />
        <span style={{ position: 'absolute', top: 6, right: 6, width: 7, height: 7, borderRadius: '50%', background: 'var(--err)', boxShadow: '0 0 0 2px var(--surface-raised)' }} />
      </button>

      <div className="avatar" title="Account">DK</div>
    </header>
  );
}

// ── Command palette ─────────────────────────────────────────────────
const COMMAND_ACTIONS = [
  { id: 'cmd-new-model', label: 'New model deployment',     icon: 'plus',     section: 'Quick actions', shortcut: 'N M' },
  { id: 'cmd-new-prompt',label: 'New prompt template',      icon: 'plus',     section: 'Quick actions', shortcut: 'N P' },
  { id: 'cmd-new-agent', label: 'Create agent',             icon: 'plus',     section: 'Quick actions', shortcut: 'N A' },
  { id: 'cmd-new-token', label: 'Generate API token',       icon: 'key',      section: 'Quick actions' },
  { id: 'cmd-invite',    label: 'Invite team member',       icon: 'users',    section: 'Quick actions' },
  { id: 'cmd-theme',     label: 'Toggle dark mode',         icon: 'moon',     section: 'Preferences',   shortcut: '⌘ J' },
  { id: 'cmd-docs',      label: 'Open documentation',       icon: 'doc',      section: 'Help',          shortcut: '⌘ /' },
  { id: 'cmd-status',    label: 'System status',            icon: 'shield',   section: 'Help' },
];

function CommandPalette({ open, onClose, onNavigate, onAction }) {
  const [q, setQ] = React.useState('');
  const [focused, setFocused] = React.useState(0);
  const inputRef = React.useRef(null);
  const listRef = React.useRef(null);

  React.useEffect(() => {
    if (open) {
      setQ('');
      setFocused(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filtered = React.useMemo(() => {
    const query = q.toLowerCase().trim();
    const matchesNav = ALL_NAV
      .filter(n => !query || n.label.toLowerCase().includes(query))
      .map(n => ({ ...n, type: 'nav', section: `Go to · ${n.section}` }));
    const matchesAction = COMMAND_ACTIONS
      .filter(a => !query || a.label.toLowerCase().includes(query))
      .map(a => ({ ...a, type: 'action' }));
    return [...matchesNav, ...matchesAction];
  }, [q]);

  const groups = React.useMemo(() => {
    const map = new Map();
    filtered.forEach(item => {
      if (!map.has(item.section)) map.set(item.section, []);
      map.get(item.section).push(item);
    });
    return [...map.entries()];
  }, [filtered]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setFocused(i => Math.min(i + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp')  { e.preventDefault(); setFocused(i => Math.max(0, i - 1)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const it = filtered[focused];
        if (!it) return;
        if (it.type === 'nav') onNavigate(it.id);
        else onAction(it.id);
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, focused, onClose, onNavigate, onAction]);

  if (!open) return null;

  let flatIdx = -1;
  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div className="cmd-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-input-row">
          <Icon name="search" size={18} style={{ color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            className="cmd-input"
            placeholder="Type a command or search resources…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setFocused(0); }}
          />
          <span className="kbd">ESC</span>
        </div>
        <div className="cmd-results" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cmd-empty">No results for "{q}"</div>
          ) : groups.map(([section, items]) => (
            <div key={section}>
              <div className="cmd-group-title">{section}</div>
              {items.map(item => {
                flatIdx++;
                const isFocused = flatIdx === focused;
                const myIdx = flatIdx;
                return (
                  <div
                    key={item.id}
                    className={`cmd-item ${isFocused ? 'focused' : ''}`}
                    onMouseEnter={() => setFocused(myIdx)}
                    onClick={() => {
                      if (item.type === 'nav') onNavigate(item.id);
                      else onAction(item.id);
                      onClose();
                    }}
                  >
                    <Icon name={item.icon} size={16} />
                    <span>{item.label}</span>
                    {item.shortcut && <span className="cmd-shortcut">{item.shortcut}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Sidebar, Topbar, CommandPalette, NAV_SECTIONS, ALL_NAV, COMMAND_ACTIONS });
