/* global React, Icon, MODEL_CATALOG, PROVIDER_CATALOG, CONFIGURED_PROVIDERS, ProviderLogo */
// Model deployment form — full-screen, two-pane

// Pretty-print pricing
function fmtPrice(n) {
  if (n === 0) return 'free';
  return `$${n.toFixed(2)}/M`;
}

// Generate endpoint ID from display name
function slugifyId(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

const MODALITY_ICON = { text: 'doc', vision: 'eye', audio: 'play' };

function ModelPickerCard({ model, selected, onSelect }) {
  return (
    <div
      className={`mdfm-mcard ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(model)}
    >
      <div className="row gap-sm" style={{ marginBottom: 4 }}>
        <ProviderLogo catalogId={model.provider} size={22} />
        <span className="mname" style={{ flex: 1, paddingRight: 24 }}>{model.name}</span>
      </div>
      <div className="mmeta">
        <span className="badge" style={{ height: 18, padding: '0 6px', fontSize: 10.5 }}>{model.type}</span>
        <span>{model.context}</span>
        {model.modalities.filter(m => m !== 'text').map(m => (
          <span key={m} title={m} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <Icon name={MODALITY_ICON[m] || 'doc'} size={10} /> {m}
          </span>
        ))}
        {model.popular && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--warn)' }}>
            <Icon name="star" size={10} /> popular
          </span>
        )}
      </div>
      <div className="mpricing">
        {model.type === 'chat' || model.type === 'rerank'
          ? `${fmtPrice(model.pricing.in)} in · ${fmtPrice(model.pricing.out)} out`
          : `${fmtPrice(model.pricing.in)} per 1M tokens`}
      </div>
    </div>
  );
}

function ModelDeployForm({ open, onClose, onDeploy }) {
  // State
  const [source, setSource] = React.useState('catalog'); // catalog | custom
  const [providerFilter, setProviderFilter] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [selectedModel, setSelectedModel] = React.useState(null);
  const [customUrl, setCustomUrl] = React.useState('');

  const [displayName, setDisplayName] = React.useState('');
  const [endpointId, setEndpointId] = React.useState('');
  const [endpointIdEdited, setEndpointIdEdited] = React.useState(false);
  const [alias, setAlias] = React.useState('production');
  const [description, setDescription] = React.useState('');
  const [tags, setTags] = React.useState(['production']);

  const [rpm, setRpm] = React.useState(2000);
  const [tpm, setTpm] = React.useState(2_000_000);
  const [fallback, setFallback] = React.useState('none');
  const [autoRetry, setAutoRetry] = React.useState(true);
  const [cache, setCache] = React.useState(false);

  const [temperature, setTemperature] = React.useState(0.2);
  const [maxTokens, setMaxTokens] = React.useState(2048);
  const [topP, setTopP] = React.useState(1);
  const [responseFmt, setResponseFmt] = React.useState('text');

  const [envs, setEnvs] = React.useState(new Set(['production']));
  const [guardrails, setGuardrails] = React.useState(new Set(['pii-redactor']));

  // Reset on open
  React.useEffect(() => {
    if (!open) return;
    setSource('catalog');
    setProviderFilter('all');
    setSearch('');
    setSelectedModel(null);
    setDisplayName('');
    setEndpointId('');
    setEndpointIdEdited(false);
    setAlias('production');
    setDescription('');
    setTags(['production']);
    setRpm(2000);
    setTpm(2_000_000);
    setFallback('none');
    setAutoRetry(true);
    setCache(false);
    setTemperature(0.2);
    setMaxTokens(2048);
    setTopP(1);
    setResponseFmt('text');
    setEnvs(new Set(['production']));
    setGuardrails(new Set(['pii-redactor']));
  }, [open]);

  // Auto-fill name when model selected
  React.useEffect(() => {
    if (selectedModel) {
      const baseName = `${selectedModel.name}-${alias}`;
      setDisplayName(baseName);
      if (!endpointIdEdited) setEndpointId(slugifyId(baseName));
    }
  }, [selectedModel, alias]);

  React.useEffect(() => {
    if (!endpointIdEdited) setEndpointId(slugifyId(displayName));
  }, [displayName, endpointIdEdited]);

  // Esc to close
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Filter catalog
  const usedProviders = [...new Set(MODEL_CATALOG.map(m => m.provider))];
  const filteredModels = MODEL_CATALOG.filter(m => {
    if (providerFilter !== 'all' && m.provider !== providerFilter) return false;
    if (search && !m.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const provider = selectedModel
    ? PROVIDER_CATALOG.find(p => p.id === selectedModel.provider)
    : null;

  // Cost estimate — 1M calls @ avg 1000 in / 500 out tokens
  const estCost = selectedModel
    ? ((selectedModel.pricing.in * 1000 + selectedModel.pricing.out * 500) * 1)
    : 0;

  // Validation
  const validSource = source === 'catalog' ? !!selectedModel : !!customUrl;
  const validIdentity = !!displayName && !!endpointId;
  const canDeploy = validSource && validIdentity;

  const checklist = [
    { id: 1, label: 'Source selected',                done: validSource },
    { id: 2, label: 'Display name set',               done: validIdentity },
    { id: 3, label: 'Routing limits configured',      done: rpm > 0 },
    { id: 4, label: 'At least one environment',       done: envs.size > 0 },
  ];

  const toggleSetItem = (set, item, setter) => {
    const n = new Set(set);
    if (n.has(item)) n.delete(item); else n.add(item);
    setter(n);
  };

  return (
    <div className="mdfm-overlay">
      <div className="mdfm-header">
        <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
        <div className="row gap-sm">
          <div className="icon"><Icon name="brain" size={16} /></div>
          <div>
            <div className="title">Deploy model</div>
            <div className="sub">Add a new inference endpoint to <strong style={{ color: 'var(--text)' }}>orion · prod</strong></div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div className="muted" style={{ fontSize: 12 }}>
          Press <span className="kbd-key">ESC</span> to cancel
        </div>
      </div>

      <div className="mdfm-body">
        {/* ─── Form (left) ─────────────────────────────────────── */}
        <div className="mdfm-form">

          {/* SECTION 1 — Source */}
          <section className="mdfm-section">
            <header className="mdfm-section-header">
              <div className={`mdfm-section-num ${validSource ? 'done' : ''}`}>
                {validSource ? <Icon name="check" size={11} stroke={3} /> : '1'}
              </div>
              <div className="mdfm-section-title">Source</div>
            </header>
            <div className="mdfm-section-desc">Pick a model from the catalog of your connected providers, or point to a custom endpoint.</div>

            <div className="mdfm-source-toggle">
              <button
                type="button"
                className={`mdfm-source-card ${source === 'catalog' ? 'selected' : ''}`}
                onClick={() => setSource('catalog')}
              >
                <div className="h">
                  <Icon name="star" size={15} style={{ color: source === 'catalog' ? 'var(--accent)' : 'var(--text-muted)' }} />
                  <span className="name">From provider catalog</span>
                </div>
                <div className="desc">Choose a model from any of your {CONFIGURED_PROVIDERS.filter(p => p.type === 'llm').length} configured LLM providers.</div>
              </button>
              <button
                type="button"
                className={`mdfm-source-card ${source === 'custom' ? 'selected' : ''}`}
                onClick={() => setSource('custom')}
              >
                <div className="h">
                  <Icon name="api" size={15} style={{ color: source === 'custom' ? 'var(--accent)' : 'var(--text-muted)' }} />
                  <span className="name">Custom endpoint</span>
                </div>
                <div className="desc">Point to any OpenAI-compatible inference URL.</div>
              </button>
            </div>

            {source === 'catalog' && (
              <>
                {/* Provider filter chips */}
                <div className="mdfm-provider-chips">
                  <button
                    className={`mdfm-pchip ${providerFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setProviderFilter('all')}
                  >
                    <span>All providers</span>
                    <span className="lg muted">{MODEL_CATALOG.length}</span>
                  </button>
                  {usedProviders.map(pid => {
                    const p = PROVIDER_CATALOG.find(x => x.id === pid);
                    if (!p) return null;
                    const count = MODEL_CATALOG.filter(m => m.provider === pid).length;
                    return (
                      <button
                        key={pid}
                        className={`mdfm-pchip ${providerFilter === pid ? 'active' : ''}`}
                        onClick={() => setProviderFilter(pid)}
                      >
                        <ProviderLogo catalogId={pid} size={16} />
                        <span>{p.name}</span>
                        <span className="lg muted">{count}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Search */}
                <div className="toolbar-search" style={{ maxWidth: 'none', marginBottom: 12, background: 'var(--surface-raised)' }}>
                  <Icon name="search" size={14} style={{ color: 'var(--text-muted)' }} />
                  <input
                    placeholder="Search models by name…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>

                {/* Model grid */}
                <div className="mdfm-model-grid">
                  {filteredModels.map(m => (
                    <ModelPickerCard
                      key={m.id}
                      model={m}
                      selected={selectedModel?.id === m.id}
                      onSelect={setSelectedModel}
                    />
                  ))}
                  {filteredModels.length === 0 && (
                    <div style={{ gridColumn: '1 / -1', padding: 32, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>
                      No models match your filter.
                    </div>
                  )}
                </div>
              </>
            )}

            {source === 'custom' && (
              <div className="card card-pad" style={{ background: 'var(--surface-raised)' }}>
                <div className="mdfm-field" style={{ marginBottom: 16 }}>
                  <label>Endpoint URL <span style={{ color: 'var(--err)' }}>*</span></label>
                  <input
                    className="input mono"
                    placeholder="https://my-llm.company.com/v1"
                    value={customUrl}
                    onChange={(e) => setCustomUrl(e.target.value)}
                    style={{ fontSize: 12.5 }}
                  />
                  <div className="help">Must be OpenAI-compatible (<span className="mono">/chat/completions</span> endpoint).</div>
                </div>
                <div className="mdfm-row">
                  <div className="mdfm-field">
                    <label>Model identifier</label>
                    <input className="input mono" placeholder="llama-3.3-70b" style={{ fontSize: 12.5 }} />
                  </div>
                  <div className="mdfm-field">
                    <label>Auth header</label>
                    <select className="select">
                      <option>Bearer token</option>
                      <option>API key header</option>
                      <option>None</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* SECTION 2 — Identity */}
          <section className="mdfm-section">
            <header className="mdfm-section-header">
              <div className={`mdfm-section-num ${validIdentity ? 'done' : ''}`}>
                {validIdentity ? <Icon name="check" size={11} stroke={3} /> : '2'}
              </div>
              <div className="mdfm-section-title">Identity</div>
            </header>
            <div className="mdfm-section-desc">How this endpoint appears across the console and SDK.</div>

            <div className="mdfm-row">
              <div className="mdfm-field">
                <label>Display name <span style={{ color: 'var(--err)' }}>*</span></label>
                <input
                  className="input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="my-production-model"
                />
              </div>
              <div className="mdfm-field">
                <label>
                  Endpoint ID
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ height: 18, padding: '0 6px', fontSize: 10, marginLeft: 8 }}
                    onClick={() => { setEndpointIdEdited(false); setEndpointId(slugifyId(displayName)); }}
                  >
                    auto
                  </button>
                </label>
                <input
                  className="input mono"
                  value={endpointId}
                  onChange={(e) => { setEndpointId(e.target.value); setEndpointIdEdited(true); }}
                  style={{ fontSize: 12.5 }}
                />
                <div className="help">Used in URL: <span className="mono">/v1/inference/{endpointId || '<id>'}</span></div>
              </div>
            </div>

            <div className="mdfm-row">
              <div className="mdfm-field">
                <label>Alias</label>
                <div className="mdfm-chip-picker">
                  {['production', 'staging', 'experimental', 'sandbox'].map(a => (
                    <button
                      key={a}
                      type="button"
                      className={`chip ${alias === a ? 'selected' : ''}`}
                      onClick={() => setAlias(a)}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mdfm-field">
                <label>Tags</label>
                <div className="mdfm-chip-picker">
                  {tags.map(t => (
                    <span key={t} className="chip selected" onClick={() => setTags(tags.filter(x => x !== t))} style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {t}
                      <Icon name="x" size={10} />
                    </span>
                  ))}
                  <span className="chip add">+ add tag</span>
                </div>
              </div>
            </div>

            <div className="mdfm-row single">
              <div className="mdfm-field">
                <label>Description <span className="faint" style={{ fontWeight: 400 }}>· optional</span></label>
                <textarea
                  className="input"
                  rows={2}
                  placeholder="What is this endpoint used for?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
          </section>

          {/* SECTION 3 — Routing & reliability */}
          <section className="mdfm-section">
            <header className="mdfm-section-header">
              <div className={`mdfm-section-num ${rpm > 0 ? 'done' : ''}`}>
                {rpm > 0 ? <Icon name="check" size={11} stroke={3} /> : '3'}
              </div>
              <div className="mdfm-section-title">Routing &amp; reliability</div>
            </header>
            <div className="mdfm-section-desc">Control how Cognipeer routes traffic, handles failures, and protects upstream quota.</div>

            <div className="mdfm-row">
              <div className="mdfm-field">
                <label>Requests per minute</label>
                <input className="input mono" type="number" value={rpm} onChange={(e) => setRpm(+e.target.value)} style={{ fontSize: 13 }} />
                <div className="help">Soft limit — surplus calls are queued for up to 10s.</div>
              </div>
              <div className="mdfm-field">
                <label>Tokens per minute</label>
                <input className="input mono" type="number" value={tpm} onChange={(e) => setTpm(+e.target.value)} style={{ fontSize: 13 }} />
                <div className="help">Combined input + output tokens.</div>
              </div>
            </div>

            <div className="mdfm-row single">
              <div className="mdfm-field">
                <label>Fallback model</label>
                <select className="select" value={fallback} onChange={(e) => setFallback(e.target.value)}>
                  <option value="none">None</option>
                  <option value="gpt-4o-mini">gpt-4o-mini (OpenAI)</option>
                  <option value="haiku-3.5">claude-haiku-3.5 (Anthropic)</option>
                  <option value="cognipeer-fast">cognipeer-fast (Cognipeer)</option>
                </select>
                <div className="help">Used if this endpoint returns 5xx or hits its rate limit.</div>
              </div>
            </div>

            <div className="mdfm-toggle-list">
              <label className="mdfm-toggle-row">
                <input type="checkbox" className="checkbox" checked={autoRetry} onChange={(e) => setAutoRetry(e.target.checked)} />
                <div className="tx">
                  <div className="name">Auto-retry on transient failures</div>
                  <div className="desc">Retry up to 2 times on upstream 5xx and timeouts with exponential backoff.</div>
                </div>
              </label>
              <label className="mdfm-toggle-row">
                <input type="checkbox" className="checkbox" checked={cache} onChange={(e) => setCache(e.target.checked)} />
                <div className="tx">
                  <div className="name">Cache identical responses</div>
                  <div className="desc">Cache exact-match prompts for 60 seconds. Best for retrieval and high-volume reads.</div>
                </div>
              </label>
            </div>
          </section>

          {/* SECTION 4 — Default parameters */}
          <section className="mdfm-section">
            <header className="mdfm-section-header">
              <div className="mdfm-section-num done"><Icon name="check" size={11} stroke={3} /></div>
              <div className="mdfm-section-title">Default parameters</div>
            </header>
            <div className="mdfm-section-desc">Used when callers don't specify their own. They can always be overridden per-request.</div>

            <div className="mdfm-row">
              <div className="mdfm-field">
                <label>Temperature</label>
                <div className="mdfm-slider-row">
                  <input type="range" min="0" max="1" step="0.05" value={temperature} onChange={(e) => setTemperature(+e.target.value)} />
                  <div className="val">{temperature.toFixed(2)}</div>
                </div>
                <div className="help">Higher = more creative · Lower = more deterministic.</div>
              </div>
              <div className="mdfm-field">
                <label>Top P</label>
                <div className="mdfm-slider-row">
                  <input type="range" min="0" max="1" step="0.05" value={topP} onChange={(e) => setTopP(+e.target.value)} />
                  <div className="val">{topP.toFixed(2)}</div>
                </div>
                <div className="help">Nucleus sampling. Keep at 1 unless you know what you're doing.</div>
              </div>
            </div>

            <div className="mdfm-row">
              <div className="mdfm-field">
                <label>Max output tokens</label>
                <div className="mdfm-slider-row">
                  <input type="range" min="256" max={selectedModel ? 32768 : 4096} step="256" value={maxTokens} onChange={(e) => setMaxTokens(+e.target.value)} />
                  <div className="val" style={{ width: 64 }}>{maxTokens.toLocaleString()}</div>
                </div>
                <div className="help">{selectedModel ? `Model supports up to ${selectedModel.maxOut}.` : 'Pick a model to see its limit.'}</div>
              </div>
              <div className="mdfm-field">
                <label>Response format</label>
                <select className="select" value={responseFmt} onChange={(e) => setResponseFmt(e.target.value)}>
                  <option value="text">Free-form text</option>
                  <option value="json">JSON object</option>
                  <option value="json_schema">JSON with schema</option>
                </select>
              </div>
            </div>
          </section>

          {/* SECTION 5 — Access & guardrails */}
          <section className="mdfm-section">
            <header className="mdfm-section-header">
              <div className={`mdfm-section-num ${envs.size > 0 ? 'done' : ''}`}>
                {envs.size > 0 ? <Icon name="check" size={11} stroke={3} /> : '5'}
              </div>
              <div className="mdfm-section-title">Access &amp; guardrails</div>
            </header>
            <div className="mdfm-section-desc">Where this endpoint runs and which safety policies apply.</div>

            <div className="mdfm-field" style={{ marginBottom: 16 }}>
              <label>Environments</label>
              <div className="mdfm-chip-picker">
                {[
                  { id: 'dev',        label: 'Development' },
                  { id: 'staging',    label: 'Staging' },
                  { id: 'production', label: 'Production' },
                ].map(e => (
                  <button
                    key={e.id}
                    type="button"
                    className={`chip ${envs.has(e.id) ? 'selected' : ''}`}
                    onClick={() => toggleSetItem(envs, e.id, setEnvs)}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
              <div className="help">Endpoint is reachable only via tokens scoped to the selected environments.</div>
            </div>

            <div className="mdfm-toggle-list">
              {[
                { id: 'pii-redactor', name: 'PII Redactor',         desc: 'Strips emails, phone numbers, credit cards, and SSNs from both prompts and completions.' },
                { id: 'toxicity',     name: 'Toxicity filter',       desc: 'Blocks responses scoring above a 0.7 toxicity threshold.' },
                { id: 'jailbreak',    name: 'Jailbreak detector',    desc: 'Flags prompts matching known jailbreak patterns.' },
                { id: 'budget',       name: 'Cost ceiling · $100/d', desc: 'Stops serving once daily spend exceeds the threshold.' },
              ].map(g => (
                <label key={g.id} className="mdfm-toggle-row">
                  <input type="checkbox" className="checkbox" checked={guardrails.has(g.id)} onChange={() => toggleSetItem(guardrails, g.id, setGuardrails)} />
                  <div className="tx">
                    <div className="name">{g.name}</div>
                    <div className="desc">{g.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </section>
        </div>

        {/* ─── Summary (right) ─────────────────────────────────── */}
        <aside className="mdfm-summary">
          <h3>Summary</h3>

          {selectedModel ? (
            <div className="mdfm-summary-block">
              <div className="row gap-sm" style={{ marginBottom: 12 }}>
                <ProviderLogo catalogId={selectedModel.provider} size={32} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{selectedModel.name}</div>
                  <div className="faint" style={{ fontSize: 11.5 }}>{provider?.name}</div>
                </div>
              </div>
              <div className="mdfm-kv"><span className="k">Type</span><span className="v">{selectedModel.type}</span></div>
              <div className="mdfm-kv"><span className="k">Context</span><span className="v">{selectedModel.context}</span></div>
              <div className="mdfm-kv"><span className="k">Max output</span><span className="v">{selectedModel.maxOut}</span></div>
              <div className="mdfm-kv"><span className="k">Modalities</span><span className="v">{selectedModel.modalities.join(', ')}</span></div>
              <div className="mdfm-kv"><span className="k">Input price</span><span className="v">{fmtPrice(selectedModel.pricing.in)}</span></div>
              <div className="mdfm-kv"><span className="k">Output price</span><span className="v">{fmtPrice(selectedModel.pricing.out)}</span></div>
            </div>
          ) : (
            <div className="mdfm-summary-block mdfm-summary-empty">
              <Icon name="brain" size={20} style={{ marginBottom: 6, opacity: 0.5 }} />
              <div>Pick a model to see its specs</div>
            </div>
          )}

          <h3 style={{ marginTop: 20 }}>Endpoint</h3>
          <div className="mdfm-summary-block">
            <div className="mdfm-kv">
              <span className="k">URL</span>
            </div>
            <div className="code" style={{ fontSize: 11.5, padding: '8px 10px', marginTop: 4, wordBreak: 'break-all' }}>
              {`POST /v1/inference/${endpointId || '<endpoint-id>'}`}
            </div>
            <div className="mdfm-kv" style={{ borderTop: '1px solid var(--border-soft)', marginTop: 8 }}>
              <span className="k">Alias</span>
              <span className="v">{alias}</span>
            </div>
            <div className="mdfm-kv">
              <span className="k">Rate limit</span>
              <span className="v">{rpm.toLocaleString()} rpm</span>
            </div>
            <div className="mdfm-kv">
              <span className="k">Token limit</span>
              <span className="v">{(tpm / 1000).toLocaleString()}k tpm</span>
            </div>
            <div className="mdfm-kv">
              <span className="k">Guardrails</span>
              <span className="v">{guardrails.size}</span>
            </div>
          </div>

          {selectedModel && (
            <div className="mdfm-est-cost">
              <div className="label">Est. cost / 1M calls</div>
              <div className="val">${estCost.toFixed(2)}</div>
              <div className="desc">Assuming avg 1k in + 0.5k out tokens. Real usage may vary.</div>
            </div>
          )}

          <h3 style={{ marginTop: 20 }}>Pre-flight</h3>
          <ul className="mdfm-checklist">
            {checklist.map(c => (
              <li key={c.id} className={c.done ? 'done' : 'todo'}>
                <span className="dot">
                  {c.done && <Icon name="check" size={9} stroke={3} />}
                </span>
                <span style={{ color: c.done ? 'var(--text)' : 'var(--text-muted)' }}>{c.label}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <div className="mdfm-footer">
        <button className="btn btn-ghost btn-sm">
          <Icon name="download" size={12} /> Export as YAML
        </button>
        <div style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 12 }}>
          {checklist.filter(c => c.done).length} of {checklist.length} ready
        </span>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={!canDeploy}
          style={{ opacity: canDeploy ? 1 : 0.5, cursor: canDeploy ? 'pointer' : 'not-allowed' }}
          onClick={() => onDeploy && onDeploy({ model: selectedModel, displayName, endpointId, alias, rpm, tpm, temperature, maxTokens })}
        >
          <Icon name="bolt" size={13} />
          Deploy endpoint
        </button>
      </div>
    </div>
  );
}

Object.assign(window, { ModelDeployForm });
