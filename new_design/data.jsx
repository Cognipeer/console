/* global React, Icon */
// Data — realistic-looking mock data for the prototype

const PROVIDERS = [
  { id: 'openai',    name: 'OpenAI',    color: '#10a37f' },
  { id: 'anthropic', name: 'Anthropic', color: '#cc7d4f' },
  { id: 'cognipeer', name: 'Cognipeer Cloud', color: '#16b3ab' },
  { id: 'azure',     name: 'Azure AI',  color: '#0078d4' },
  { id: 'self',      name: 'Self-hosted',color: '#7c3aed' },
  { id: 'google',    name: 'Google',    color: '#ea4335' },
];

const MODELS = [
  { id: 'cgnp-pro-1', name: 'cognipeer-pro', version: '1.4', provider: 'cognipeer', context: '128k', status: 'active',  calls: 184230, p95: 412, cost: 1842.30, type: 'chat', tags: ['production', 'public'] },
  { id: 'gpt4-mini',  name: 'gpt-4.1-mini',  version: '2025-04-14', provider: 'openai',  context: '1M',  status: 'active',  calls: 92410,  p95: 286, cost: 612.40,  type: 'chat', tags: ['production'] },
  { id: 'claude-s',   name: 'claude-sonnet-4.5', version: '20250912', provider: 'anthropic', context: '200k', status: 'active', calls: 71402, p95: 521, cost: 1284.10, type: 'chat', tags: ['production'] },
  { id: 'cgnp-emb',   name: 'cgnp-embed-v3', version: '3.0', provider: 'cognipeer', context: '8k', status: 'active', calls: 412800, p95: 42,  cost: 84.20, type: 'embedding', tags: ['production'] },
  { id: 'gpt4o',      name: 'gpt-4o',        version: '2024-11-20', provider: 'openai', context: '128k', status: 'active', calls: 38104, p95: 318, cost: 980.50, type: 'chat', tags: [] },
  { id: 'llama-70',   name: 'llama-3.3-70b', version: 'instruct', provider: 'self', context: '32k', status: 'degraded', calls: 12940, p95: 891, cost: 0, type: 'chat', tags: ['self-hosted'] },
  { id: 'mistral-l',  name: 'mistral-large', version: '2407', provider: 'azure', context: '32k', status: 'active', calls: 8421, p95: 462, cost: 142.80, type: 'chat', tags: [] },
  { id: 'haiku-3.5',  name: 'claude-haiku-3.5', version: '20241022', provider: 'anthropic', context: '200k', status: 'active', calls: 56210, p95: 198, cost: 184.20, type: 'chat', tags: ['production'] },
  { id: 'gpt4o-tts',  name: 'gpt-4o-mini-tts', version: '2024-12', provider: 'openai', context: '—', status: 'active', calls: 1240, p95: 1820, cost: 28.40, type: 'audio', tags: [] },
  { id: 'cgnp-rerank',name: 'cgnp-rerank-v2', version: '2.1', provider: 'cognipeer', context: '4k', status: 'active', calls: 184201, p95: 38, cost: 38.40, type: 'rerank', tags: ['production'] },
  { id: 'gemini-pro', name: 'gemini-2.0-flash',version: '2025-02-05', provider: 'google', context: '1M', status: 'paused', calls: 4210, p95: 412, cost: 18.20, type: 'chat', tags: [] },
  { id: 'whisper-l',  name: 'whisper-large-v3',version: '3', provider: 'self', context: '—', status: 'active', calls: 8420, p95: 1240, cost: 0, type: 'audio', tags: ['self-hosted'] },
];

const RECENT_RESOURCES = [
  { id: 'agent-support', type: 'agent',  name: 'customer-support-v2', meta: '2 hours ago' },
  { id: 'cgnp-pro-1',    type: 'model',  name: 'cognipeer-pro 1.4',   meta: 'yesterday' },
  { id: 'rag-kb',        type: 'rag',    name: 'product-docs-kb',     meta: 'yesterday' },
  { id: 'prompt-cls',    type: 'prompt', name: 'intent-classifier',   meta: '3 days ago' },
  { id: 'tool-zen',      type: 'tool',   name: 'zendesk-ticket-tool', meta: '5 days ago' },
];

const ALERTS = [
  { id: 'a1', sev: 'err',  title: 'llama-3.3-70b p95 latency above SLO',      time: '12 min ago' },
  { id: 'a2', sev: 'warn', title: 'Token budget at 78% for project orion',    time: '1 hour ago' },
  { id: 'a3', sev: 'warn', title: 'Vector index rebuild pending (kb-prod)',   time: '3 hours ago' },
];

const ACTIVITY = [
  { id: 'e1', who: 'Deniz K.',  action: 'deployed', target: 'cognipeer-pro 1.4', time: '8m' },
  { id: 'e2', who: 'system',    action: 'rotated',  target: 'sk-cgnp-prod-***42', time: '34m' },
  { id: 'e3', who: 'Aylin Ö.',  action: 'published', target: 'prompt: refund-assistant v7', time: '1h' },
  { id: 'e4', who: 'Mert Y.',   action: 'created',  target: 'agent: ops-runbook', time: '2h' },
  { id: 'e5', who: 'system',    action: 'rebuilt',  target: 'index: kb-prod', time: '4h' },
  { id: 'e6', who: 'Ece T.',    action: 'updated',  target: 'guardrail: pii-redactor', time: '6h' },
];

Object.assign(window, { PROVIDERS, MODELS, RECENT_RESOURCES, ALERTS, ACTIVITY });
