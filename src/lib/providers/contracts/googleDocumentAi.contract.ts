import type { ProviderContract } from '../types';
import type { ModelProviderRuntime } from '../domains/model';
import type {
  OcrExtractInput,
  OcrPageResult,
  OcrResult,
  OcrRuntime,
} from '../domains/ocr';

interface GoogleDocAiCredentials {
  serviceAccountKey: string;
}

interface GoogleDocAiSettings {
  projectId: string;
  location: string;
  processorId: string;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()) || response.statusText;
  } catch {
    return response.statusText;
  }
}

function parseServiceAccountKey(raw?: string): {
  client_email: string;
  private_key: string;
  token_uri?: string;
} {
  if (!raw) {
    throw new Error('Google service account JSON is required.');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid Google service account JSON: ${(error as Error).message}`);
  }
  if (
    typeof parsed.client_email !== 'string' ||
    typeof parsed.private_key !== 'string'
  ) {
    throw new Error('Service account JSON missing client_email or private_key.');
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri:
      typeof parsed.token_uri === 'string'
        ? parsed.token_uri
        : 'https://oauth2.googleapis.com/token',
  };
}

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function fetchGoogleAccessToken(
  sa: ReturnType<typeof parseServiceAccountKey>,
): Promise<string> {
  const { createSign } = await import('node:crypto');
  const iat = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: sa.token_uri!,
    iat,
    exp: iat + 3600,
  };
  const header = { alg: 'RS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimB64 = base64UrlEncode(JSON.stringify(claim));
  const unsigned = `${headerB64}.${claimB64}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = base64UrlEncode(signer.sign(sa.private_key));
  const jwt = `${unsigned}.${signature}`;

  const response = await fetch(sa.token_uri!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(
      `Google OAuth token request failed (${response.status}): ${await readErrorBody(response)}`,
    );
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error('Google OAuth token response did not include an access_token.');
  }
  return data.access_token;
}

interface GoogleDocAiDocument {
  text?: string;
  pages?: Array<Record<string, unknown>>;
}

function mapPages(text: string, doc: GoogleDocAiDocument): OcrPageResult[] | undefined {
  if (!Array.isArray(doc.pages)) return undefined;
  return doc.pages.map((page, idx) => {
    const pageNumber =
      typeof page.pageNumber === 'number' ? page.pageNumber : idx + 1;
    // Document AI returns text via text-anchor offsets; cheaper to skip and
    // expose the whole document text for now.
    return {
      pageNumber,
      text,
      width:
        typeof (page.dimension as Record<string, unknown> | undefined)?.width === 'number'
          ? ((page.dimension as Record<string, number>).width)
          : undefined,
      height:
        typeof (page.dimension as Record<string, unknown> | undefined)?.height === 'number'
          ? ((page.dimension as Record<string, number>).height)
          : undefined,
    };
  });
}

function createDocAiRuntime(opts: {
  serviceAccountKey: ReturnType<typeof parseServiceAccountKey>;
  projectId: string;
  location: string;
  processorId: string;
}): OcrRuntime {
  return {
    async extract(input: OcrExtractInput): Promise<OcrResult> {
      if (input.document.kind === 'url') {
        throw new Error(
          'Google Document AI requires inline document bytes; URL sources are not supported by this contract.',
        );
      }

      const accessToken = await fetchGoogleAccessToken(opts.serviceAccountKey);
      const url = `https://${opts.location}-documentai.googleapis.com/v1/projects/${opts.projectId}/locations/${opts.location}/processors/${opts.processorId}:process`;

      const body: Record<string, unknown> = {
        rawDocument: {
          content: input.document.data.toString('base64'),
          mimeType: input.document.contentType || 'application/pdf',
        },
      };
      if (input.pages && input.pages.length > 0) {
        body.processOptions = {
          individualPageSelector: { pages: input.pages },
        };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(
          `Google Document AI failed (${response.status}): ${await readErrorBody(response)}`,
        );
      }

      const raw = (await response.json()) as Record<string, unknown>;
      const doc = (raw.document as GoogleDocAiDocument | undefined) ?? {};
      const text = typeof doc.text === 'string' ? doc.text : '';
      const pages = mapPages(text, doc);

      return {
        text,
        pages,
        language: input.language,
        usage: {
          pages: pages?.length,
          inputBytes: input.document.data.byteLength,
        },
        invokedVia: 'native',
        raw,
      };
    },
  };
}

export const GoogleDocumentAiProviderContract: ProviderContract<
  ModelProviderRuntime,
  GoogleDocAiCredentials,
  GoogleDocAiSettings
> = {
  id: 'google-document-ai',
  version: '1.0.0',
  domains: ['ocr'],
  display: {
    label: 'Google Document AI',
    description:
      'Google Cloud Document AI processors (OCR / Form / Layout). Configure projectId, location, and processorId.',
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
            name: 'serviceAccountKey',
            label: 'Service Account JSON',
            type: 'textarea',
            required: true,
            description: 'Service account key JSON with Document AI access.',
          },
        ],
      },
      {
        title: 'Settings',
        fields: [
          {
            name: 'projectId',
            label: 'GCP Project ID',
            type: 'text',
            required: true,
            scope: 'settings',
          },
          {
            name: 'location',
            label: 'Location',
            type: 'text',
            required: true,
            placeholder: 'us | eu',
            scope: 'settings',
          },
          {
            name: 'processorId',
            label: 'Processor ID',
            type: 'text',
            required: true,
            placeholder: 'abcdef1234567890',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  createRuntime: ({ credentials, settings }) => {
    const sa = parseServiceAccountKey(credentials.serviceAccountKey);
    const projectId = settings.projectId?.trim();
    const location = settings.location?.trim();
    const processorId = settings.processorId?.trim();
    if (!projectId) throw new Error('Google Document AI projectId is required.');
    if (!location) throw new Error('Google Document AI location is required.');
    if (!processorId) throw new Error('Google Document AI processorId is required.');

    const runtime: ModelProviderRuntime = {
      createOcrRuntime: () =>
        createDocAiRuntime({
          serviceAccountKey: sa,
          projectId,
          location,
          processorId,
        }),
    };

    return runtime;
  },
};
