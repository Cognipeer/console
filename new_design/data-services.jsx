/* global React */
// Extended services — 40+ to demonstrate scale

const SERVICES = [
  // OPERATE
  { id: 'overview',    name: 'Overview',     category: 'Operate', icon: 'dashboard',  desc: 'Project metrics and activity', popular: true },
  { id: 'tracing',     name: 'Tracing',      category: 'Operate', icon: 'timeline',   desc: 'End-to-end request traces', popular: true },
  { id: 'monitoring',  name: 'Monitoring',   category: 'Operate', icon: 'graph',      desc: 'Performance dashboards' },
  { id: 'alerts',      name: 'Alerts',       category: 'Operate', icon: 'bell',       desc: 'Alert rules and incidents', badge: 3 },
  { id: 'health',      name: 'Service Health', category: 'Operate', icon: 'shield',   desc: 'Status of all systems', badge: 'new' },
  { id: 'status',      name: 'Status Page',  category: 'Operate', icon: 'flag',       desc: 'Public status reporting' },
  { id: 'cost',        name: 'Cost Analyzer',category: 'Operate', icon: 'graph',      desc: 'Spend breakdown and forecasts' },
  { id: 'quotas',      name: 'Quotas',       category: 'Operate', icon: 'bolt',       desc: 'Limits and consumption' },

  // BUILD
  { id: 'models',      name: 'Models',       category: 'Build',   icon: 'brain',      desc: 'Inference endpoints across providers', popular: true, pinned: true },
  { id: 'prompts',     name: 'Prompts',      category: 'Build',   icon: 'sparkles',   desc: 'Versioned prompt templates', popular: true, pinned: true },
  { id: 'agents',      name: 'Agents',       category: 'Build',   icon: 'robot',      desc: 'Orchestrated multi-step agents', popular: true, pinned: true },
  { id: 'tools',       name: 'Tools',        category: 'Build',   icon: 'tool',       desc: 'Function integrations for agents', pinned: true },
  { id: 'mcp',         name: 'MCP Servers',  category: 'Build',   icon: 'api',        desc: 'Model Context Protocol servers' },
  { id: 'workflows',   name: 'Workflows',    category: 'Build',   icon: 'arrowsLeftRight', desc: 'Long-running orchestrations' },
  { id: 'webhooks',    name: 'Webhooks',     category: 'Build',   icon: 'send',       desc: 'Outbound event subscriptions' },
  { id: 'notebooks',   name: 'Notebooks',    category: 'Build',   icon: 'doc',        desc: 'Hosted Jupyter for experimentation' },
  { id: 'templates',   name: 'Templates',    category: 'Build',   icon: 'layers',     desc: 'Starter kits for common patterns' },
  { id: 'finetuning',  name: 'Fine-tuning',  category: 'Build',   icon: 'sparkles',   desc: 'Custom model training jobs' },

  // DATA
  { id: 'vector',      name: 'Vector',       category: 'Data',    icon: 'vector',     desc: 'Vector indexes and embeddings', popular: true, pinned: true },
  { id: 'memory',      name: 'Memory',       category: 'Data',    icon: 'bulb',       desc: 'Semantic memory stores' },
  { id: 'files',       name: 'Files',        category: 'Data',    icon: 'folder',     desc: 'File storage and ingestion' },
  { id: 'rag',         name: 'RAG',          category: 'Data',    icon: 'book',       desc: 'Knowledge bases for retrieval', popular: true, pinned: true },
  { id: 'datasets',    name: 'Datasets',     category: 'Data',    icon: 'database',   desc: 'Labeled datasets for training' },
  { id: 'evals',       name: 'Evaluations',  category: 'Data',    icon: 'check',      desc: 'Eval suites and benchmark runs', badge: 'new' },
  { id: 'experiments', name: 'Experiments',  category: 'Data',    icon: 'flag',       desc: 'A/B and shadow traffic tests' },
  { id: 'caches',      name: 'Caches',       category: 'Data',    icon: 'database',   desc: 'Inference response caches' },
  { id: 'snapshots',   name: 'Snapshots',    category: 'Data',    icon: 'cube',       desc: 'Point-in-time backups' },

  // SECURITY
  { id: 'guardrails',  name: 'Guardrails',   category: 'Security',icon: 'shield',     desc: 'Content safety policies' },
  { id: 'secrets',     name: 'Secrets',      category: 'Security',icon: 'lock',       desc: 'Encrypted secret values' },
  { id: 'tokens',      name: 'API Tokens',   category: 'Security',icon: 'key',        desc: 'Programmatic access tokens', pinned: true },
  { id: 'sso',         name: 'SSO',          category: 'Security',icon: 'lock',       desc: 'Single sign-on configuration' },
  { id: 'identity',    name: 'Identity',     category: 'Security',icon: 'users',      desc: 'Identity providers' },
  { id: 'audit',       name: 'Audit log',    category: 'Security',icon: 'clipboard',  desc: 'Every action, every user' },
  { id: 'firewall',    name: 'Firewall',     category: 'Security',icon: 'shield',     desc: 'IP allow-lists and rules' },

  // ADMIN
  { id: 'members',     name: 'Members',      category: 'Admin',   icon: 'users',      desc: 'Team members and roles' },
  { id: 'roles',       name: 'Roles',        category: 'Admin',   icon: 'certificate',desc: 'Custom permission roles' },
  { id: 'projects',    name: 'Projects',     category: 'Admin',   icon: 'cube',       desc: 'Workspace management' },
  { id: 'environments',name: 'Environments', category: 'Admin',   icon: 'layers',     desc: 'dev / staging / prod' },
  { id: 'providers',   name: 'Providers',    category: 'Admin',   icon: 'plug',       desc: 'AI provider credentials' },
  { id: 'integrations',name: 'Integrations', category: 'Admin',   icon: 'plug',       desc: 'Third-party connectors' },
  { id: 'marketplace', name: 'Marketplace',  category: 'Admin',   icon: 'star',       desc: 'Community-built tools and agents' },
  { id: 'billing',     name: 'Billing',      category: 'Admin',   icon: 'certificate',desc: 'Invoices and payment' },
  { id: 'license',     name: 'License',      category: 'Admin',   icon: 'certificate',desc: 'Seat and feature usage' },
  { id: 'notifications',name:'Notifications',category: 'Admin',   icon: 'bell',       desc: 'Personal notification settings' },
  { id: 'releases',    name: 'Releases',     category: 'Admin',   icon: 'cube',       desc: 'Platform changelog and rollouts' },
];

