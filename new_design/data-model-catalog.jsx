/* global React */
// Catalog of MODELS available to deploy (from each provider)

const MODEL_CATALOG = [
  // OpenAI
  { id: 'oai-gpt-5',        provider: 'openai',     name: 'gpt-5',                  type: 'chat',       context: '256k', maxOut: '32k', modalities: ['text', 'vision'], pricing: { in: 2.50, out: 10.00 }, releaseDate: '2025-08-12', popular: true },
  { id: 'oai-gpt-4o',       provider: 'openai',     name: 'gpt-4o',                 type: 'chat',       context: '128k', maxOut: '16k', modalities: ['text', 'vision'], pricing: { in: 2.50, out: 10.00 }, releaseDate: '2024-11-20', popular: true },
  { id: 'oai-gpt-41-mini',  provider: 'openai',     name: 'gpt-4.1-mini',           type: 'chat',       context: '1M',   maxOut: '32k', modalities: ['text'],            pricing: { in: 0.40, out: 1.60 },  releaseDate: '2025-04-14', popular: true },
  { id: 'oai-o3',           provider: 'openai',     name: 'o3',                     type: 'chat',       context: '200k', maxOut: '100k',modalities: ['text', 'vision'], pricing: { in: 10.00,out: 40.00 }, releaseDate: '2025-04-16' },
  { id: 'oai-o3-mini',      provider: 'openai',     name: 'o3-mini',                type: 'chat',       context: '200k', maxOut: '100k',modalities: ['text'],            pricing: { in: 1.10, out: 4.40 },  releaseDate: '2025-01-31' },
  { id: 'oai-emb-3-large',  provider: 'openai',     name: 'text-embedding-3-large', type: 'embedding',  context: '8k',   maxOut: '—',   modalities: ['text'],            pricing: { in: 0.13, out: 0    },  releaseDate: '2024-01-25' },
  { id: 'oai-tts',          provider: 'openai',     name: 'gpt-4o-mini-tts',        type: 'audio',      context: '—',    maxOut: '—',   modalities: ['audio'],           pricing: { in: 0.60, out: 12.00 }, releaseDate: '2024-12-01' },
  { id: 'oai-whisper',      provider: 'openai',     name: 'whisper-large-v3',       type: 'audio',      context: '—',    maxOut: '—',   modalities: ['audio'],           pricing: { in: 0.36, out: 0    },  releaseDate: '2024-06-10' },

  // Anthropic
  { id: 'ant-opus-4',       provider: 'anthropic',  name: 'claude-opus-4',          type: 'chat',       context: '500k', maxOut: '32k', modalities: ['text', 'vision'], pricing: { in: 15.00,out: 75.00 }, releaseDate: '2025-09-08', popular: true },
  { id: 'ant-sonnet-45',    provider: 'anthropic',  name: 'claude-sonnet-4.5',      type: 'chat',       context: '200k', maxOut: '32k', modalities: ['text', 'vision'], pricing: { in: 3.00, out: 15.00 }, releaseDate: '2025-09-12', popular: true },
  { id: 'ant-haiku-35',     provider: 'anthropic',  name: 'claude-haiku-3.5',       type: 'chat',       context: '200k', maxOut: '8k',  modalities: ['text'],            pricing: { in: 0.80, out: 4.00 },  releaseDate: '2024-10-22', popular: true },

  // Cognipeer
  { id: 'cgnp-pro-1',       provider: 'cgnp-llm',   name: 'cognipeer-pro',          type: 'chat',       context: '128k', maxOut: '16k', modalities: ['text', 'vision'], pricing: { in: 1.20, out: 4.80 },  releaseDate: '2025-11-04', popular: true },
  { id: 'cgnp-fast-1',      provider: 'cgnp-llm',   name: 'cognipeer-fast',         type: 'chat',       context: '64k',  maxOut: '8k',  modalities: ['text'],            pricing: { in: 0.30, out: 1.20 },  releaseDate: '2025-09-22' },
  { id: 'cgnp-embed-3',     provider: 'cgnp-embed', name: 'cgnp-embed-v3',          type: 'embedding',  context: '8k',   maxOut: '—',   modalities: ['text'],            pricing: { in: 0.08, out: 0    },  releaseDate: '2025-10-14' },
  { id: 'cgnp-rerank-2',    provider: 'cgnp-embed', name: 'cgnp-rerank-v2',         type: 'rerank',     context: '4k',   maxOut: '—',   modalities: ['text'],            pricing: { in: 0.06, out: 0    },  releaseDate: '2025-08-04' },

  // Google
  { id: 'gem-25-pro',       provider: 'google',     name: 'gemini-2.5-pro',         type: 'chat',       context: '2M',   maxOut: '64k', modalities: ['text', 'vision', 'audio'], pricing: { in: 1.25, out: 10.00 }, releaseDate: '2025-06-12' },
  { id: 'gem-20-flash',     provider: 'google',     name: 'gemini-2.0-flash',       type: 'chat',       context: '1M',   maxOut: '8k',  modalities: ['text', 'vision'],   pricing: { in: 0.10, out: 0.40 },  releaseDate: '2025-02-05' },

  // Azure OpenAI
  { id: 'azoai-gpt-4o',     provider: 'azureopenai',name: 'gpt-4o (Azure)',         type: 'chat',       context: '128k', maxOut: '16k', modalities: ['text', 'vision'], pricing: { in: 2.50, out: 10.00 }, releaseDate: '2024-11-20' },

  // AWS Bedrock
  { id: 'bed-claude-37',    provider: 'bedrock',    name: 'anthropic.claude-3.7',   type: 'chat',       context: '200k', maxOut: '8k',  modalities: ['text', 'vision'], pricing: { in: 3.00, out: 15.00 }, releaseDate: '2025-02-24' },
  { id: 'bed-llama-33',     provider: 'bedrock',    name: 'meta.llama3-3-70b',      type: 'chat',       context: '128k', maxOut: '4k',  modalities: ['text'],            pricing: { in: 0.72, out: 0.72 },  releaseDate: '2024-12-10' },

  // Mistral
  { id: 'mistral-large-2',  provider: 'mistral',    name: 'mistral-large-2411',     type: 'chat',       context: '128k', maxOut: '8k',  modalities: ['text'],            pricing: { in: 2.00, out: 6.00 },  releaseDate: '2024-11-18' },
  { id: 'codestral',        provider: 'mistral',    name: 'codestral-2501',         type: 'chat',       context: '256k', maxOut: '8k',  modalities: ['text'],            pricing: { in: 0.30, out: 0.90 },  releaseDate: '2025-01-13' },

  // Groq
  { id: 'groq-llama-70',    provider: 'groq',       name: 'llama-3.3-70b',          type: 'chat',       context: '128k', maxOut: '8k',  modalities: ['text'],            pricing: { in: 0.59, out: 0.79 },  releaseDate: '2024-12-06' },

  // Self-hosted
  { id: 'self-llama-70',    provider: 'self-llm',   name: 'llama-3.3-70b-instruct', type: 'chat',       context: '32k',  maxOut: '4k',  modalities: ['text'],            pricing: { in: 0, out: 0 },        releaseDate: 'custom' },
];

Object.assign(window, { MODEL_CATALOG });
