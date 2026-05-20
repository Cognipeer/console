import type { ProviderContract } from '../types';
import type { ModelProviderRuntime } from '../domains/model';
import type {
  OcrBlock,
  OcrExtractInput,
  OcrKeyValuePair,
  OcrPageResult,
  OcrResult,
  OcrRuntime,
  OcrTable,
  OcrTableCell,
} from '../domains/ocr';

interface AzureDiCredentials {
  apiKey: string;
}

interface AzureDiSettings {
  endpoint: string;
  apiVersion?: string;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()) || response.statusText;
  } catch {
    return response.statusText;
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAnalyzeBody(input: OcrExtractInput) {
  if (input.document.kind === 'url') {
    return { urlSource: input.document.url };
  }
  return { base64Source: input.document.data.toString('base64') };
}

function mapAzureWords(line: Record<string, unknown>): OcrBlock {
  const polygon = line.polygon as number[] | undefined;
  return {
    type: 'line',
    text: typeof line.content === 'string' ? line.content : '',
    bbox: Array.isArray(polygon) && polygon.length >= 8
      ? {
          x: polygon[0],
          y: polygon[1],
          width: polygon[4] - polygon[0],
          height: polygon[5] - polygon[1],
        }
      : undefined,
  };
}

function mapPages(payload: Record<string, unknown>): OcrPageResult[] | undefined {
  const result = (payload.analyzeResult as Record<string, unknown> | undefined) ?? payload;
  const pages = result.pages;
  if (!Array.isArray(pages)) return undefined;
  return (pages as Record<string, unknown>[]).map((page, idx) => {
    const lines = Array.isArray(page.lines) ? (page.lines as Record<string, unknown>[]) : [];
    const blocks: OcrBlock[] = lines.map(mapAzureWords);
    return {
      pageNumber: typeof page.pageNumber === 'number' ? page.pageNumber : idx + 1,
      text: blocks.map((b) => b.text).join('\n'),
      blocks,
      width: typeof page.width === 'number' ? page.width : undefined,
      height: typeof page.height === 'number' ? page.height : undefined,
    };
  });
}

function mapTables(payload: Record<string, unknown>): OcrTable[] | undefined {
  const result = (payload.analyzeResult as Record<string, unknown> | undefined) ?? payload;
  const tables = result.tables;
  if (!Array.isArray(tables)) return undefined;

  return (tables as Record<string, unknown>[]).map((table) => {
    const cellsRaw = Array.isArray(table.cells)
      ? (table.cells as Record<string, unknown>[])
      : [];
    const cells: OcrTableCell[] = cellsRaw.map((cell) => ({
      rowIndex: typeof cell.rowIndex === 'number' ? cell.rowIndex : 0,
      colIndex: typeof cell.columnIndex === 'number' ? cell.columnIndex : 0,
      rowSpan: typeof cell.rowSpan === 'number' ? cell.rowSpan : undefined,
      colSpan: typeof cell.columnSpan === 'number' ? cell.columnSpan : undefined,
      text: typeof cell.content === 'string' ? cell.content : '',
    }));
    return {
      rows: typeof table.rowCount === 'number' ? table.rowCount : 0,
      cols: typeof table.columnCount === 'number' ? table.columnCount : 0,
      cells,
    };
  });
}

function mapKvPairs(payload: Record<string, unknown>): OcrKeyValuePair[] | undefined {
  const result = (payload.analyzeResult as Record<string, unknown> | undefined) ?? payload;
  const kv = result.keyValuePairs;
  if (!Array.isArray(kv)) return undefined;
  return (kv as Record<string, unknown>[]).map((pair) => {
    const key = pair.key as Record<string, unknown> | undefined;
    const value = pair.value as Record<string, unknown> | undefined;
    return {
      key: typeof key?.content === 'string' ? key.content : '',
      value: typeof value?.content === 'string' ? value.content : '',
      confidence: typeof pair.confidence === 'number' ? pair.confidence : undefined,
    };
  });
}

function createAzureDiRuntime(opts: {
  apiKey: string;
  endpoint: string;
  apiVersion: string;
  modelId: string;
}): OcrRuntime {
  const base = opts.endpoint.replace(/\/$/, '');

  return {
    async extract(input: OcrExtractInput): Promise<OcrResult> {
      const features = (input.features ?? []).filter(Boolean).join(',');
      const queryParts = [`api-version=${encodeURIComponent(opts.apiVersion)}`];
      if (features) queryParts.push(`features=${encodeURIComponent(features)}`);
      if (input.pages && input.pages.length > 0) {
        queryParts.push(`pages=${encodeURIComponent(input.pages.join(','))}`);
      }
      if (input.language) {
        queryParts.push(`locale=${encodeURIComponent(input.language)}`);
      }
      const url = `${base}/documentintelligence/documentModels/${encodeURIComponent(opts.modelId)}:analyze?${queryParts.join('&')}`;

      const startResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': opts.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildAnalyzeBody(input)),
      });

      if (startResponse.status !== 202) {
        throw new Error(
          `Azure Document Intelligence failed to start analyze (${startResponse.status}): ${await readErrorBody(startResponse)}`,
        );
      }

      const operationUrl = startResponse.headers.get('operation-location');
      if (!operationUrl) {
        throw new Error('Azure Document Intelligence: missing operation-location header.');
      }

      // Long-polling. Azure typically completes in 2-10s for small docs.
      const startedAt = Date.now();
      const maxWaitMs = 120_000;
      let payload: Record<string, unknown> | null = null;

      while (Date.now() - startedAt < maxWaitMs) {
        await sleep(1000);
        const pollResponse = await fetch(operationUrl, {
          headers: { 'Ocp-Apim-Subscription-Key': opts.apiKey },
        });
        if (!pollResponse.ok) {
          throw new Error(
            `Azure Document Intelligence poll failed (${pollResponse.status}): ${await readErrorBody(pollResponse)}`,
          );
        }
        const data = (await pollResponse.json()) as Record<string, unknown>;
        const status = typeof data.status === 'string' ? data.status : '';
        if (status === 'succeeded') {
          payload = data;
          break;
        }
        if (status === 'failed') {
          throw new Error(
            `Azure Document Intelligence reported failure: ${JSON.stringify(data.error ?? data)}`,
          );
        }
      }

      if (!payload) {
        throw new Error('Azure Document Intelligence analyze timed out.');
      }

      const analyzeResult =
        (payload.analyzeResult as Record<string, unknown> | undefined) ?? payload;
      const pages = mapPages(payload);
      const tables = mapTables(payload);
      const keyValuePairs = mapKvPairs(payload);
      const text =
        typeof analyzeResult.content === 'string'
          ? analyzeResult.content
          : (pages ?? []).map((p) => p.text).join('\n\n');

      return {
        text,
        pages,
        tables,
        keyValuePairs,
        language: input.language,
        usage: {
          pages: pages?.length,
          inputBytes:
            input.document.kind === 'bytes' ? input.document.data.byteLength : undefined,
        },
        invokedVia: 'native',
        raw: payload,
      };
    },
  };
}

