export type SdkDocId =
  | 'getting-started'
  | 'guide-authentication'
  | 'api-client'
  | 'api-chat'
  | 'api-embeddings'
  | 'api-vectors'
  | 'api-files'
  | 'api-tracing'
  | 'examples-chat'
  | 'examples-embeddings'
  | 'examples-files'
  | 'examples-tracing'
  | 'examples-rag';

export type ModuleDocTarget =
  | 'dashboard'
  | 'models'
  | 'vector'
  | 'files'
  | 'tracing'
  | 'tokens'
  | 'settings'
  | 'tenant-settings';

const SDK_DOCS_BASE_URL = 'https://cognipeer.github.io/cgate-sdk';

const DOCS: Record<SdkDocId, { title: string; url: string }> = {
  'getting-started': {
    title: 'Getting Started',
    url: `${SDK_DOCS_BASE_URL}/guide/getting-started.html`,
  },
  'guide-authentication': {
    title: 'Authentication',
    url: `${SDK_DOCS_BASE_URL}/guide/authentication.html`,
  },
  'api-client': {
    title: 'Client API',
    url: `${SDK_DOCS_BASE_URL}/api/client.html`,
  },
  'api-chat': {
    title: 'Chat API',
    url: `${SDK_DOCS_BASE_URL}/api/chat.html`,
  },
  'api-embeddings': {
    title: 'Embeddings API',
    url: `${SDK_DOCS_BASE_URL}/api/embeddings.html`,
  },
  'api-vectors': {
    title: 'Vectors API',
    url: `${SDK_DOCS_BASE_URL}/api/vectors.html`,
  },
  'api-files': {
    title: 'Files API',
    url: `${SDK_DOCS_BASE_URL}/api/files.html`,
  },
  'api-tracing': {
    title: 'Tracing API',
    url: `${SDK_DOCS_BASE_URL}/api/tracing.html`,
  },
  'examples-chat': {
    title: 'Chat Examples',
    url: `${SDK_DOCS_BASE_URL}/examples/chat.html`,
  },
  'examples-embeddings': {
    title: 'Embeddings Examples',
    url: `${SDK_DOCS_BASE_URL}/examples/embeddings.html`,
  },
  'examples-files': {
    title: 'Files Examples',
    url: `${SDK_DOCS_BASE_URL}/examples/files.html`,
  },
  'examples-tracing': {
    title: 'Tracing Examples',
    url: `${SDK_DOCS_BASE_URL}/examples/tracing.html`,
  },
  'examples-rag': {
    title: 'RAG Example',
    url: `${SDK_DOCS_BASE_URL}/examples/rag.html`,
  },
};

export const DEFAULT_SDK_DOC: SdkDocId = 'getting-started';

export function isSdkDocId(value: string): value is SdkDocId {
  return Object.prototype.hasOwnProperty.call(DOCS, value);
}

export function resolveSdkDoc(docId?: string | null): {
  id: SdkDocId;
  title: string;
  url: string;
} {
  const normalized = typeof docId === 'string' ? docId : undefined;
  const id = normalized && isSdkDocId(normalized) ? normalized : DEFAULT_SDK_DOC;
  return { id, ...DOCS[id] };
}

export function getModuleDocId(module: ModuleDocTarget): SdkDocId {
  switch (module) {
    case 'models':
      return 'api-client';
    case 'vector':
      return 'api-vectors';
    case 'files':
      return 'api-files';
    case 'tracing':
      return 'api-tracing';
    case 'tokens':
      return 'guide-authentication';
    case 'settings':
    case 'tenant-settings':
      return 'getting-started';
    case 'dashboard':
    default:
      return 'getting-started';
  }
}

export function buildDocsHref(docId: SdkDocId): string {
  return `/dashboard/docs?doc=${encodeURIComponent(docId)}`;
}
