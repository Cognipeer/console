import type { ProviderContract } from '../types';
import type { ModelProviderRuntime } from '../domains/model';
import type {
  OcrExtractInput,
  OcrPageResult,
  OcrResult,
  OcrRuntime,
} from '../domains/ocr';

interface MistralOcrCredentials {
  apiKey: string;
}

interface MistralOcrSettings {
  baseUrl?: string;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()) || response.statusText;
  } catch {
    return response.statusText;
  }
}

function buildDocumentRef(input: OcrExtractInput): Record<string, unknown> {
  if (input.document.kind === 'url') {
    return { type: 'document_url', document_url: input.document.url };
  }
  const contentType = input.document.contentType || 'application/pdf';
  const base64 = input.document.data.toString('base64');
  // Mistral accepts data URLs for both pdf and images
  return { type: 'document_url', document_url: `data:${contentType};base64,${base64}` };
}

function mapMistralPages(payload: Record<string, unknown>): OcrPageResult[] | undefined {
  const pages = payload.pages;
  if (!Array.isArray(pages)) return undefined;
  return (pages as Record<string, unknown>[]).map((page, idx) => ({
    pageNumber: typeof page.index === 'number' ? page.index + 1 : idx + 1,
    text:
      typeof page.markdown === 'string'
        ? page.markdown
        : typeof page.text === 'string'
          ? page.text
          : '',
  }));
}

function joinPages(pages: OcrPageResult[] | undefined): string {
  if (!pages || pages.length === 0) return '';
  return pages.map((p) => p.text).filter(Boolean).join('\n\n');
}

function createMistralOcrRuntime(opts: {
  apiKey: string;
  baseUrl: string;
  modelId: string;
}): OcrRuntime {
  return {
    async extract(input: OcrExtractInput): Promise<OcrResult> {
      const body: Record<string, unknown> = {
        model: opts.modelId,
        document: buildDocumentRef(input),
      };
      if (input.pages && input.pages.length > 0) {
        body.pages = input.pages.map((p) => p - 1);
      }
      if (input.extra) {
        Object.assign(body, input.extra);
      }

      const response = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/ocr`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(
          `Mistral OCR failed (${response.status}): ${await readErrorBody(response)}`,
        );
      }

      const raw = (await response.json()) as Record<string, unknown>;
      const pages = mapMistralPages(raw);
      const usageInfo = raw.usage_info as Record<string, unknown> | undefined;
      const pageCount =
        usageInfo && typeof usageInfo.pages_processed === 'number'
          ? usageInfo.pages_processed
          : pages?.length;

      return {
        text: typeof raw.text === 'string' ? raw.text : joinPages(pages),
        pages,
        language:
          typeof raw.language === 'string' ? raw.language : input.language,
        usage: {
          pages: pageCount,
          inputBytes:
            input.document.kind === 'bytes' ? input.document.data.byteLength : undefined,
        },
        invokedVia: 'native',
        raw,
      };
    },
  };
}

export const MistralOcrProviderContract: ProviderContract<
  ModelProviderRuntime,
  MistralOcrCredentials,
  MistralOcrSettings
> = {
  id: 'mistral-ocr',
  version: '1.0.0',
  domains: ['ocr'],
  display: {
    label: 'Mistral OCR',
    description:
      'Mistral Document AI / OCR endpoint (POST /v1/ocr) with native PDF and image extraction.',
  },
  capabilities: {
    'model.categories': ['ocr'],
    'ocr.modes': ['native'],
    'ocr.supports.tables': true,
    'ocr.formats.input': ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
  },
  form: {
    sections: [
      {
        title: 'Credentials',
        fields: [
          {
            name: 'apiKey',
            label: 'Mistral API Key',
            type: 'password',
            required: true,
          },
        ],
      },
      {
        title: 'Settings',
        fields: [
          {
            name: 'baseUrl',
            label: 'Base URL',
            type: 'text',
            required: false,
            placeholder: 'https://api.mistral.ai/v1',
            description: 'Override for self-hosted or regional deployments.',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  createRuntime: ({ credentials, settings }) => {
    const apiKey = credentials.apiKey?.trim();
    if (!apiKey) throw new Error('Mistral OCR API key is required.');
    const baseUrl = (settings.baseUrl || 'https://api.mistral.ai/v1').trim();

    const runtime: ModelProviderRuntime = {
      createOcrRuntime: (config) =>
        createMistralOcrRuntime({
          apiKey,
          baseUrl,
          modelId: config.modelId,
        }),
    };

    return runtime;
  },
};
