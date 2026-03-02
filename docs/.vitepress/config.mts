import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Cognipeer Gateway',
  description:
    'Multi-tenant AI gateway for LLM inference, vector stores, agent tracing, RAG, and more',
  base: '/cgate/',
  ignoreDeadLinks: true,

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Core Modules', link: '/guide/core-overview' },
      { text: 'API Reference', link: '/api/overview' },
      {
        text: 'v0.1.0',
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: 'Contributing', link: '/contributing' },
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
      ],

      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Overview', link: '/api/overview' },
            { text: 'Chat Completions', link: '/api/chat-completions' },
            { text: 'Embeddings', link: '/api/embeddings' },
            { text: 'Vector', link: '/api/vector' },
            { text: 'Tracing', link: '/api/tracing' },
            { text: 'Files', link: '/api/files' },
            { text: 'Guardrails', link: '/api/guardrails' },
            { text: 'Prompts', link: '/api/prompts' },
            { text: 'RAG', link: '/api/rag' },
            { text: 'Memory', link: '/api/memory' },
            { text: 'Config', link: '/api/config' },
            { text: 'Health', link: '/api/health' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/Cognipeer/cgate' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025-2026 CognipeerAI',
    },

    search: {
      provider: 'local',
    },
  },

  head: [
    ['meta', { name: 'theme-color', content: '#3eaf7c' }],
    ['meta', { name: 'og:type', content: 'website' }],
    ['meta', { name: 'og:locale', content: 'en' }],
    ['meta', { name: 'og:site_name', content: 'Cognipeer Gateway Docs' }],
  ],
});
