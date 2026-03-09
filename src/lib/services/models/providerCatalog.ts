import { ProviderDefinition } from './types';

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description:
      'Official OpenAI platform supporting GPT-4.1, GPT-4o, and text-embedding models.',
    categories: ['llm', 'embedding'],
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
      'Any API that follows the OpenAI REST schema (e.g., Mistral, Groq, Cerebras).',
    categories: ['llm', 'embedding'],
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
      'Bedrock Converse API supporting Anthropic, AI21, and other foundation models.',
    categories: ['llm', 'embedding'],
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
      'Vertex AI generative and embedding models using service account credentials.',
    categories: ['llm', 'embedding'],
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
      'Microsoft Azure-hosted OpenAI models with deployment-based access.',
    categories: ['llm', 'embedding'],
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
    id: 'ollama',
    label: 'Ollama',
    description:
      'Locally hosted open-source models via the Ollama runtime.',
    categories: ['llm', 'embedding'],
    credentialFields: [
      {
        name: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        required: true,
        placeholder: 'http://localhost:11434',
        description: 'URL of the running Ollama server.',
      },
    ],
    defaultPricingCurrency: 'USD',
    supportsCustomBaseUrl: true,
    modelIdHint: 'e.g., llama3:instruct, nomic-embed-text',
  },
  {
    id: 'cognipeer-llm',
    label: 'Cognipeer LLM',
    description:
      'Custom self-hosted LLM accessible via an HTTP chat endpoint.',
    categories: ['llm'],
    credentialFields: [
      {
        name: 'url',
        label: 'Endpoint URL',
        type: 'text',
        required: true,
        placeholder: 'http://localhost:8080',
        description: 'Base URL of the Cognipeer LLM server (without /api/chat).',
      },
    ],
    defaultPricingCurrency: 'USD',
    modelIdHint: 'e.g., my-custom-model',
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
];
