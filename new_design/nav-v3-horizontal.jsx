/* global React, Icon, SERVICES, SERVICE_SUBNAV */
// Horizontal context bar — replaces the left sub-nav

function ContextBar({ service, activePage, onSelectPage, isPinned, onTogglePin, onHome }) {
  if (!service) {
    // Home — simpler context bar with project chip
    return (
      <div className="ctxbar home">
        <div className="ctxbar-identity">
          <div className="icon"><Icon name="cube" size={14} /></div>
          <span className="name">Workspace home</span>
          <span className="env">orion · prod</span>
        </div>
        <div className="ctxbar-divider" />
        <div className="ctxbar-tabs">
          <button className="ctxbar-tab active">Pinned</button>
          <button className="ctxbar-tab">All services</button>
          <button className="ctxbar-tab">Recent</button>
        </div>
        <div className="ctxbar-actions">
          <button className="btn btn-secondary btn-sm">
            <Icon name="plus" size={12} /> Quick start
          </button>
        </div>
      </div>
    );
  }

  const items = SERVICE_SUBNAV[service.id] || SERVICE_SUBNAV._default;

  return (
    <div className="ctxbar">
      <div className="ctxbar-identity">
        <div className="icon"><Icon name={service.icon} size={14} /></div>
        <span className="name">{service.name}</span>
        <span className="env">{service.category}</span>
      </div>
      <div className="ctxbar-divider" />

      <div className="ctxbar-tabs">
        {items.map(item => (
          <button
            key={item.id}
            className={`ctxbar-tab ${activePage === item.id ? 'active' : ''}`}
            onClick={() => onSelectPage(item.id)}
          >
            <Icon name={item.icon} size={13} />
            <span>{item.label}</span>
            {item.badge && <span className="ctxbar-tab-badge">{item.badge}</span>}
          </button>
        ))}
      </div>

      <div className="ctxbar-actions">
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onTogglePin} title={isPinned ? 'Unpin' : 'Pin to rail'} style={{ color: isPinned ? 'var(--accent)' : undefined }}>
          <Icon name="pin" size={14} />
        </button>
        <button className="btn btn-ghost btn-sm btn-icon" title="Docs">
          <Icon name="doc" size={14} />
        </button>
        <div className="ctxbar-divider" />
        <button className="btn btn-secondary btn-sm">
          <Icon name="plus" size={12} /> New
        </button>
      </div>
    </div>
  );
}

Object.assign(window, { ContextBar });
