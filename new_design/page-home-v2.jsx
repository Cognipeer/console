/* global React, Icon, SERVICES, ACTIVITY, ALERTS */
// Home page for launcher app — shows pinned + recents + global activity

function HomeV2({ pinned, recents, onSelect, onLauncherClick }) {
  return (
    <div className="page" data-screen-label="home">
      <div className="page-header">
        <div>
          <h1 className="h1">Welcome back, Deniz</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Project <strong style={{ color: 'var(--text)' }}>orion · prod</strong> · {SERVICES.length} services available
          </p>
        </div>
        <div className="row gap-sm">
          <button className="btn btn-secondary" onClick={onLauncherClick}>
            <span style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 3px)', gridTemplateRows: 'repeat(3, 3px)', gap: 2 }}>
              {Array.from({ length: 9 }).map((_, i) => <i key={i} style={{ width: 3, height: 3, background: 'currentColor', borderRadius: '50%' }} />)}
            </span>
            All services
          </button>
          <button className="btn btn-primary">
            <Icon name="plus" size={14} /> Deploy model
          </button>
        </div>
      </div>

      {/* Pinned services */}
      <div className="card card-pad-lg" style={{ marginBottom: 16 }}>
        <div className="row-between" style={{ marginBottom: 16 }}>
          <div>
            <div className="h3">Your pinned services</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              Quick access from the rail. {pinned.length} pinned · {SERVICES.length - pinned.length} more available.
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onLauncherClick}>
            <Icon name="plus" size={12} /> Pin more
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          {pinned.map(svc => (
            <div key={svc.id} className="card interactive" style={{ padding: 14, background: 'var(--surface-1)' }} onClick={() => onSelect(svc.id)}>
              <div className="row gap-sm" style={{ marginBottom: 8 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'grid', placeItems: 'center' }}>
                  <Icon name={svc.icon} size={16} />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{svc.name}</div>
                  <div className="faint" style={{ fontSize: 10.5 }}>{svc.category}</div>
                </div>
              </div>
              <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.4 }}>{svc.desc}</div>
            </div>
          ))}

          <div
            className="card interactive"
            style={{ padding: 14, background: 'transparent', borderStyle: 'dashed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, color: 'var(--text-muted)' }}
            onClick={onLauncherClick}
          >
            <Icon name="plus" size={14} />
            <span style={{ fontSize: 12.5 }}>Add service</span>
          </div>
        </div>
      </div>

      {/* Recent activity strip + alerts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        <div className="card card-pad-lg">
          <div className="row-between" style={{ marginBottom: 12 }}>
            <div className="h3">Recent activity</div>
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

        <div className="col gap-md">
          <div className="card card-pad-lg">
            <div className="row-between" style={{ marginBottom: 12 }}>
              <div className="h3">Active alerts</div>
              <span className="badge badge-err">{ALERTS.length}</span>
            </div>
            <div className="col gap-sm">
              {ALERTS.map(a => (
                <div key={a.id} className="row" style={{ gap: 10, padding: 12, background: 'var(--surface-1)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border-soft)' }}>
                  <div style={{ width: 6, alignSelf: 'stretch', background: `var(--${a.sev === 'err' ? 'err' : 'warn'})`, borderRadius: 3, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{a.title}</div>
                    <div className="faint" style={{ fontSize: 11.5 }}>{a.time}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {recents.length > 0 && (
            <div className="card card-pad-lg">
              <div className="h3" style={{ marginBottom: 12 }}>Recently visited</div>
              <div className="col gap-sm">
                {recents.map(svc => (
                  <div key={svc.id} className="row gap-sm" style={{ cursor: 'pointer', padding: '6px 0' }} onClick={() => onSelect(svc.id)}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text-muted)', display: 'grid', placeItems: 'center' }}>
                      <Icon name={svc.icon} size={13} />
                    </div>
                    <span style={{ fontSize: 13, flex: 1 }}>{svc.name}</span>
                    <span className="faint" style={{ fontSize: 11 }}>{svc.category}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── A generic "service home" page used for services without dedicated content ─
function ServiceHomeV2({ service, onSelectPage }) {
  return (
    <div className="page" data-screen-label={`svc-${service.id}`}>
      <div className="breadcrumb">
        <a>orion</a>
        <span className="sep">/</span>
        <span>{service.category}</span>
        <span className="sep">/</span>
        <span>{service.name}</span>
      </div>

      <div className="page-header">
        <div>
          <h1 className="h1">{service.name}</h1>
          <p className="muted" style={{ marginTop: 4 }}>{service.desc}</p>
        </div>
        <div className="row gap-sm">
          <button className="btn btn-secondary">
            <Icon name="doc" size={14} /> Docs
          </button>
          <button className="btn btn-primary">
            <Icon name="plus" size={14} /> New
          </button>
        </div>
      </div>

      <div className="card card-pad-lg">
        <div className="empty-state">
          <div style={{ width: 64, height: 64, borderRadius: 16, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'grid', placeItems: 'center', marginBottom: 16 }}>
            <Icon name={service.icon} size={32} />
          </div>
          <div className="h3" style={{ color: 'var(--text)', marginBottom: 6 }}>{service.name}</div>
          <p className="muted" style={{ maxWidth: 460, marginBottom: 20 }}>
            This service uses the same scalable shell shown by <strong style={{ color: 'var(--text)' }}>Models</strong> — global service rail on the left, this service's own sub-nav next to it.
          </p>
          <div className="row gap-sm">
            <button className="btn btn-secondary" onClick={() => onSelectPage('list')}>
              See list page
            </button>
            <button className="btn btn-primary">
              <Icon name="plus" size={14} /> New {service.name.toLowerCase().replace(/s$/, '')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { HomeV2, ServiceHomeV2 });