export const AzureDocumentIntelligenceProviderContract: ProviderContract<
  ModelProviderRuntime,
  AzureDiCredentials,
  AzureDiSettings
> = {
  id: 'azure-document-intelligence',
  version: '1.0.0',
  domains: ['ocr'],
  display: {
    label: 'Azure Document Intelligence',
    description:
      'Microsoft Azure Document Intelligence (formerly Form Recognizer) — native OCR with layout, tables, and key-value extraction.',
  },
  capabilities: {
    'model.categories': ['ocr'],
    'ocr.modes': ['native'],
    'ocr.supports.tables': true,
    'ocr.supports.kv_pairs': true,
    'ocr.formats.input': ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'image/bmp'],
  },
  form: {
    sections: [
      {
        title: 'Credentials',
        fields: [
          {
            name: 'apiKey',
            label: 'Azure Subscription Key',
            type: 'password',
            required: true,
          },
        ],
      },
      {
        title: 'Settings',
        fields: [
          {
            name: 'endpoint',
            label: 'Endpoint URL',
            type: 'text',
            required: true,
            placeholder: 'https://<your-resource>.cognitiveservices.azure.com',
            scope: 'settings',
          },
          {
            name: 'apiVersion',
            label: 'API Version',
            type: 'text',
            required: false,
            placeholder: '2024-11-30',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  createRuntime: ({ credentials, settings }) => {
    const apiKey = credentials.apiKey?.trim();
    if (!apiKey) throw new Error('Azure Document Intelligence API key is required.');
    const endpoint = settings.endpoint?.trim();
    if (!endpoint) throw new Error('Azure Document Intelligence endpoint is required.');
    const apiVersion = (settings.apiVersion || '2024-11-30').trim();

    const runtime: ModelProviderRuntime = {
      createOcrRuntime: (config) =>
        createAzureDiRuntime({
          apiKey,
          endpoint,
          apiVersion,
          modelId: config.modelId,
        }),
    };

    return runtime;
  },
};
