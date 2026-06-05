import type {
  SttRuntime,
  SttResult,
  SttTranscribeInput,
  SttTranslateInput,
  TtsRuntime,
  TtsResult,
  TtsSynthesizeInput,
  TtsOutputFormat,
} from '../domains/audio';

export interface OpenAiAudioClientOptions {
  apiKey: string;
  baseUrl: string;
  organization?: string;
  /** Audio model id (e.g. whisper-1, gpt-4o-mini-transcribe, tts-1, gpt-4o-mini-tts). */
  modelId: string;
  /** Extra headers (Azure passes api-version through query string instead). */
  extraHeaders?: Record<string, string>;
  /** Override the URL builder (Azure has a different shape). */
  buildUrl?: (path: '/audio/transcriptions' | '/audio/translations' | '/audio/speech') => string;
}

const FORMAT_TO_MIME: Record<TtsOutputFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/L16',
};

function buildHeaders(opts: OpenAiAudioClientOptions, json = false) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
  };
  if (opts.organization) {
    headers['OpenAI-Organization'] = opts.organization;
  }
  if (json) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.extraHeaders) {
    Object.assign(headers, opts.extraHeaders);
  }
  return headers;
}

function resolveUrl(opts: OpenAiAudioClientOptions, path: '/audio/transcriptions' | '/audio/translations' | '/audio/speech') {
  if (opts.buildUrl) return opts.buildUrl(path);
  const base = opts.baseUrl.replace(/\/$/, '');
  return `${base}${path}`;
}

function inferFileName(input: SttTranscribeInput | SttTranslateInput): string {
  if (input.audio.fileName) return input.audio.fileName;
  const ext = guessExtensionFromMime(input.audio.contentType);
  return `audio${ext ? `.${ext}` : ''}`;
}

function guessExtensionFromMime(mime?: string): string | undefined {
  if (!mime) return undefined;
  const map: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a',
    'audio/mp4': 'm4a',
  };
  return map[mime.toLowerCase()];
}

async function readErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text || response.statusText;
  } catch {
    return response.statusText;
  }
}

function parseTranscriptionResponse(raw: unknown): SttResult {
  if (typeof raw === 'string') {
    return {
      text: raw,
      usage: { inputTokens: 0, outputTokens: 0 },
      raw,
    };
  }

  if (!raw || typeof raw !== 'object') {
    return { text: '', raw };
  }

  const body = raw as Record<string, unknown>;
  const text = typeof body.text === 'string' ? body.text : '';
  const language = typeof body.language === 'string' ? body.language : undefined;
  const duration = typeof body.duration === 'number' ? body.duration : undefined;

  const segments = Array.isArray(body.segments)
    ? (body.segments as Record<string, unknown>[]).map((seg) => ({
        id: typeof seg.id === 'number' ? seg.id : undefined,
        start: typeof seg.start === 'number' ? seg.start : 0,
        end: typeof seg.end === 'number' ? seg.end : 0,
        text: typeof seg.text === 'string' ? seg.text : '',
        avgLogprob: typeof seg.avg_logprob === 'number' ? seg.avg_logprob : undefined,
        compressionRatio:
          typeof seg.compression_ratio === 'number' ? seg.compression_ratio : undefined,
        noSpeechProb:
          typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : undefined,
      }))
    : undefined;

  const words = Array.isArray(body.words)
    ? (body.words as Record<string, unknown>[]).map((w) => ({
        start: typeof w.start === 'number' ? w.start : 0,
        end: typeof w.end === 'number' ? w.end : 0,
        word: typeof w.word === 'string' ? w.word : '',
      }))
    : undefined;

  const usageField = body.usage as Record<string, unknown> | undefined;
  const inputTokens =
    usageField && typeof usageField.input_tokens === 'number'
      ? usageField.input_tokens
      : usageField && typeof usageField.prompt_tokens === 'number'
        ? usageField.prompt_tokens
        : undefined;
  const outputTokens =
    usageField && typeof usageField.output_tokens === 'number'
      ? usageField.output_tokens
      : usageField && typeof usageField.completion_tokens === 'number'
        ? usageField.completion_tokens
        : undefined;
  const totalTokens =
    usageField && typeof usageField.total_tokens === 'number'
      ? usageField.total_tokens
      : undefined;

  return {
    text,
    language,
    duration,
    segments,
    words,
    usage: {
      inputSeconds: duration,
      inputTokens,
      outputTokens,
      totalTokens,
    },
    raw,
  };
}

export function createOpenAiSttRuntime(opts: OpenAiAudioClientOptions): SttRuntime {
  const transcribe = async (input: SttTranscribeInput): Promise<SttResult> => {
    const form = new FormData();
    const fileName = inferFileName(input);
    const blob = new Blob([new Uint8Array(input.audio.data)], {
      type: input.audio.contentType || 'application/octet-stream',
    });
    form.append('file', blob, fileName);
    form.append('model', opts.modelId);
    if (input.language) form.append('language', input.language);
    if (input.prompt) form.append('prompt', input.prompt);
    if (input.responseFormat) form.append('response_format', input.responseFormat);
    if (typeof input.temperature === 'number') {
      form.append('temperature', String(input.temperature));
    }
    if (input.timestampGranularities && input.timestampGranularities.length > 0) {
      input.timestampGranularities.forEach((g) =>
        form.append('timestamp_granularities[]', g),
      );
    }
    if (input.extra) {
      for (const [k, v] of Object.entries(input.extra)) {
        if (v === undefined || v === null) continue;
        form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
    }

    const url = resolveUrl(opts, '/audio/transcriptions');
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(opts, false),
      body: form,
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI transcription failed (${response.status}): ${await readErrorText(response)}`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    const raw: unknown = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    return parseTranscriptionResponse(raw);
  };

  const translate = async (input: SttTranslateInput): Promise<SttResult> => {
    const form = new FormData();
    const fileName = inferFileName(input);
    const blob = new Blob([new Uint8Array(input.audio.data)], {
      type: input.audio.contentType || 'application/octet-stream',
    });
    form.append('file', blob, fileName);
    form.append('model', opts.modelId);
    if (input.prompt) form.append('prompt', input.prompt);
    if (input.responseFormat) form.append('response_format', input.responseFormat);
    if (typeof input.temperature === 'number') {
      form.append('temperature', String(input.temperature));
    }

    const url = resolveUrl(opts, '/audio/translations');
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(opts, false),
      body: form,
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI translation failed (${response.status}): ${await readErrorText(response)}`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    const raw: unknown = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    return parseTranscriptionResponse(raw);
  };

  return { transcribe, translate };
}

export function createOpenAiTtsRuntime(opts: OpenAiAudioClientOptions): TtsRuntime {
  const synthesize = async (input: TtsSynthesizeInput): Promise<TtsResult> => {
    const format: TtsOutputFormat = input.format ?? 'mp3';
    const body: Record<string, unknown> = {
      model: opts.modelId,
      input: input.text,
      voice: input.voice,
      response_format: format,
    };
    if (typeof input.speed === 'number') body.speed = input.speed;
    if (input.instructions) body.instructions = input.instructions;
    if (input.extra) Object.assign(body, input.extra);

    const url = resolveUrl(opts, '/audio/speech');
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(opts, true),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI TTS failed (${response.status}): ${await readErrorText(response)}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      audio: buffer,
      contentType: response.headers.get('content-type') ?? FORMAT_TO_MIME[format],
      format,
      usage: {
        inputCharacters: input.text.length,
      },
    };
  };

  return { synthesize };
}
