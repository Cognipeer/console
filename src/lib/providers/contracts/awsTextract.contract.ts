import type { ProviderContract } from '../types';
import type { ModelProviderRuntime } from '../domains/model';
import type {
  OcrExtractInput,
  OcrPageResult,
  OcrResult,
  OcrRuntime,
} from '../domains/ocr';

interface TextractCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface TextractSettings {
  region: string;
}

interface TextractBlock {
  BlockType?: string;
  Text?: string;
  Page?: number;
  Confidence?: number;
  Geometry?: {
    BoundingBox?: { Width: number; Height: number; Left: number; Top: number };
  };
}

function buildPagesFromBlocks(blocks: TextractBlock[]): OcrPageResult[] {
  const lineBlocks = blocks.filter((b) => b.BlockType === 'LINE');
  const byPage = new Map<number, OcrPageResult>();

  for (const block of lineBlocks) {
    const pageNumber = block.Page ?? 1;
    let page = byPage.get(pageNumber);
    if (!page) {
      page = { pageNumber, text: '', blocks: [] };
      byPage.set(pageNumber, page);
    }
    const text = block.Text ?? '';
    page.text = page.text ? `${page.text}\n${text}` : text;
    page.blocks!.push({
      type: 'line',
      text,
      bbox: block.Geometry?.BoundingBox
        ? {
            x: block.Geometry.BoundingBox.Left,
            y: block.Geometry.BoundingBox.Top,
            width: block.Geometry.BoundingBox.Width,
            height: block.Geometry.BoundingBox.Height,
          }
        : undefined,
      confidence: typeof block.Confidence === 'number' ? block.Confidence : undefined,
    });
  }

  return Array.from(byPage.values()).sort((a, b) => a.pageNumber - b.pageNumber);
}

function createTextractRuntime(opts: {
  credentials: TextractCredentials;
  region: string;
  modelId: string;
}): OcrRuntime {
  return {
    async extract(input: OcrExtractInput): Promise<OcrResult> {
      // Dynamic import keeps AWS SDK out of cold-start path until first OCR call.
      const sdk = await import('@aws-sdk/client-textract');
      const { TextractClient } = sdk;

      const client = new TextractClient({
        region: opts.region,
        credentials: {
          accessKeyId: opts.credentials.accessKeyId,
          secretAccessKey: opts.credentials.secretAccessKey,
          sessionToken: opts.credentials.sessionToken,
        },
      });

      // modelId acts as the operation selector. Defaults to 'detect-document-text'.
      // Supported: 'detect-document-text' | 'analyze-document'.
      const operation = (opts.modelId || 'detect-document-text').toLowerCase();
      const wantsTables = (input.features ?? []).includes('tables');
      const wantsKv = (input.features ?? []).includes('kv_pairs');

      if (input.document.kind === 'url') {
        throw new Error(
          'AWS Textract requires inline document bytes; URL sources are not supported by this contract.',
        );
      }

      const documentBytes = new Uint8Array(input.document.data);

      let raw: Record<string, unknown>;

      if (operation === 'analyze-document' || wantsTables || wantsKv) {
        const featureTypes: string[] = [];
        if (wantsTables) featureTypes.push('TABLES');
        if (wantsKv) featureTypes.push('FORMS');
        if (featureTypes.length === 0) featureTypes.push('TABLES', 'FORMS');

        const { AnalyzeDocumentCommand } = sdk;
        raw = (await client.send(
          new AnalyzeDocumentCommand({
            Document: { Bytes: documentBytes },
            FeatureTypes: featureTypes as never,
          }),
        )) as unknown as Record<string, unknown>;
      } else {
        const { DetectDocumentTextCommand } = sdk;
        raw = (await client.send(
          new DetectDocumentTextCommand({
            Document: { Bytes: documentBytes },
          }),
        )) as unknown as Record<string, unknown>;
      }

      const blocks = Array.isArray(raw.Blocks) ? (raw.Blocks as TextractBlock[]) : [];
      const pages = buildPagesFromBlocks(blocks);
      const text = pages.map((p) => p.text).join('\n\n');

      return {
        text,
        pages,
        usage: {
          pages: pages.length,
          inputBytes: input.document.data.byteLength,
        },
        invokedVia: 'native',
        raw,
      };
    },
  };
}

export const AwsTextractProviderContract: ProviderContract<
  ModelProviderRuntime,
  TextractCredentials,
  TextractSettings
> = {
  id: 'aws-textract',
  version: '1.0.0',
  domains: ['ocr'],
  display: {
    label: 'AWS Textract',
    description:
      'Amazon Textract OCR with layout and table/form extraction. Use modelId "detect-document-text" for plain OCR or "analyze-document" for layout/tables/forms.',
  },
  capabilities: {
    'model.categories': ['ocr'],
    'ocr.modes': ['native'],
    'ocr.supports.tables': true,
    'ocr.supports.kv_pairs': true,
    'ocr.formats.input': ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff'],
  },
  form: {
    sections: [
      {
        title: 'Credentials',
        fields: [
          {
            name: 'accessKeyId',
            label: 'AWS Access Key ID',
            type: 'text',
            required: true,
          },
          {
            name: 'secretAccessKey',
            label: 'AWS Secret Access Key',
            type: 'password',
            required: true,
          },
          {
            name: 'sessionToken',
            label: 'AWS Session Token',
            type: 'password',
            required: false,
          },
        ],
      },
      {
        title: 'Settings',
        fields: [
          {
            name: 'region',
            label: 'AWS Region',
            type: 'select',
            required: true,
            options: [
              { label: 'us-east-1', value: 'us-east-1' },
              { label: 'us-west-2', value: 'us-west-2' },
              { label: 'eu-west-1', value: 'eu-west-1' },
              { label: 'eu-central-1', value: 'eu-central-1' },
              { label: 'ap-southeast-2', value: 'ap-southeast-2' },
            ],
            scope: 'settings',
          },
        ],
      },
    ],
  },
  createRuntime: ({ credentials, settings }) => {
    const accessKeyId = credentials.accessKeyId?.trim();
    const secretAccessKey = credentials.secretAccessKey?.trim();
    const region = settings.region?.trim();
    if (!accessKeyId) throw new Error('AWS Access Key ID is required.');
    if (!secretAccessKey) throw new Error('AWS Secret Access Key is required.');
    if (!region) throw new Error('AWS Region is required.');

    const runtime: ModelProviderRuntime = {
      createOcrRuntime: (config) =>
        createTextractRuntime({
          credentials: {
            accessKeyId,
            secretAccessKey,
            sessionToken: credentials.sessionToken,
          },
          region,
          modelId: config.modelId,
        }),
    };

    return runtime;
  },
};
