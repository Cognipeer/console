import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Cognipeer Console',
  description:
    'Multi-tenant AI platform for LLM inference, vector stores, agent tracing, RAG, and more.',
  base: '/cognipeer-console/',
  ignoreDeadLinks: true,
  appearance: false,

  themeConfig: {
    logo: '/Console.svg',
    siteTitle: 'Cognipeer Console',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
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
      '/guide/': [
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
            { text: 'Providers', link: '/guide/providers' },
            { text: 'Model Inference', link: '/guide/inference' },
            { text: 'Vector Stores', link: '/guide/vector-stores' },
            { text: 'Agent Tracing', link: '/guide/tracing' },
            { text: 'Guardrails', link: '/guide/guardrails' },
            { text: 'RAG', link: '/guide/rag' },
            { text: 'Prompts', link: '/guide/prompts' },
            { text: 'Memory', link: '/guide/memory' },
            { text: 'File Storage', link: '/guide/files' },
          ],
        },
        {
          text: 'Operations',
          items: [
            { text: 'Deployment', link: '/guide/deployment' },
            { text: 'Monitoring', link: '/guide/monitoring' },
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
            { text: 'Chat Completions', link: '/api/chat-completions' },
            { text: 'Embeddings', link: '/api/embeddings' },
            { text: 'Agents', link: '/api/agents' },
            { text: 'Tools', link: '/api/tools' },
            { text: 'MCP Servers', link: '/api/mcp' },
            { text: 'Vector', link: '/api/vector' },
            { text: 'Tracing', link: '/api/tracing' },
            { text: 'Files', link: '/api/files' },
            { text: 'Guardrails', link: '/api/guardrails' },
            { text: 'Prompts', link: '/api/prompts' },
            { text: 'RAG', link: '/api/rag' },
            { text: 'Memory', link: '/api/memory' },
            { text: 'Config', link: '/api/config' },
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
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Lexend+Deca:wght@400;500;600;700;800&display=swap' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/cognipeer-console/Console.svg' }],
    ['meta', { name: 'theme-color', content: '#00b5a5' }],
    ['meta', { name: 'og:type', content: 'website' }],
    ['meta', { name: 'og:locale', content: 'en' }],
    ['meta', { name: 'og:site_name', content: 'Cognipeer Console Documentation' }],
  ],
});
