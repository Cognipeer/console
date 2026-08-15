import { defineConfig } from 'vitepress';

const docsBase = process.env.GITHUB_PAGES === 'true' ? '/console/' : '/';

// Task-shaped guides. Shown as their own section and repeated at the top of the
// Guide sidebar, because most people arrive wanting to do a thing, not to read a
// reference page.
const howToSidebar = [
  {
    text: 'How-To',
    collapsed: false,
    items: [
      { text: 'All guides', link: '/how-to/' },
      { text: 'Connect an OpenAI-compatible client', link: '/how-to/connect-openai-client' },
      { text: 'Create your first model', link: '/how-to/first-model' },
      { text: 'Add a guardrail and PII policy', link: '/how-to/guardrail-and-pii' },
      { text: 'Trace an existing agent', link: '/how-to/trace-an-existing-agent' },
      { text: 'Crawl a website into the Knowledge Engine', link: '/how-to/crawl-a-site' },
      { text: 'Automate a browser task', link: '/how-to/automate-a-browser-task' },
      { text: 'Build and publish an agent', link: '/how-to/build-and-publish-an-agent' },
      { text: 'Optimize token usage', link: '/how-to/optimize-token-usage' },
      { text: 'Build a dataset from production traffic', link: '/how-to/dataset-from-production-traffic' },
      { text: 'Route requests with a Dynamic LLM', link: '/how-to/route-with-dynamic-llm' },
    ],
  },
];