// Each service's own sub-navigation (when you "enter" it)
const SERVICE_SUBNAV = {
  models: [
    { id: 'overview',  label: 'Overview',  icon: 'dashboard' },
    { id: 'list',      label: 'Endpoints', icon: 'brain', badge: 12 },
    { id: 'catalog',   label: 'Catalog',   icon: 'star' },
    { id: 'routing',   label: 'Routing',   icon: 'arrowsLeftRight' },
    { id: 'evals',     label: 'Evaluations', icon: 'check' },
    { id: 'settings',  label: 'Settings',  icon: 'settings' },
  ],
  agents: [
    { id: 'overview',  label: 'Overview',  icon: 'dashboard' },
    { id: 'list',      label: 'Agents',    icon: 'robot' },
    { id: 'tools',     label: 'Tools',     icon: 'tool' },
    { id: 'runs',      label: 'Runs',      icon: 'timeline' },
    { id: 'eval',      label: 'Evaluations', icon: 'check' },
    { id: 'settings',  label: 'Settings',  icon: 'settings' },
  ],
  prompts: [
    { id: 'overview',  label: 'Overview',  icon: 'dashboard' },
    { id: 'list',      label: 'Templates', icon: 'sparkles' },
    { id: 'playground',label: 'Playground',icon: 'play' },
    { id: 'versions',  label: 'Versions',  icon: 'layers' },
    { id: 'eval',      label: 'Evaluations', icon: 'check' },
  ],
  rag: [
    { id: 'overview',  label: 'Overview',     icon: 'dashboard' },
    { id: 'kbs',       label: 'Knowledge bases', icon: 'book' },
    { id: 'ingestion', label: 'Ingestion',    icon: 'upload' },
    { id: 'retrieval', label: 'Retrieval',    icon: 'search' },
    { id: 'settings',  label: 'Settings',     icon: 'settings' },
  ],
  vector: [
    { id: 'overview',  label: 'Overview', icon: 'dashboard' },
    { id: 'indexes',   label: 'Indexes',  icon: 'vector' },
    { id: 'jobs',      label: 'Jobs',     icon: 'timeline' },
    { id: 'settings',  label: 'Settings', icon: 'settings' },
  ],
  providers: [
    { id: 'list',      label: 'All providers', icon: 'plug', badge: 17 },
    { id: 'health',    label: 'Health',        icon: 'shield' },
    { id: 'quotas',    label: 'Quotas',        icon: 'bolt' },
    { id: 'settings',  label: 'Settings',      icon: 'settings' },
  ],
  // Default sub-nav for un-detailed services
  _default: [
    { id: 'overview',  label: 'Overview', icon: 'dashboard' },
    { id: 'list',      label: 'Resources',icon: 'layers' },
    { id: 'settings',  label: 'Settings', icon: 'settings' },
  ],
};

Object.assign(window, { SERVICES, SERVICE_SUBNAV });
