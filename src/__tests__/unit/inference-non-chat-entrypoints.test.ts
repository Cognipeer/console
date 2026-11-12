import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleImageRequest,
  handleModerationRequest,
  handleOcrRequest,
  handleSpeechRequest,
  handleSpeechStreamRequest,
  handleTranscriptionRequest,
  handleTranscriptionStreamRequest,
} from '@/lib/services/models/inferenceService';
import { InvalidRequestError } from '@/lib/providers/contracts/upstreamError';
import { resetAllCircuits } from '@/lib/core/resilience';

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn(),
}));

vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: vi.fn(),
}));

vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/models/usageLogger')>();
  return { ...original, logModelUsage: vi.fn().mockResolvedValue(undefined) };
});

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { logModelUsage } from '@/lib/services/models/usageLogger';

type Category = 'stt' | 'tts' | 'image' | 'moderation' | 'ocr';

const modelOf = (category: Category, overrides: Record<string, unknown> = {}) => ({
  _id: `model-${category}`,
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: category,
  key: `${category}-model`,
  providerKey: `provider-${category}`,
  providerDriver: 'openai',
  category,
  modelId: `${category}-id`,
  settings: {},
  pricing: {},
  ...overrides,
});

const base = (category: Category) => ({
  tenantDbName: 'tenant_db',
  modelKey: `${category}-model`,
  projectId: 'proj-1',
  requestId: 'req-1',
});

interface Entry {
  name: string;
  category: Category;
  wrongMessage: string;
  wrongIsInvalidRequest: boolean;
  unsupportedMessage: string;
  /** The runtime factory this entry reads from the provider runtime. */
  factory: string;
  /** What that factory must return for the call to succeed. */
  domainRuntime: Record<string, unknown>;
  call: () => Promise<unknown>;
  successRoute?: string;
}

const entries: Entry[] = [
  {
    name: 'handleTranscriptionRequest',
    category: 'stt',
    wrongMessage: 'Model is not configured for speech-to-text',
    wrongIsInvalidRequest: true,
    unsupportedMessage: 'Model provider does not support speech-to-text',
    factory: 'createSttRuntime',
    domainRuntime: { transcribe: vi.fn().mockResolvedValue({ text: 'hi', usage: { inputSeconds: 2 } }) },
    call: () =>
      handleTranscriptionRequest({
        ...base('stt'),
        input: { audio: { data: Buffer.from('RIFF'), fileName: 'a.wav', contentType: 'audio/wav' } },
      }),
    successRoute: 'audio.transcriptions',
  },
  {
    name: 'handleTranscriptionStreamRequest',
    category: 'stt',
    wrongMessage: 'Model is not configured for speech-to-text',
    wrongIsInvalidRequest: true,
    unsupportedMessage: 'Model provider does not support speech-to-text',
    factory: 'createSttRuntime',
    domainRuntime: {
      transcribe: vi.fn(),
      createStream: vi.fn().mockResolvedValue({ push: vi.fn(), finish: vi.fn(), onPartial: vi.fn(), close: vi.fn() }),
    },
    call: () => handleTranscriptionStreamRequest({ ...base('stt'), options: { sampleRate: 16000 } as never }),
  },
  {
    name: 'handleSpeechRequest',
    category: 'tts',
    wrongMessage: 'Model is not configured for text-to-speech',
    wrongIsInvalidRequest: true,
    unsupportedMessage: 'Model provider does not support text-to-speech',
    factory: 'createTtsRuntime',
    domainRuntime: {
      synthesize: vi.fn().mockResolvedValue({
        audio: Buffer.from('abc'),
        contentType: 'audio/mpeg',
        format: 'mp3',
        usage: { inputCharacters: 5 },
      }),
    },
    call: () => handleSpeechRequest({ ...base('tts'), input: { text: 'hello' } }),
    successRoute: 'audio.speech',
  },
  {
    name: 'handleSpeechStreamRequest',
    category: 'tts',
    wrongMessage: 'Model is not configured for text-to-speech',
    wrongIsInvalidRequest: true,
    unsupportedMessage: 'Model provider does not support text-to-speech',
    factory: 'createTtsRuntime',
    domainRuntime: {
      synthesize: vi.fn().mockResolvedValue({ audio: Buffer.from('abc'), contentType: 'audio/mpeg', format: 'mp3' }),
    },
    call: () => handleSpeechStreamRequest({ ...base('tts'), input: { text: 'hello' } }),
  },
  {
    name: 'handleImageRequest',
    category: 'image',
    wrongMessage: 'Model is not configured for image generation',
    wrongIsInvalidRequest: true,
    unsupportedMessage: 'Model provider does not support image generation',
    factory: 'createImageRuntime',
    domainRuntime: { generate: vi.fn().mockResolvedValue({ images: [{ b64Json: 'xx' }], usage: {} }) },
    call: () => handleImageRequest({ ...base('image'), input: { prompt: 'a cat' } as never }),
    successRoute: 'images.generations',
  },
  {
    name: 'handleModerationRequest',
    category: 'moderation',
    wrongMessage: 'Model is not configured for moderation',
    wrongIsInvalidRequest: true,
    unsupportedMessage: 'Model provider does not support moderation',
    factory: 'createModerationRuntime',
    domainRuntime: {
      classify: vi.fn().mockResolvedValue({ results: [{ flagged: true }], usage: { inputTokens: 3 } }),
    },
    call: () => handleModerationRequest({ ...base('moderation'), texts: ['bad', 'good'] }),
    successRoute: 'moderations',
  },
  {
    name: 'handleOcrRequest',
    category: 'ocr',
    wrongMessage: 'Model is not configured for OCR',
    wrongIsInvalidRequest: false,
    unsupportedMessage: 'Model provider does not support OCR',
    factory: 'createOcrRuntime',
    domainRuntime: { extract: vi.fn().mockResolvedValue({ text: 'page text', usage: { pages: 1 } }) },
    call: () =>
      handleOcrRequest({
        ...base('ocr'),
        input: { document: { kind: 'bytes', data: Buffer.from('%PDF'), contentType: 'application/pdf' } } as never,
      }),
    successRoute: 'ocr',
  },
];

