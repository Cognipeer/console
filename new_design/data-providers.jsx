/* global React */
// Provider catalog — many types of providers

const PROVIDER_TYPES = [
  { id: 'llm',       label: 'LLM',           icon: 'brain',    desc: 'Large language model providers' },
  { id: 'embedding', label: 'Embedding',     icon: 'vector',   desc: 'Text embedding endpoints' },
  { id: 'vectordb',  label: 'Vector DB',     icon: 'database', desc: 'Vector index storage' },
  { id: 'storage',   label: 'Object storage',icon: 'folder',   desc: 'S3-compatible blob storage' },
  { id: 'obs',       label: 'Observability', icon: 'graph',    desc: 'Tracing and metrics destinations' },
  { id: 'auth',      label: 'Identity',      icon: 'lock',     desc: 'SSO and identity providers' },
];

// Catalog of available providers to ADD (each has a logo glyph, name, type, fields)
const PROVIDER_CATALOG = [
  // LLM
  { id: 'openai',     name: 'OpenAI',     type: 'llm', glyph: 'O', color: '#10a37f', desc: 'GPT-4, GPT-4o, o1, o3, embeddings, TTS, Whisper.', region: 'global', verified: true },
  { id: 'anthropic',  name: 'Anthropic',  type: 'llm', glyph: 'A', color: '#cc7d4f', desc: 'Claude Opus, Sonnet, Haiku — 200k context.', region: 'global', verified: true },
  { id: 'google',     name: 'Google AI',  type: 'llm', glyph: 'G', color: '#ea4335', desc: 'Gemini 2.0 Flash, Pro — 1M context window.', region: 'global', verified: true },
  { id: 'azureopenai',name: 'Azure OpenAI',type: 'llm', glyph: 'Az',color: '#0078d4', desc: 'OpenAI models on Microsoft Azure tenancy.', region: 'multi', verified: true },
  { id: 'bedrock',    name: 'AWS Bedrock',type: 'llm', glyph: 'B', color: '#ff9900', desc: 'Multi-vendor models on AWS with private VPC.', region: 'multi', verified: true },
  { id: 'cohere',     name: 'Cohere',     type: 'llm', glyph: 'C', color: '#d18ee2', desc: 'Command R+, multilingual + retrieval-tuned.', region: 'global' },
  { id: 'mistral',    name: 'Mistral',    type: 'llm', glyph: 'M', color: '#fa6f0c', desc: 'Mistral Large, Codestral, open-weight models.', region: 'eu' },
  { id: 'groq',       name: 'Groq',       type: 'llm', glyph: 'gQ',color: '#f55036', desc: 'Ultra-fast inference on LPU hardware.', region: 'us' },
  { id: 'together',   name: 'Together AI',type: 'llm', glyph: 'T', color: '#0f6fff', desc: '200+ open-source models on dedicated GPUs.', region: 'us' },
  { id: 'fireworks',  name: 'Fireworks',  type: 'llm', glyph: 'Fw',color: '#5d3fd3', desc: 'Open-source LLM hosting at low cost.', region: 'us' },
  { id: 'self-llm',   name: 'Self-hosted (vLLM)',type: 'llm',glyph: 'vL',color: '#7c3aed', desc: 'Bring your own vLLM or TGI endpoint.', region: 'self' },
  { id: 'cgnp-llm',   name: 'Cognipeer Cloud',type: 'llm',glyph: 'Cp',color: '#16b3ab', desc: 'Cognipeer-managed model hosting.', region: 'multi', verified: true },

  // Embedding
  { id: 'oai-embed',  name: 'OpenAI Embeddings',  type: 'embedding', glyph: 'O',  color: '#10a37f', desc: 'text-embedding-3-small / large.', verified: true },
  { id: 'voyage',     name: 'Voyage AI',          type: 'embedding', glyph: 'V',  color: '#3b82f6', desc: 'voyage-3-large, code embeddings.' },
  { id: 'cohere-embed',name:'Cohere Embed',       type: 'embedding', glyph: 'C',  color: '#d18ee2', desc: 'Multilingual embeddings v3.' },
  { id: 'jina',       name: 'Jina AI',            type: 'embedding', glyph: 'J',  color: '#fb7185', desc: 'jina-embeddings-v3 with reranker.' },
  { id: 'cgnp-embed', name: 'Cognipeer Embed',    type: 'embedding', glyph: 'Cp', color: '#16b3ab', desc: 'cgnp-embed-v3 — optimized for RAG.', verified: true },

  // Vector DB
  { id: 'pinecone',   name: 'Pinecone',           type: 'vectordb',  glyph: 'Pn', color: '#000000', desc: 'Managed vector index with hybrid search.', verified: true },
  { id: 'weaviate',   name: 'Weaviate',           type: 'vectordb',  glyph: 'W',  color: '#22c55e', desc: 'Open-source vector + graph database.' },
  { id: 'qdrant',     name: 'Qdrant',             type: 'vectordb',  glyph: 'Q',  color: '#ef4444', desc: 'Self-hostable, payload filtering.', verified: true },
  { id: 'milvus',     name: 'Milvus',             type: 'vectordb',  glyph: 'Mv', color: '#06b6d4', desc: 'Distributed vector DB on Kubernetes.' },
  { id: 'pgvector',   name: 'pgvector',           type: 'vectordb',  glyph: 'Pg', color: '#336791', desc: 'PostgreSQL extension for vectors.' },
  { id: 'chroma',     name: 'Chroma',             type: 'vectordb',  glyph: 'Ch', color: '#f97316', desc: 'Embedded vector store for prototyping.' },

  // Storage
  { id: 's3',         name: 'Amazon S3',          type: 'storage',   glyph: 'S3', color: '#ff9900', desc: 'Object storage on AWS.', verified: true },
  { id: 'gcs',        name: 'Google Cloud Storage', type: 'storage', glyph: 'GC', color: '#4285f4', desc: 'Object storage on GCP.' },
  { id: 'azure-blob', name: 'Azure Blob',         type: 'storage',   glyph: 'Az', color: '#0078d4', desc: 'Blob storage on Microsoft Azure.' },
  { id: 'r2',         name: 'Cloudflare R2',      type: 'storage',   glyph: 'R2', color: '#f38020', desc: 'Zero-egress S3-compatible storage.' },
  { id: 'minio',      name: 'MinIO',              type: 'storage',   glyph: 'Mi', color: '#c72e29', desc: 'Self-hosted S3-compatible storage.' },

  // Observability
  { id: 'langfuse',   name: 'Langfuse',           type: 'obs',       glyph: 'Lf', color: '#000000', desc: 'Open-source LLM observability.', verified: true },
  { id: 'datadog',    name: 'Datadog',            type: 'obs',       glyph: 'DD', color: '#632ca6', desc: 'Forward traces and metrics to Datadog.' },
  { id: 'arize',      name: 'Arize',              type: 'obs',       glyph: 'Az', color: '#16b3ab', desc: 'LLM evaluation + drift monitoring.' },
  { id: 'helicone',   name: 'Helicone',           type: 'obs',       glyph: 'He', color: '#f97316', desc: 'Drop-in proxy for logging.' },
  { id: 'sentry',     name: 'Sentry',             type: 'obs',       glyph: 'Sn', color: '#362d59', desc: 'Error tracking + performance.' },

  // Identity
  { id: 'okta',       name: 'Okta',               type: 'auth',      glyph: 'Ok', color: '#007dc1', desc: 'SAML/OIDC enterprise SSO.', verified: true },
  { id: 'azure-ad',   name: 'Microsoft Entra',    type: 'auth',      glyph: 'En', color: '#0078d4', desc: 'Azure AD / Entra ID identity.', verified: true },
  { id: 'auth0',      name: 'Auth0',              type: 'auth',      glyph: 'A0', color: '#eb5424', desc: 'OAuth2 + social login.' },
  { id: 'google-wks', name: 'Google Workspace',   type: 'auth',      glyph: 'Gw', color: '#ea4335', desc: 'Google SSO for workspaces.' },
];

