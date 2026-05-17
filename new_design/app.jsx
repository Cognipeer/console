/* global React, ReactDOM, useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakToggle, TweakColor,
   Sidebar, Topbar, CommandPalette, OverviewPage, ModelsPage, ModelDetailPage, PlaceholderPage, Icon */
// Main app — routing, theming, tweaks, command palette

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "sidebar": "expanded",
  "density": "cozy",
  "glass": "on",
  "accent": "#16b3ab",
  "direction": "premium"
}/*EDITMODE-END*/;

const ACCENTS = ['#16b3ab', '#2a6fdb', '#7c3aed', '#1f8a5b', '#c97a16'];

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = React.useState({ page: 'overview', sub: null });
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [toast, setToast] = React.useState(null);

  // Keyboard: ⌘K / Ctrl+K opens palette; ⌘J toggles theme
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen(v => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setTweak('theme', t.theme === 'dark' ? 'light' : 'dark');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [t.theme, setTweak]);

  // Apply accent override globally
  React.useEffect(() => {
    document.documentElement.style.setProperty('--accent', t.accent);
    // derived soft + ring (rough rgba)
    const hex = t.accent.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    document.documentElement.style.setProperty('--accent-soft', `rgba(${r},${g},${b},0.10)`);
    document.documentElement.style.setProperty('--accent-ring', `rgba(${r},${g},${b},0.22)`);
    // Slight darken on hover
    document.documentElement.style.setProperty('--accent-hover', `rgb(${Math.max(0, r - 16)},${Math.max(0, g - 16)},${Math.max(0, b - 16)})`);
    document.documentElement.style.setProperty('--bg-gradient-1', `rgba(${r},${g},${b},${t.theme === 'dark' ? 0.10 : 0.06})`);
    document.documentElement.style.setProperty('--bg-gradient-2', `rgba(${r},${g},${b},${t.theme === 'dark' ? 0.05 : 0.04})`);
  }, [t.accent, t.theme]);

  const navigate = (page, sub = null) => {
    setRoute({ page, sub });
    document.querySelector('.main')?.scrollTo({ top: 0 });
  };

  const handleCmdAction = (id) => {
    if (id === 'cmd-theme') {
      setTweak('theme', t.theme === 'dark' ? 'light' : 'dark');
    } else if (id.startsWith('cmd-new-')) {
      const kind = id.replace('cmd-new-', '');
      const map = { model: 'models', prompt: 'prompts', agent: 'agents', token: 'tokens' };
      if (map[kind]) navigate(map[kind]);
      showToast(`Opened: New ${kind}`);
    } else if (id === 'cmd-invite') {
      navigate('members');
      showToast('Opened: Members');
    } else if (id === 'cmd-docs') {
      showToast('Documentation opened in new tab');
    } else if (id === 'cmd-status') {
      showToast('All systems operational ✓');
    }
  };

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  };

  // Direction "classic" = solid white surfaces, no glass, no gradients
  // Direction "premium" = subtle glass + gradient background
  const effectiveGlass = t.direction === 'premium' && t.glass === 'on' ? 'on' : 'off';
  const effectiveBgGradient = t.direction === 'premium';

  let pageEl;
  if (route.page === 'overview') pageEl = <OverviewPage onNavigate={navigate} />;
  else if (route.page === 'models' && !route.sub) pageEl = <ModelsPage onNavigate={navigate} />;
  else if (route.page === 'models' && route.sub) pageEl = <ModelDetailPage modelId={route.sub} onNavigate={navigate} />;
  else pageEl = <PlaceholderPage pageId={route.page} onNavigate={navigate} />;

  return (
    <div
      className="app"
      data-theme={t.theme}
      data-sidebar={t.sidebar === 'expanded' ? 'expanded' : 'collapsed'}
      data-density={t.density}
      data-glass={effectiveGlass}
      style={{
        '--bg-base': effectiveBgGradient ? undefined : (t.theme === 'dark' ? '#0c1219' : '#fbfcfc'),
      }}
    >
      <Topbar
        sidebarCollapsed={t.sidebar !== 'expanded'}
        theme={t.theme}
        project="orion · prod"
        onSearchClick={() => setCmdOpen(true)}
        onToggleSidebar={() => setTweak('sidebar', t.sidebar === 'expanded' ? 'collapsed' : 'expanded')}
        onToggleTheme={() => setTweak('theme', t.theme === 'dark' ? 'light' : 'dark')}
        onProjectClick={() => showToast('Project switcher · 4 projects available')}
      />
      <Sidebar
        active={route.page}
        collapsed={t.sidebar !== 'expanded'}
        onNavigate={navigate}
      />
      <main className="main">
        {pageEl}
      </main>

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onNavigate={(id) => navigate(id)}
        onAction={handleCmdAction}
      />

      {toast && (
        <div className="toast-wrap">
          <div className="toast">
            <Icon name="check" size={14} style={{ color: 'var(--ok)' }} />
            {toast}
          </div>
        </div>
      )}

      <TweaksPanel title="Console tweaks">
        <TweakSection label="Direction">
          <TweakRadio
            label="Visual style"
            value={t.direction}
            options={[
              { value: 'classic', label: 'Classic' },
              { value: 'premium', label: 'Premium' },
            ]}
            onChange={(v) => setTweak('direction', v)}
          />
        </TweakSection>

        <TweakSection label="Appearance">
          <TweakRadio
            label="Theme"
            value={t.theme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark',  label: 'Dark' },
            ]}
            onChange={(v) => setTweak('theme', v)}
          />
          <TweakColor
            label="Accent"
            value={t.accent}
            options={ACCENTS}
            onChange={(v) => setTweak('accent', v)}
          />
          <TweakToggle
            label="Glassmorphism"
            value={t.glass === 'on'}
            onChange={(v) => setTweak('glass', v ? 'on' : 'off')}
          />
        </TweakSection>

        <TweakSection label="Layout">
          <TweakRadio
            label="Sidebar"
            value={t.sidebar}
            options={[
              { value: 'expanded',  label: 'Expanded' },
              { value: 'collapsed', label: 'Collapsed' },
            ]}
            onChange={(v) => setTweak('sidebar', v)}
          />
          <TweakRadio
            label="Density"
            value={t.density}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'cozy',    label: 'Cozy' },
              { value: 'comfy',   label: 'Comfy' },
            ]}
            onChange={(v) => setTweak('density', v)}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
