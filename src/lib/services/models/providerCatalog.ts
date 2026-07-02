import { ProviderDefinition } from './types';

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description:
      'Official OpenAI platform supporting GPT-4.1, GPT-4o, text-embedding, Whisper (STT), TTS, and VLM-OCR.',
    categories: ['llm', 'embedding', 'stt', 'tts', 'ocr'],
    credentialFields: [
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 'sk-...',
      },
      {
        name: 'organization',
        label: 'Organization ID',
        type: 'text',
        required: false,
        description: 'Optional organization ID to scope requests.',
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., gpt-4.1, gpt-4o-mini, text-embedding-3-large',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-Compatible',
    description:
      'Any API following the OpenAI REST schema (Mistral, Groq, Cerebras, Deepgram/ElevenLabs OpenAI-mode, …). Also supports /v1/rerank and /v1/audio/*.',
    categories: ['llm', 'embedding', 'rerank', 'stt', 'tts', 'ocr'],
    credentialFields: [
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
      },
      {
        name: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        required: true,
        placeholder: 'https://api.your-provider.com/v1',
        description: 'Base URL for the OpenAI-compatible API.',
      },
      {
        name: 'organization',
        label: 'Organization',
        type: 'text',
        required: false,
        description: 'Optional organization or workspace identifier.',
      },
    ],
    defaultPricingCurrency: 'USD',
    supportsCustomBaseUrl: true,
    modelIdHint: 'e.g., mistral-large-latest, llama3-70b-8192',
  },
  {
    id: 'together',
    label: 'Together AI',
    description:
      'Together AI APIs for hosted open models with tool calling support.',
    categories: ['llm', 'embedding'],
    credentialFields: [
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., meta-llama/Llama-3.1-70B-Instruct-Turbo',
  },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    description:
      'Bedrock Converse API (Anthropic, Nova, AI21, …) and vision models for VLM-OCR.',
    categories: ['llm', 'embedding', 'ocr'],
    credentialFields: [
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
        name: 'region',
        label: 'Region',
        type: 'select',
        required: true,
        options: [
          { label: 'us-east-1', value: 'us-east-1' },
          { label: 'us-west-2', value: 'us-west-2' },
          { label: 'eu-central-1', value: 'eu-central-1' },
          { label: 'ap-southeast-1', value: 'ap-southeast-1' },
        ],
      },
      {
        name: 'sessionToken',
        label: 'AWS Session Token',
        type: 'password',
        required: false,
        description: 'Optional if using temporary credentials.',
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint:
      'e.g., anthropic.claude-3-sonnet-20240229-v1:0, amazon.titan-text-express-v1',
  },
  {
    id: 'vertex',
    label: 'Google Vertex AI',
    description:
      'Vertex AI generative, embedding, and multimodal (Gemini) models. Gemini supports VLM-OCR.',
    categories: ['llm', 'embedding', 'ocr'],
    credentialFields: [
      {
        name: 'projectId',
        label: 'Project ID',
        type: 'text',
        required: true,
      },
      {
        name: 'location',
        label: 'Location',
        type: 'text',
        required: true,
        placeholder: 'us-central1',
      },
      {
        name: 'serviceAccountKey',
        label: 'Service Account JSON',
        type: 'password',
        required: true,
        description: 'Service account key JSON string with Vertex permissions.',
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., gemini-1.5-pro, text-embedding-004',
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    description:
      'Microsoft Azure-hosted OpenAI models (incl. Whisper / TTS deployments) and VLM-OCR.',
    categories: ['llm', 'embedding', 'stt', 'tts', 'ocr'],
    credentialFields: [
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
      },
      {
        name: 'instanceName',
        label: 'Instance Name',
        type: 'text',
        required: true,
        placeholder: 'my-resource',
        description: 'Azure OpenAI resource name (subdomain of openai.azure.com).',
      },
      {
        name: 'deploymentName',
        label: 'Deployment Name',
        type: 'text',
        required: true,
        placeholder: 'gpt-4o-deployment',
        description: 'The deployment name created in Azure OpenAI Studio.',
      },
      {
        name: 'apiVersion',
        label: 'API Version',
        type: 'text',
        required: true,
        placeholder: '2024-08-01-preview',
        description: 'Azure OpenAI API version string.',
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., gpt-4o, gpt-4o-mini',
  },
  {
    id: 'system-openai',
    label: 'System OpenAI',
    description:
      'OpenAI models using platform-managed API credentials (SYSTEM_OPENAI_API_KEY). No user credentials required.',
    categories: ['llm', 'embedding'],
    credentialFields: [],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., gpt-4o-2024-08-06, o3, text-embedding-3-large',
  },
  {
    id: 'system-bedrock',
    label: 'System Bedrock',
    description:
      'AWS Bedrock models using platform-managed credentials (SYSTEM_BEDROCK_*). No user credentials required.',
    categories: ['llm', 'embedding'],
    credentialFields: [],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., anthropic.claude-3-7-sonnet-v1:0, amazon.nova-pro-v1:0',
  },
  {
    id: 'system-together',
    label: 'System Together AI',
    description:
      'Together AI models using platform-managed API credentials (SYSTEM_TOGETHER_API_KEY). No user credentials required.',
    categories: ['llm', 'embedding'],
    credentialFields: [],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., deepseek-ai/DeepSeek-R1, meta-llama/Llama-4-Scout-17B-16E-Instruct',
  },
  {
    id: 'system-vertex',
    label: 'System Vertex AI',
    description:
      'Google Vertex AI models using platform-managed service account (SYSTEM_VERTEX_*). No user credentials required.',
    categories: ['llm', 'embedding'],
    credentialFields: [],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., gemini-2.5-pro, gemini-2.5-flash',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    description:
      'Cohere dedicated rerank models (rerank-v3.5, rerank-multilingual-v3.0).',
    categories: ['rerank'],
    credentialFields: [
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., rerank-v3.5, rerank-multilingual-v3.0, command-r-plus',
  },
  {
    id: 'jina-ai',
    label: 'Jina AI',
    description:
      'Jina AI rerankers (jina-reranker-v2-base-multilingual).',
    categories: ['rerank'],
    credentialFields: [
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., jina-reranker-v2-base-multilingual, jina-embeddings-v3',
  },
  {
    id: 'voyage-ai',
    label: 'Voyage AI',
    description:
      'Voyage AI rerank models (rerank-2, rerank-2-lite).',
    categories: ['rerank'],
    credentialFields: [
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., rerank-2, rerank-2-lite, voyage-3',
  },
  {
    id: 'mistral-ocr',
    label: 'Mistral OCR',
    description:
      'Mistral Document AI / OCR endpoint with native PDF and image extraction.',
    categories: ['ocr'],
    credentialFields: [
      {
        name: 'apiKey',
        label: 'Mistral API Key',
        type: 'password',
        required: true,
      },
      {
        name: 'baseUrl',
        label: 'Base URL (optional)',
        type: 'text',
        required: false,
        placeholder: 'https://api.mistral.ai/v1',
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., mistral-ocr-latest',
  },
  {
    id: 'azure-document-intelligence',
    label: 'Azure Document Intelligence',
    description:
      'Azure Document Intelligence (Form Recognizer) — native OCR with layout, tables, and key-value extraction.',
    categories: ['ocr'],
    credentialFields: [
      {
        name: 'apiKey',
        label: 'Azure Subscription Key',
        type: 'password',
        required: true,
      },
      {
        name: 'endpoint',
        label: 'Endpoint URL',
        type: 'text',
        required: true,
        placeholder: 'https://<your-resource>.cognitiveservices.azure.com',
      },
      {
        name: 'apiVersion',
        label: 'API Version',
        type: 'text',
        required: false,
        placeholder: '2024-11-30',
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., prebuilt-read, prebuilt-layout, prebuilt-document, prebuilt-invoice',
  },
  {
    id: 'aws-textract',
    label: 'AWS Textract',
    description:
      'Amazon Textract OCR. modelId controls operation: "detect-document-text" or "analyze-document".',
    categories: ['ocr'],
    credentialFields: [
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
      },
      {
        name: 'sessionToken',
        label: 'AWS Session Token',
        type: 'password',
        required: false,
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'detect-document-text | analyze-document',
  },
  {
    id: 'google-document-ai',
    label: 'Google Document AI',
    description:
      'Google Cloud Document AI processors (OCR, Layout, Form Parser). Requires projectId, location, and processorId.',
    categories: ['ocr'],
    credentialFields: [
      {
        name: 'serviceAccountKey',
        label: 'Service Account JSON',
        type: 'password',
        required: true,
        description: 'Service account key JSON with Document AI access.',
      },
      {
        name: 'projectId',
        label: 'GCP Project ID',
        type: 'text',
        required: true,
      },
      {
        name: 'location',
        label: 'Location',
        type: 'text',
        required: true,
        placeholder: 'us | eu',
      },
      {
        name: 'processorId',
        label: 'Processor ID',
        type: 'text',
        required: true,
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'Processor identifier acts as the model id.',
  },
];
