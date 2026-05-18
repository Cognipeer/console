/* global React, ReactDOM, useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakColor,
   TopbarV2, SlimRail, ServiceSubNav, ServiceLauncher,
   HomeV2, ServiceHomeV2, ModelsPage, ModelDetailPage, ProvidersPage, ProviderDetailPage, ModelDeployForm,
   SERVICES, ACTIVITY, Icon, CommandPalette */
// App v2 — scalable nav (launcher + slim rail + service sub-nav)

const TWEAK_DEFAULTS_V2 = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "accent": "#16b3ab",
  "density": "cozy"
}/*EDITMODE-END*/;

const DEFAULT_PINNED = SERVICES.filter(s => s.pinned).map(s => s.id);
const ACCENTS_V2 = ['#16b3ab', '#2a6fdb', '#7c3aed', '#1f8a5b', '#c97a16'];

function AppV2() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS_V2);
  // Routing state
  const [activeServiceId, setActiveServiceId] = React.useState(null); // null = home
  const [activePage, setActivePage] = React.useState('overview');     // sub-page within service
  const [subRoute, setSubRoute] = React.useState(null);               // e.g., a specific model id
  // UI state
  const [launcherOpen, setLauncherOpen] = React.useState(false);
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [toast, setToast] = React.useState(null);
  // Pin & recent state
  const [pinnedIds, setPinnedIds] = React.useState(() => new Set(DEFAULT_PINNED));
  const [recentIds, setRecentIds] = React.useState([]);
  // Model deploy form
  const [deployFormOpen, setDeployFormOpen] = React.useState(false);

  // Apply accent
  React.useEffect(() => {
    const hex = t.accent.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    document.documentElement.style.setProperty('--accent', t.accent);
    document.documentElement.style.setProperty('--accent-soft', `rgba(${r},${g},${b},0.10)`);
    document.documentElement.style.setProperty('--accent-ring', `rgba(${r},${g},${b},0.22)`);
    document.documentElement.style.setProperty('--accent-hover', `rgb(${Math.max(0, r - 16)},${Math.max(0, g - 16)},${Math.max(0, b - 16)})`);
    document.documentElement.style.setProperty('--bg-gradient-1', `rgba(${r},${g},${b},${t.theme === 'dark' ? 0.10 : 0.06})`);
  }, [t.accent, t.theme]);

  // ⌘K
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        // ⌘K opens launcher (services discovery) — it's the primary nav
        setLauncherOpen(v => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setCmdOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pinned = SERVICES.filter(s => pinnedIds.has(s.id))
    .sort((a, b) => DEFAULT_PINNED.indexOf(a.id) - DEFAULT_PINNED.indexOf(b.id));
  const recents = recentIds
    .map(id => SERVICES.find(s => s.id === id))
    .filter(Boolean)
    .filter(s => !pinnedIds.has(s.id))
    .slice(0, 4);

  const activeService = SERVICES.find(s => s.id === activeServiceId);

  const goHome = () => {
    setActiveServiceId(null);
    setSubRoute(null);
  };

  const selectService = (id) => {
    setActiveServiceId(id);
    setActivePage('overview');
    setSubRoute(null);
    // Track recent
    setRecentIds(prev => {
      const next = [id, ...prev.filter(x => x !== id)].slice(0, 6);
      return next;
    });
  };

  const togglePin = (id) => {
    setPinnedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    const svc = SERVICES.find(s => s.id === id);
    showToast(pinnedIds.has(id) ? `Unpinned ${svc?.name}` : `Pinned ${svc?.name} to rail`);
  };

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  // Render the main content area based on routing
  let content;
  if (!activeService) {
    content = <HomeV2 pinned={pinned} recents={recents} onSelect={selectService} onLauncherClick={() => setLauncherOpen(true)} />;
  } else if (activeService.id === 'models') {
    // Use the real Models pages
    if (activePage === 'overview') {
      content = (
        <ServiceHomeV2 service={activeService} onSelectPage={setActivePage} />
      );
    } else if (activePage === 'list' && !subRoute) {
      content = <ModelsPage
        onNavigate={(p, sub) => {
          if (p === 'models' && sub) setSubRoute(sub);
          else if (p === 'models') { setActivePage('list'); setSubRoute(null); }
        }}
        onDeploy={() => setDeployFormOpen(true)}
      />;
    } else if (activePage === 'list' && subRoute) {
      content = <ModelDetailPage modelId={subRoute} onNavigate={(p, sub) => {
        if (p === 'models' && !sub) { setActivePage('list'); setSubRoute(null); }
        else if (p === 'overview') { goHome(); }
        else if (p === 'models' && sub) { setSubRoute(sub); }
      }} />;
    } else {
      content = <ServiceHomeV2 service={activeService} onSelectPage={setActivePage} />;
    }
  } else if (activeService.id === 'providers') {
    if (subRoute) {
      content = <ProviderDetailPage providerId={subRoute} onNavigate={(p, id) => {
        if (p === 'providers') setSubRoute(null);
        else if (p === 'home') goHome();
        else if (p === 'provider-detail') setSubRoute(id);
      }} />;
    } else {
      content = <ProvidersPage onNavigate={(p, id) => {
        if (p === 'provider-detail') setSubRoute(id);
        else if (p === 'home') goHome();
      }} />;
    }
  } else {
    content = <ServiceHomeV2 service={activeService} onSelectPage={setActivePage} />;
  }

  return (
    <div
      className="app-v2"
      data-theme={t.theme}
      data-density={t.density}
      data-glass="on"
      data-subnav={activeService ? 'open' : 'closed'}
    >
      <TopbarV2
        theme={t.theme}
        project="orion · prod"
        onSearchClick={() => setLauncherOpen(true)}
        onLauncherClick={() => setLauncherOpen(true)}
        onToggleTheme={() => setTweak('theme', t.theme === 'dark' ? 'light' : 'dark')}
        onProjectClick={() => showToast('Project switcher · 4 projects available')}
      />

      <SlimRail
        pinned={pinned}
        recents={recents}
        activeServiceId={activeServiceId}
        onSelect={selectService}
        onLauncherClick={() => setLauncherOpen(true)}
        onHome={goHome}
      />

      {activeService && (
        <ServiceSubNav
          service={activeService}
          activePage={activePage}
          onSelectPage={(p) => { setActivePage(p); setSubRoute(null); }}
          onClose={goHome}
          isPinned={pinnedIds.has(activeService.id)}
          onTogglePin={() => togglePin(activeService.id)}
        />
      )}

      <main className="main">
        {content}
      </main>

      <ServiceLauncher
        open={launcherOpen}
        onClose={() => setLauncherOpen(false)}
        onSelect={selectService}
        pinnedIds={pinnedIds}
        onTogglePin={togglePin}
        recents={recents}
      />

      <ModelDeployForm
        open={deployFormOpen}
        onClose={() => setDeployFormOpen(false)}
        onDeploy={(cfg) => {
          setDeployFormOpen(false);
          showToast(`${cfg.displayName} deployed · endpoint ready in ~60s`);
          selectService('models');
          setActivePage('list');
        }}
      />

      {toast && (
        <div className="toast-wrap">
          <div className="toast">
            <Icon name="check" size={14} style={{ color: 'var(--ok)' }} />
            {toast}
          </div>
        </div>
      )}

      <TweaksPanel title="Navigation v2">
        <TweakSection label="Appearance">
          <TweakRadio
            label="Theme"
            value={t.theme}
            options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
            onChange={(v) => setTweak('theme', v)}
          />
          <TweakColor
            label="Accent"
            value={t.accent}
            options={ACCENTS_V2}
            onChange={(v) => setTweak('accent', v)}
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

ReactDOM.createRoot(document.getElementById('root')).render(<AppV2 />);
