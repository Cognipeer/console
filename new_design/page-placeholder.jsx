/* global React, Icon, NAV_SECTIONS */
// Generic placeholder for un-prototyped services

function PlaceholderPage({ pageId, onNavigate }) {
  const item = NAV_SECTIONS.flatMap(s => s.items).find(i => i.id === pageId);
  if (!item) return null;

  return (
    <div className="page" data-screen-label={pageId}>
      <div className="breadcrumb">
        <a onClick={() => onNavigate('overview')}>orion</a>
        <span className="sep">/</span>
        <span>{item.label}</span>
      </div>

      <div className="page-header">
        <div>
          <h1 className="h1">{item.label}</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            {DESCRIPTIONS[pageId] || 'Service overview and management.'}
          </p>
        </div>
        <div className="row gap-sm">
          <button className="btn btn-secondary">
            <Icon name="doc" size={14} /> Docs
          </button>
          <button className="btn btn-primary">
            <Icon name="plus" size={14} /> New {item.label.toLowerCase()}
          </button>
        </div>
      </div>

      <div className="card card-pad-lg" style={{ marginBottom: 16 }}>
        <div className="empty-state">
          <div style={{ width: 64, height: 64, borderRadius: 16, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'grid', placeItems: 'center', marginBottom: 16 }}>
            <Icon name={item.icon} size={32} />
          </div>
          <div className="h3" style={{ color: 'var(--text)', marginBottom: 6 }}>{item.label} preview</div>
          <p className="muted" style={{ maxWidth: 460, marginBottom: 20 }}>
            This service follows the same shell pattern demonstrated on{' '}
            <a style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => onNavigate('models')}>Models</a>: a list/table view here, a detail page with tabs (Overview · Configure · Logs · Versions), and a ⌘K palette entry.
          </p>
          <div className="row gap-sm">
            <button className="btn btn-secondary" onClick={() => onNavigate('models')}>
              See pattern on Models
            </button>
            <button className="btn btn-primary">
              <Icon name="plus" size={14} /> New {item.label.toLowerCase()}
            </button>
          </div>
        </div>
      </div>

      {/* Show the same toolbar pattern as Models so consistency is visible */}
      <div className="card">
        <div className="toolbar">
          <div className="toolbar-search">
            <Icon name="search" size={14} style={{ color: 'var(--text-muted)' }} />
            <input placeholder={`Filter ${item.label.toLowerCase()}…`} />
          </div>
          <select className="select" style={{ width: 140 }}>
            <option>All statuses</option>
          </select>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm">
            <Icon name="refresh" size={14} />
          </button>
        </div>
        <div className="empty-state" style={{ padding: '64px 24px' }}>
          <Icon name={item.icon} size={28} style={{ color: 'var(--text-faint)', marginBottom: 12 }} />
          <div className="muted" style={{ fontSize: 13 }}>List view scaffolded · awaiting design sign-off on Models</div>
        </div>
      </div>
    </div>
  );
}

const DESCRIPTIONS = {
  tracing: 'End-to-end traces for every inference call across agents, prompts, and tools.',
  monitoring: 'Real-time performance dashboards for inference endpoints.',
  alerts: 'Active alerts and notification rules across the project.',
  prompts: 'Version-controlled prompt templates with evaluation runs.',
  agents: 'Orchestrated multi-step agents with tools and memory.',
  tools: 'Reusable function integrations exposed to agents and prompts.',
  mcp: 'Model Context Protocol servers connected to this workspace.',
  vector: 'Vector indexes and embedding pipelines.',
  memory: 'Semantic and conversational memory stores.',
  files: 'File storage and ingestion sources.',
  rag: 'Retrieval-augmented generation knowledge bases.',
  guardrails: 'Content safety and policy filters applied at runtime.',
  members: 'Team members, roles, and access policies.',
  providers: 'Configured AI provider credentials and quotas.',
  tokens: 'API tokens for programmatic access.',
  audit: 'Audit log of every action taken in this workspace.',
  license: 'License and seat usage for your organization.',
};

window.PlaceholderPage = PlaceholderPage;