describe.each(entries)('$name', (entry) => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllCircuits();
  });

  const installRuntime = (runtime: Record<string, unknown>) =>
    vi.mocked(buildModelRuntime).mockResolvedValue({ runtime } as never);

  it('rejects an unknown model before any provider work', async () => {
    vi.mocked(getModelByKey).mockResolvedValue(null);
    await expect(entry.call()).rejects.toThrow(`Model with key ${entry.category}-model not found`);
    expect(buildModelRuntime).not.toHaveBeenCalled();
    expect(logModelUsage).not.toHaveBeenCalled();
  });

  it('rejects a model of another category before building the runtime', async () => {
    vi.mocked(getModelByKey).mockResolvedValue(modelOf(category(entry.category) as Category) as never);
    await expect(entry.call()).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof Error &&
        error.message === entry.wrongMessage &&
        (error instanceof InvalidRequestError) === entry.wrongIsInvalidRequest
      );
    });
    expect(buildModelRuntime).not.toHaveBeenCalled();
  });

  it('builds the provider runtime from the serving model and reports an unsupported provider', async () => {
    vi.mocked(getModelByKey).mockResolvedValue(modelOf(entry.category) as never);
    installRuntime({});
    await expect(entry.call()).rejects.toThrow(entry.unsupportedMessage);
    expect(buildModelRuntime).toHaveBeenCalledTimes(1);
    expect(buildModelRuntime).toHaveBeenCalledWith('tenant_db', 'tenant-1', `provider-${entry.category}`, 'proj-1');
  });

  it('serves from the first enabled replica, not a switched-off primary', async () => {
    vi.mocked(getModelByKey).mockResolvedValue(
      modelOf(entry.category, {
        providerKey: 'off-provider',
        replicas: [
          { providerKey: 'off-provider', modelId: 'off-id', enabled: false },
          { providerKey: 'live-provider', modelId: 'live-id', enabled: true },
        ],
      }) as never,
    );
    installRuntime({});
    await expect(entry.call()).rejects.toThrow(entry.unsupportedMessage);
    expect(buildModelRuntime).toHaveBeenCalledWith('tenant_db', 'tenant-1', 'live-provider', 'proj-1');
  });

  it('runs the provider call and records usage on its route', async () => {
    vi.mocked(getModelByKey).mockResolvedValue(modelOf(entry.category) as never);
    const factory = vi.fn().mockResolvedValue(entry.domainRuntime);
    installRuntime({ [entry.factory]: factory });

    const result = (await entry.call()) as { requestId?: string; model?: { key: string } };

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: `${entry.category}-id`, category: entry.category }),
    );
    if (entry.successRoute) {
      await vi.waitFor(() => expect(logModelUsage).toHaveBeenCalledTimes(1));
      const [dbName, model, payload] = vi.mocked(logModelUsage).mock.calls[0];
      expect(dbName).toBe('tenant_db');
      expect((model as { key: string }).key).toBe(`${entry.category}-model`);
      expect(payload).toMatchObject({ requestId: 'req-1', route: entry.successRoute, status: 'success' });
      expect(result.requestId).toBe('req-1');
    }
  });
});

/** A category that is never the entry's own. */
function category(own: Category): Category {
  return own === 'stt' ? 'tts' : 'stt';
}

describe('handleOcrRequest error logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllCircuits();
  });

  it('logs a failed call as an error row only when asked to, and keeps the original error', async () => {
    vi.mocked(getModelByKey).mockResolvedValue(modelOf('ocr') as never);
    vi.mocked(buildModelRuntime).mockResolvedValue({
      runtime: {
        createOcrRuntime: vi.fn().mockResolvedValue({ extract: vi.fn().mockRejectedValue(new Error('boom')) }),
      },
    } as never);
    const params = {
      ...base('ocr'),
      input: { document: { kind: 'bytes', data: Buffer.from('%PDF'), contentType: 'application/pdf' } } as never,
      resilience: { retry: { enabled: false } },
    };

    await expect(handleOcrRequest(params)).rejects.toThrow('boom');
    expect(logModelUsage).not.toHaveBeenCalled();

    await expect(handleOcrRequest({ ...params, logErrors: true })).rejects.toThrow('boom');
    expect(logModelUsage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logModelUsage).mock.calls[0][2]).toMatchObject({ route: 'ocr', status: 'error', errorMessage: 'boom' });
  });

  it('reads through a multimodal LLM when asked, skipping the OCR category check', async () => {
    vi.mocked(getModelByKey).mockResolvedValue(
      modelOf('ocr', { category: 'llm', isMultimodal: true }) as never,
    );
    vi.mocked(buildModelRuntime).mockResolvedValue({ runtime: {} } as never);
    // A vision LLM does not need createOcrRuntime; the VLM helper drives the chat runtime instead.
    await expect(
      handleOcrRequest({
        ...base('ocr'),
        allowVisionLlm: true,
        input: { document: { kind: 'bytes', data: Buffer.from('%PDF'), contentType: 'application/pdf' } } as never,
        resilience: { retry: { enabled: false } },
      }),
    ).rejects.not.toThrow('Model provider does not support OCR');
    expect(buildModelRuntime).toHaveBeenCalledWith('tenant_db', 'tenant-1', 'provider-ocr', 'proj-1');
  });
});
