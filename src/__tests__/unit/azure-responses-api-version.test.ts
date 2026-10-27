/**
 * Unit tests — an Azure model on the Responses upstream API is called with an api-version that has the route
 *
 * The agent-sdk calls `/openai/responses?api-version=<version>` with the provider's version, and Azure serves the
 * Responses API only from `2025-03-01-preview` (reasoning summaries from `2025-04-01-preview`). A resource set up for
 * Chat Completions and embeddings with `2024-10-21` has no such route, so a model whose Upstream API is Responses now
 * gets `2025-04-01-preview` unless the model names a version itself (`azureApiVersion`) or the provider's own already
 * has the route. Chat Completions keeps the provider's version, whatever it is.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzureModelProviderContract } from '@/lib/providers/contracts/modelContracts';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import { completion, json, stubUpstream } from '../helpers/nativeGateway';

afterEach(() => vi.unstubAllGlobals());

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function azureRuntime(apiVersion: string): ModelProviderRuntime {
  return AzureModelProviderContract.createRuntime({
    tenantId: 't',
    projectId: 'p',
    providerKey: 'prov',
    credentials: { apiKey: 'az-key' },
    settings: { instanceName: 'res', deploymentName: 'fallback-dep', apiVersion },
    metadata: {},
    logger,
  } as never) as unknown as ModelProviderRuntime;
}

/** The api-version the Azure provider is built with for a model of these settings, on a provider set up with `providerVersion`. */
function versionFor(providerVersion: string, modelSettings: Record<string, unknown> = {}) {
  const spec = azureRuntime(providerVersion).createNativeProviderSpec!({ modelId: 'gpt-5-prod', category: 'llm', modelSettings });
  return (spec.provider as { apiVersion?: string }).apiVersion;
}

describe('the api-version of an Azure model', () => {
  it.each(['2024-10-21', '2024-08-01-preview', '2024-12-01-preview', '2025-03-01-preview', 'preview'])(
    'is the provider\'s own on Chat Completions (%s), by default and when chosen',
    (providerVersion) => {
      expect(versionFor(providerVersion)).toBe(providerVersion);
      expect(versionFor(providerVersion, { upstreamApi: 'chat' })).toBe(providerVersion);
      expect(versionFor(providerVersion, { upstreamApi: 'banana' })).toBe(providerVersion);
    },
  );

  it.each(['2024-10-21', '2024-08-01-preview', '2024-12-01-preview', '2023-05-15', '2025-02-28'])(
    'is 2025-04-01-preview on the Responses API when the provider\'s (%s) predates it',
    (providerVersion) => {
      expect(versionFor(providerVersion, { upstreamApi: 'responses' })).toBe('2025-04-01-preview');
      // The setting is read like everywhere else: any case.
      expect(versionFor(providerVersion, { upstreamApi: 'Responses' })).toBe('2025-04-01-preview');
    },
  );

  it.each(['2025-03-01-preview', '2025-04-01-preview', '2025-06-01', '2025-10-01-preview'])(
    'is the provider\'s own on the Responses API when it already has the route (%s)',
    (providerVersion) => {
      expect(versionFor(providerVersion, { upstreamApi: 'responses' })).toBe(providerVersion);
    },
  );

  it.each(['preview', 'latest', 'v1'])(
    'is left alone on the Responses API when the provider\'s (%s) carries no date to compare',
    (providerVersion) => {
      expect(versionFor(providerVersion, { upstreamApi: 'responses' })).toBe(providerVersion);
    },
  );

  it('is the one the model names itself (azureApiVersion), on either API', () => {
    expect(versionFor('2024-10-21', { upstreamApi: 'responses', azureApiVersion: '2024-10-21' })).toBe('2024-10-21');
    expect(versionFor('2024-10-21', { upstreamApi: 'responses', azureApiVersion: '2025-06-01-preview' })).toBe('2025-06-01-preview');
    expect(versionFor('2024-10-21', { azureApiVersion: '2025-04-01-preview' })).toBe('2025-04-01-preview');
    expect(versionFor('2025-04-01-preview', { azureApiVersion: '2024-10-21' })).toBe('2024-10-21');
  });

  it('ignores a blank azureApiVersion and trims a padded one', () => {
    expect(versionFor('2024-10-21', { upstreamApi: 'responses', azureApiVersion: '   ' })).toBe('2025-04-01-preview');
    expect(versionFor('2024-10-21', { azureApiVersion: '' })).toBe('2024-10-21');
    expect(versionFor('2024-10-21', { upstreamApi: 'responses', azureApiVersion: ' 2025-06-01-preview ' })).toBe('2025-06-01-preview');
  });

  it('keeps the rest of the provider spec: the deployment, and the API the SDK is told to call', () => {
    const spec = azureRuntime('2024-10-21').createNativeProviderSpec!({
      modelId: 'gpt-5-prod',
      category: 'llm',
      modelSettings: { upstreamApi: 'responses' },
    });
    expect(spec.provider).toMatchObject({
      provider: 'azure',
      endpoint: 'https://res.openai.azure.com',
      deploymentName: 'gpt-5-prod',
      apiVersion: '2025-04-01-preview',
      api: 'responses',
    });
  });
});

describe('an Azure model on the wire', () => {
  const ASK = [{ role: 'user' as const, content: 'hi' }];
  const responsesAnswer = () => json({
    id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-5',
    output: [
      { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
    ],
    usage: { input_tokens: 5, output_tokens: 20, total_tokens: 25 },
  });

  it('calls the Responses route with the version that has it, not the provider\'s older one', async () => {
    const upstream = stubUpstream(() => responsesAnswer());
    const client = await azureRuntime('2024-10-21').createNativeChatClient!({
      modelId: 'gpt-5-prod',
      category: 'llm',
      modelSettings: { upstreamApi: 'responses' },
      options: { maxRetries: 0 },
    });
    await client.complete({ messages: ASK });

    expect(upstream.calls[0].url).toBe('https://res.openai.azure.com/openai/responses?api-version=2025-04-01-preview');
    expect(upstream.calls[0].headers['api-key']).toBe('az-key');
    expect(upstream.calls[0].body.model).toBe('gpt-5-prod');
  });

  it('keeps the provider\'s version on the Chat Completions route', async () => {
    const upstream = stubUpstream(() => json(completion()));
    const client = await azureRuntime('2024-10-21').createNativeChatClient!({
      modelId: 'gpt-4o-prod',
      category: 'llm',
      modelSettings: {},
      options: { maxRetries: 0 },
    });
    await client.complete({ messages: ASK });

    expect(upstream.calls[0].url).toBe('https://res.openai.azure.com/openai/deployments/gpt-4o-prod/chat/completions?api-version=2024-10-21');
  });

  it('uses the per-model version on the Responses route when the model names one', async () => {
    const upstream = stubUpstream(() => responsesAnswer());
    const client = await azureRuntime('2024-10-21').createNativeChatClient!({
      modelId: 'gpt-5-prod',
      category: 'llm',
      modelSettings: { upstreamApi: 'responses', azureApiVersion: '2025-03-01-preview' },
      options: { maxRetries: 0 },
    });
    await client.complete({ messages: ASK });

    expect(upstream.calls[0].url).toBe('https://res.openai.azure.com/openai/responses?api-version=2025-03-01-preview');
  });
});
