/**
 * The SDK side of the Azure Blob provider: loading it, and building its request pipeline.
 *
 * The SDK is imported lazily (`loadAzureBlobSdk`): loading @azure/storage-blob costs ~30 MB RSS and ~80 ms
 * (about what @aws-sdk/client-s3 costs), and the contract registry is loaded by every Fastify process whether
 * or not anyone configured an Azure provider. Everywhere else the SDK is imported for its types only.
 */

import type http from 'node:http';
import type https from 'node:https';
import type { AnonymousCredential, Pipeline, StorageSharedKeyCredential } from '@azure/storage-blob';
import type { TokenCredential } from './blobEntra';

export type AzureBlobSdk = typeof import('@azure/storage-blob');

/** One import per process; the module system caches it, this only avoids repeating the `await`. */
export function loadAzureBlobSdk(): Promise<AzureBlobSdk> {
  return import('@azure/storage-blob');
}

export interface PipelineSettings {
  /** `x-ms-version` to send instead of the SDK's own (Azure Stack Hub, Azurite, sovereign clouds). */
  apiVersion?: string;
  /** The socket agent the requests go through; without one the SDK keeps its own, which honours HTTP(S)_PROXY. */
  agent?: http.Agent | https.Agent;
  /** SDK-level retries; `withResilience` retries the whole call on top, so this stays small. */
  maxTries?: number;
}

/**
 * The SDK pipeline: given credential, retry bounds and, when needed, a request policy that sets
 * the `x-ms-version` header and the socket `agent`.
 *
 * The policy is a legacy `RequestPolicyFactory` pushed onto `Pipeline.factories`. It is the one
 * hook that sets both before the request is signed (the `version` client option is ignored by
 * 12.33, and a signed `x-ms-version` must match what is sent). It is only added when one of the
 * two is needed: with no agent the SDK keeps its default, which honours HTTP(S)_PROXY, and an
 * injected `agent` ignores env proxies (measured).
 */
export function buildPipeline(
  sdk: AzureBlobSdk,
  credential: StorageSharedKeyCredential | AnonymousCredential | TokenCredential,
  settings: PipelineSettings,
): Pipeline {
  const pipeline = sdk.newPipeline(credential, {
    retryOptions: { maxTries: settings.maxTries ?? 2, retryDelayInMs: 500, maxRetryDelayInMs: 4_000 },
    userAgentOptions: { userAgentPrefix: 'cognipeer-console' },
  });
  if (settings.apiVersion || settings.agent) {
    const { apiVersion, agent } = settings;
    pipeline.factories.push({
      create(nextPolicy) {
        return {
          sendRequest(request) {
            if (apiVersion) request.headers.set('x-ms-version', apiVersion);
            // A real http(s).Agent: the SDK's node client uses `request.agent ?? <its own>`.
            if (agent) (request as unknown as { agent?: http.Agent | https.Agent }).agent = agent;
            return nextPolicy.sendRequest(request);
          },
        };
      },
    });
  }
  return pipeline;
}
