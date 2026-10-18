import { describe, expect, it } from 'vitest';
import { getModuleDocId, resolveSdkDoc } from '@/lib/docs/sdkDocs';

describe('sdkDocs', () => {
  it('points every page at the live console-sdk docs host', () => {
    for (const id of ['getting-started', 'guide-authentication', 'api-client', 'api-tracing', 'examples-chat', 'examples-rag'] as const) {
      expect(resolveSdkDoc(id).url.startsWith('https://docs.cognipeer.com/console-sdk/')).toBe(true);
    }
    expect(resolveSdkDoc('getting-started').url).toBe('https://docs.cognipeer.com/console-sdk/guide/getting-started.html');
  });

  it('falls back to getting-started and maps modules', () => {
    expect(resolveSdkDoc('nope').id).toBe('getting-started');
    expect(getModuleDocId('tracing')).toBe('api-tracing');
  });
});