// Already-configured providers (instances) in this workspace
const CONFIGURED_PROVIDERS = [
  { id: 'p1', catalogId: 'openai',     name: 'OpenAI · production',     type: 'llm', status: 'connected',   models: 12, usage24h: '$184.20', region: 'us-east-1', createdBy: 'Deniz K.', createdAt: '3 months ago', latency: 286 },
  { id: 'p2', catalogId: 'openai',     name: 'OpenAI · staging',        type: 'llm', status: 'connected',   models: 4,  usage24h: '$12.40',  region: 'us-east-1', createdBy: 'Deniz K.', createdAt: '3 months ago', latency: 312 },
  { id: 'p3', catalogId: 'anthropic',  name: 'Anthropic · production',  type: 'llm', status: 'connected',   models: 4,  usage24h: '$96.40',  region: 'us-west-2', createdBy: 'Aylin Ö.', createdAt: '2 months ago', latency: 421 },
  { id: 'p4', catalogId: 'cgnp-llm',   name: 'Cognipeer Cloud',         type: 'llm', status: 'connected',   models: 8,  usage24h: '$48.40',  region: 'eu-west',   createdBy: 'system',    createdAt: '6 months ago', latency: 184 },
  { id: 'p5', catalogId: 'azureopenai',name: 'Azure OpenAI · EU',       type: 'llm', status: 'degraded',    models: 3,  usage24h: '$8.40',   region: 'eu-west',   createdBy: 'Mert Y.',   createdAt: '1 month ago',  latency: 642 },
  { id: 'p6', catalogId: 'bedrock',    name: 'AWS Bedrock',             type: 'llm', status: 'connected',   models: 6,  usage24h: '$28.40',  region: 'us-east-1', createdBy: 'Deniz K.', createdAt: '6 weeks ago',  latency: 392 },
  { id: 'p7', catalogId: 'self-llm',   name: 'Self-hosted (Llama)',     type: 'llm', status: 'connected',   models: 2,  usage24h: '—',        region: 'self',      createdBy: 'Mert Y.',   createdAt: '4 weeks ago',  latency: 891 },

  { id: 'p10', catalogId: 'cgnp-embed', name: 'Cognipeer Embed',         type: 'embedding', status: 'connected', models: 1, usage24h: '$84.20', region: 'eu-west',  createdBy: 'system',  createdAt: '6 months ago', latency: 42 },
  { id: 'p11', catalogId: 'oai-embed',  name: 'OpenAI Embeddings',       type: 'embedding', status: 'connected', models: 2, usage24h: '$18.40', region: 'us-east-1',createdBy: 'Aylin Ö.', createdAt: '2 months ago', latency: 68 },

  { id: 'p20', catalogId: 'pinecone',   name: 'Pinecone · production',   type: 'vectordb', status: 'connected', models: 3, usage24h: '$8.10', region: 'us-east-1', createdBy: 'Deniz K.', createdAt: '3 months ago', latency: 12 },
  { id: 'p21', catalogId: 'qdrant',     name: 'Qdrant · self-hosted',    type: 'vectordb', status: 'connected', models: 4, usage24h: '—',     region: 'self',      createdBy: 'Mert Y.', createdAt: '2 months ago', latency: 8 },
  { id: 'p22', catalogId: 'pgvector',   name: 'pgvector · primary db',   type: 'vectordb', status: 'error',     models: 1, usage24h: '—',     region: 'self',      createdBy: 'Deniz K.', createdAt: '1 month ago',  latency: 0 },

  { id: 'p30', catalogId: 's3',         name: 'AWS S3 · documents',      type: 'storage', status: 'connected', models: 0, usage24h: '482 GB',region: 'us-east-1', createdBy: 'Aylin Ö.', createdAt: '5 months ago', latency: 0 },
  { id: 'p31', catalogId: 'r2',         name: 'Cloudflare R2 · cache',   type: 'storage', status: 'connected', models: 0, usage24h: '12 GB', region: 'global',    createdBy: 'Deniz K.', createdAt: '2 months ago', latency: 0 },

  { id: 'p40', catalogId: 'langfuse',   name: 'Langfuse · self-hosted',  type: 'obs',     status: 'connected', models: 0, usage24h: '1.18M events', region: 'self', createdBy: 'Mert Y.', createdAt: '4 months ago', latency: 0 },
  { id: 'p41', catalogId: 'datadog',    name: 'Datadog · APM',           type: 'obs',     status: 'paused',    models: 0, usage24h: '—',     region: 'us-east-1', createdBy: 'Ece T.',  createdAt: '6 weeks ago',  latency: 0 },

  { id: 'p50', catalogId: 'okta',       name: 'Okta · cognipeer.io',     type: 'auth',    status: 'connected', models: 0, usage24h: '184 logins', region: 'global', createdBy: 'Deniz K.', createdAt: '8 months ago', latency: 0 },
];

Object.assign(window, { PROVIDER_TYPES, PROVIDER_CATALOG, CONFIGURED_PROVIDERS });