export default defineConfig({
  title: 'Cognipeer Console',
  description:
    'Multi-tenant AI platform for LLM inference, vector stores, agent tracing, Knowledge Engine, and more.',
  base: docsBase,
  // Kept strict on purpose. This was `true`, and it was quietly hiding a whole
  // sidebar section's worth of links to pages that did not exist yet.
  ignoreDeadLinks: false,
  appearance: 'dark',

  markdown: {
    // Code blocks use an always-dark "terminal" background in both light and
    // dark site themes (see theme/custom.css --cp-bg-code). VitePress' default
    // dual Shiki theme would apply light-mode (dark-on-white) token colors on
    // that dark background in light mode, making code unreadable. Pin a single
    // dark Shiki theme so tokens stay light-on-dark regardless of site theme.
    theme: 'github-dark',
  },

  themeConfig: {
    logo: '/Console.svg',
    siteTitle: 'Cognipeer Console',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'How-To', link: '/how-to/' },
      { text: 'Architecture', link: '/guide/architecture' },
      { text: 'Core Modules', link: '/guide/core-overview' },
      { text: 'API Reference', link: '/api/overview' },
      { text: 'SDK Docs', link: 'https://cognipeer.github.io/console-sdk/' },
      { text: 'Licensing', link: '/guide/licensing' },
      {
        text: 'v0.1.0',
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: 'Contributing', link: '/contributing' },
          { text: 'Security', link: '/guide/security' },
          { text: 'Commercial', link: '/guide/licensing#commercial-options' },
        ],
      },
    ],

    sidebar: {
      '/how-to/': howToSidebar,

      '/guide/': [
        ...howToSidebar,
        {
          text: 'Introduction',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Using the SDK', link: '/guide/sdk-integration' },
          ],
        },
        {
          text: 'Core Modules',
          items: [
            { text: 'Overview', link: '/guide/core-overview' },
            { text: 'Config', link: '/guide/core-config' },
            { text: 'Logger', link: '/guide/core-logger' },
            { text: 'Request Context', link: '/guide/core-request-context' },
            { text: 'Cache', link: '/guide/core-cache' },
            { text: 'Resilience', link: '/guide/core-resilience' },
            { text: 'Runtime Pool', link: '/guide/core-runtime-pool' },
            { text: 'Async Tasks', link: '/guide/core-async-tasks' },
            { text: 'Health Checks', link: '/guide/core-health' },
            { text: 'Lifecycle & Shutdown', link: '/guide/core-lifecycle' },
            { text: 'CORS', link: '/guide/core-cors' },
          ],
        },
        {
          text: 'Features',
          items: [
            { text: 'Multi-Tenancy', link: '/guide/multi-tenancy' },
            { text: 'Authentication', link: '/guide/authentication' },
            { text: 'Service Catalog', link: '/guide/service-catalog' },
            { text: 'Command Palette', link: '/guide/command-palette' },
            { text: 'Providers', link: '/guide/providers' },
            { text: 'Model Hub', link: '/guide/model-hub' },
            { text: 'Model Inference', link: '/guide/inference' },
            { text: 'Vector Stores', link: '/guide/vector-stores' },
            { text: 'Reranker', link: '/guide/reranker' },
            { text: 'Web Search', link: '/guide/websearch' },
            { text: 'Agent Tracing', link: '/guide/tracing' },
            { text: 'Guardrails', link: '/guide/guardrails' },
            { text: 'PII Service', link: '/guide/pii' },
            { text: 'Evaluation & Analysis', link: '/guide/evaluation-and-analysis' },
            { text: 'Cost & Optimization', link: '/guide/cost-optimization' },
            { text: 'Knowledge Engine', link: '/guide/rag' },
            { text: 'Prompts', link: '/guide/prompts' },
            { text: 'Memory', link: '/guide/memory' },
            { text: 'File Storage', link: '/guide/files' },
            { text: 'Agent Sandbox', link: '/guide/sandbox' },
            { text: 'Browser Automation', link: '/guide/browser' },
          ],
        },
        {
          text: 'Observability Integrations',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/guide/observability/overview' },
            { text: 'Quickstart', link: '/guide/observability/quickstart' },
            { text: 'LangChain', link: '/guide/observability/langchain' },
            { text: 'LangGraph', link: '/guide/observability/langgraph' },
            { text: 'OpenAI Agents SDK', link: '/guide/observability/openai-agents' },
            { text: 'Claude Agent SDK', link: '/guide/observability/claude-agent-sdk' },
            { text: 'Vercel AI SDK', link: '/guide/observability/vercel-ai' },
            { text: 'n8n', link: '/guide/observability/n8n' },
            { text: 'OpenTelemetry', link: '/guide/observability/opentelemetry' },
            { text: 'Manual Instrumentation', link: '/guide/observability/manual' },
            { text: 'Data Model', link: '/guide/observability/data-model' },
            { text: 'Troubleshooting', link: '/guide/observability/troubleshooting' },
          ],
        },
        {
          text: 'Operations',
          items: [
            { text: 'Deployment', link: '/guide/deployment' },
            { text: 'Cluster', link: '/guide/cluster' },
            { text: 'Monitoring', link: '/guide/monitoring' },
            { text: 'Releasing', link: '/guide/releasing' },
            { text: 'Smoke Testing', link: '/guide/smoke-testing' },
            { text: 'E2E & Load Testing', link: '/guide/e2e-testing' },
          ],
        },
        {
          text: 'GPU Fleet',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/guide/gpu-fleet/overview' },
            { text: 'Onboarding Hosts', link: '/guide/gpu-fleet/onboarding' },
            { text: 'Deploying Models', link: '/guide/gpu-fleet/deploying-models' },
            { text: 'Pools & Load Balancing', link: '/guide/gpu-fleet/pools' },
            { text: 'MIG Reconfigure', link: '/guide/gpu-fleet/mig' },
            { text: 'Terminal Access', link: '/guide/gpu-fleet/terminal' },
            { text: 'Troubleshooting', link: '/guide/gpu-fleet/troubleshooting' },
            { text: 'FAQ', link: '/guide/gpu-fleet/faq' },
          ],
        },
        {
          text: 'Project',
          items: [
            { text: 'Licensing', link: '/guide/licensing' },
            { text: 'Security', link: '/guide/security' },
            { text: 'Contributing', link: '/contributing' },
          ],
        },
      ],

      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Overview', link: '/api/overview' },
            { text: 'OpenAPI Spec', link: '/api/openapi' },
            { text: 'Chat Completions', link: '/api/chat-completions' },
            { text: 'Embeddings', link: '/api/embeddings' },
            { text: 'Moderations', link: '/api/moderations' },
            { text: 'Audio', link: '/api/audio' },
            { text: 'OCR', link: '/api/ocr' },
            { text: 'Batches', link: '/api/batch' },
            { text: 'Spend & Budgets', link: '/api/spend' },
            { text: 'Cost & Prescriptions', link: '/api/cost' },
            { text: 'Automations', link: '/api/automations' },
            { text: 'Crawler', link: '/api/crawler' },
            { text: 'Web Search', link: '/api/websearch' },
            { text: 'Red Team', link: '/api/redteam' },
            { text: 'Agents', link: '/api/agents' },
            { text: 'Browser', link: '/api/browser' },
            { text: 'Tools', link: '/api/tools' },
            { text: 'MCP Servers', link: '/api/mcp' },
            { text: 'Vector', link: '/api/vector' },
            { text: 'Reranker', link: '/api/reranker' },
            { text: 'Tracing', link: '/api/tracing' },
            { text: 'Files', link: '/api/files' },
            { text: 'Guardrails', link: '/api/guardrails' },
            { text: 'PII', link: '/api/pii' },
            { text: 'Evaluation', link: '/api/evaluation' },
            { text: 'Analysis', link: '/api/analysis' },
            { text: 'Prompts', link: '/api/prompts' },
            { text: 'Knowledge Engine', link: '/api/rag' },
            { text: 'Memory', link: '/api/memory' },
            { text: 'Config', link: '/api/config' },
            { text: 'Cluster', link: '/api/cluster' },
            { text: 'Incidents', link: '/api/incidents' },
            { text: 'Health', link: '/api/health' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/Cognipeer/cognipeer-console' },
    ],

    footer: {
      message: 'Community edition is AGPL-3.0. Commercial licensing and support are available separately.',
      copyright: 'Copyright © 2026 Cognipeer',
    },

    search: {
      provider: 'local',
    },
  },

  head: [
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Lexend+Deca:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap',
      },
    ],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${docsBase}Console.svg` }],
    ['meta', { name: 'theme-color', content: '#0fba94' }],
    ['meta', { name: 'og:type', content: 'website' }],
    ['meta', { name: 'og:locale', content: 'en' }],
    ['meta', { name: 'og:site_name', content: 'Cognipeer Console Documentation' }],
  ],
});
