/**
 * Internal MCP provider: Knowledge Base (RAG module).
 *
 * Exposes a single grounded Q&A tool ("ask") backed by `answerWithRag`, so a
 * Knowledge Base can be published as an MCP tool without hand-writing an
 * OpenAPI spec. One provider instance = one RAG module = one MCP tool.
 */

import { listRagModules, getRagModule } from '@/lib/services/rag/ragService';
import { answerWithRag } from '@/lib/services/rag/ragAnswerService';
import type {
  InternalMcpInstanceOption,
  InternalMcpProvider,
  InternalMcpProviderContext,
} from './types';

const TOOL_NAME = 'ask';

function askInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to answer from this knowledge base.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  };
}

export const knowledgeBaseProvider: InternalMcpProvider = {
  id: 'knowledge-base',
  label: 'Knowledge Base',
  description: 'Publish a Knowledge Base as a grounded question-answering MCP tool.',
  configFields: [
    {
      key: 'answerModelKey',
      label: 'Answer model',
      type: 'model',
      required: true,
      modelCategory: 'chat',
      hint: 'The chat model used to generate the grounded answer.',
    },
  ],

  async listInstances(ctx: InternalMcpProviderContext): Promise<InternalMcpInstanceOption[]> {
    const modules = await listRagModules(ctx.tenantDbName, {
      projectId: ctx.projectId,
      status: 'active',
    });
    return modules.map((m) => ({
      key: m.key,
      label: m.name,
      description: m.description,
    }));
  },

  async validateInstance(ctx, instanceKey, config) {
    const ragModule = await getRagModule(ctx.tenantDbName, instanceKey, ctx.projectId);
    if (!ragModule) {
      throw new Error(`Knowledge Base "${instanceKey}" not found`);
    }
    const answerModelKey = config.answerModelKey;
    if (typeof answerModelKey !== 'string' || !answerModelKey.trim()) {
      throw new Error('answerModelKey is required for the Knowledge Base provider');
    }
  },

  async buildTools(ctx, instanceKey, _config) {
    const ragModule = await getRagModule(ctx.tenantDbName, instanceKey, ctx.projectId);
    const label = ragModule?.name ?? instanceKey;
    const description = ragModule?.description
      ? `Ask a question and get a grounded answer from the "${label}" knowledge base. ${ragModule.description}`
      : `Ask a question and get a grounded answer from the "${label}" knowledge base.`;
    return {
      tools: [
        {
          name: TOOL_NAME,
          description,
          inputSchema: askInputSchema(),
        },
      ],
      suggestedName: label,
      suggestedDescription: ragModule?.description,
    };
  },

  async execute(ctx, instanceKey, config, toolName, args) {
    if (toolName !== TOOL_NAME) {
      throw new Error(`Unknown tool "${toolName}" on Knowledge Base provider`);
    }
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    if (!question) {
      throw new Error('"question" is required');
    }
    const answerModelKey = config.answerModelKey;
    if (typeof answerModelKey !== 'string' || !answerModelKey.trim()) {
      throw new Error('This Knowledge Base tool is missing its configured answer model');
    }
    const result = await answerWithRag(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
      ragModuleKey: instanceKey,
      question,
      answerModelKey,
    });
    return {
      answer: result.answer,
      citations: result.citations,
    };
  },
};
