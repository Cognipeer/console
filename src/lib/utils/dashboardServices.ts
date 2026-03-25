import {
  IconApi,
  IconBell,
  IconBook2,
  IconBrain,
  IconBulb,
  IconFolder,
  IconKey,
  IconLayoutDashboard,
  IconLock,
  IconPlug,
  IconRobot,
  IconServerBolt,
  IconShield,
  IconSparkles,
  IconTimeline,
  IconTool,
  IconUsers,
  IconVectorBezier,
} from '@tabler/icons-react';

export type DashboardServiceCategory = 'build' | 'data' | 'operate' | 'admin';

export type DashboardServiceDefinition = {
  id: string;
  href: string;
  navLabelKey: string;
  navDescriptionKey: string;
  icon: typeof IconBrain;
  category: DashboardServiceCategory;
  tags: string[];
  searchKeywords: string[];
  showInServicesHome?: boolean;
  tenantAdminOnly?: boolean;
};

const DASHBOARD_SERVICE_DEFINITIONS: DashboardServiceDefinition[] = [
  {
    id: 'services-home',
    href: '/dashboard',
    navLabelKey: 'servicesHome',
    navDescriptionKey: 'servicesHomeDescription',
    icon: IconLayoutDashboard,
    category: 'operate',
    tags: ['services', 'home'],
    searchKeywords: ['services', 'home', 'modules', 'ana sayfa'],
    showInServicesHome: false,
  },
  {
    id: 'models',
    href: '/dashboard/models',
    navLabelKey: 'models',
    navDescriptionKey: 'modelsDescription',
    icon: IconBrain,
    category: 'build',
    tags: ['llm', 'providers', 'inference'],
    searchKeywords: ['model', 'llm', 'ai', 'gpt', 'openai', 'bedrock'],
  },
  {
    id: 'prompts',
    href: '/dashboard/prompts',
    navLabelKey: 'prompts',
    navDescriptionKey: 'promptsDescription',
    icon: IconSparkles,
    category: 'build',
    tags: ['templates', 'prompting'],
    searchKeywords: ['prompt', 'template', 'şablon'],
  },
  {
    id: 'vector',
    href: '/dashboard/vector',
    navLabelKey: 'vector',
    navDescriptionKey: 'vectorDescription',
    icon: IconVectorBezier,
    category: 'data',
    tags: ['indexes', 'embeddings'],
    searchKeywords: ['vector', 'embedding', 'pinecone', 'rag'],
  },
  {
    id: 'memory',
    href: '/dashboard/memory',
    navLabelKey: 'memory',
    navDescriptionKey: 'memoryDescription',
    icon: IconBulb,
    category: 'data',
    tags: ['semantic', 'memory', 'stores'],
    searchKeywords: ['memory', 'semantic', 'store', 'agent memory'],
  },
  {
    id: 'files',
    href: '/dashboard/files',
    navLabelKey: 'files',
    navDescriptionKey: 'filesDescription',
    icon: IconFolder,
    category: 'data',
    tags: ['storage', 'uploads'],
    searchKeywords: ['file', 'dosya', 'upload', 'storage'],
  },
  {
    id: 'rag',
    href: '/dashboard/rag',
    navLabelKey: 'rag',
    navDescriptionKey: 'ragDescription',
    icon: IconBook2,
    category: 'data',
    tags: ['knowledge', 'retrieval', 'documents'],
    searchKeywords: ['rag', 'knowledge', 'retrieval', 'documents'],
  },
  {
    id: 'agents',
    href: '/dashboard/agents',
    navLabelKey: 'agents',
    navDescriptionKey: 'agentsDescription',
    icon: IconRobot,
    category: 'build',
    tags: ['agents', 'orchestration'],
    searchKeywords: ['agent', 'multi-agent', 'orchestration'],
  },
  {
    id: 'config',
    href: '/dashboard/config',
    navLabelKey: 'config',
    navDescriptionKey: 'configDescription',
    icon: IconLock,
    category: 'admin',
    tags: ['config', 'secrets'],
    searchKeywords: ['config', 'configuration', 'secret', 'settings'],
  },
  {
    id: 'tracing',
    href: '/dashboard/tracing',
    navLabelKey: 'agentTracing',
    navDescriptionKey: 'agentTracingDescription',
    icon: IconTimeline,
    category: 'operate',
    tags: ['observability', 'sessions'],
    searchKeywords: ['trace', 'agent', 'log', 'debug'],
  },
  {
    id: 'inference-monitoring',
    href: '/dashboard/inference-monitoring',
    navLabelKey: 'inferenceMonitoring',
    navDescriptionKey: 'inferenceMonitoringDescription',
    icon: IconServerBolt,
    category: 'operate',
    tags: ['vllm', 'gpu', 'inference', 'monitoring'],
    searchKeywords: ['inference', 'monitoring', 'vllm', 'server', 'gpu'],
  },
  {
    id: 'guardrails',
    href: '/dashboard/guardrails',
    navLabelKey: 'guardrails',
    navDescriptionKey: 'guardrailsDescription',
    icon: IconShield,
    category: 'operate',
    tags: ['safety', 'pii', 'moderation', 'prompt injection'],
    searchKeywords: ['guardrails', 'safety', 'moderation', 'pii'],
  },
  {
    id: 'mcp',
    href: '/dashboard/mcp',
    navLabelKey: 'mcp',
    navDescriptionKey: 'mcpDescription',
    icon: IconApi,
    category: 'build',
    tags: ['mcp', 'servers', 'openapi'],
    searchKeywords: ['mcp', 'openapi', 'swagger', 'tool', 'server', 'proxy', 'api'],
  },
  {
    id: 'tools',
    href: '/dashboard/tools',
    navLabelKey: 'tools',
    navDescriptionKey: 'toolsDescription',
    icon: IconTool,
    category: 'build',
    tags: ['tools', 'actions', 'integrations'],
    searchKeywords: ['tool', 'action', 'openapi', 'mcp', 'execute', 'api'],
  },
  {
    id: 'alerts',
    href: '/dashboard/alerts',
    navLabelKey: 'alerts',
    navDescriptionKey: 'alertsDescription',
    icon: IconBell,
    category: 'operate',
    tags: ['thresholds', 'notifications', 'incidents'],
    searchKeywords: ['alert', 'incident', 'notifications', 'threshold'],
  },
  {
    id: 'members',
    href: '/dashboard/members',
    navLabelKey: 'members',
    navDescriptionKey: 'membersDescription',
    icon: IconUsers,
    category: 'admin',
    tags: ['users', 'invite', 'roles'],
    searchKeywords: ['members', 'users', 'invite', 'tenant', 'üyeler'],
    tenantAdminOnly: true,
  },
  {
    id: 'projects',
    href: '/dashboard/projects',
    navLabelKey: 'projects',
    navDescriptionKey: 'projectsDescription',
    icon: IconLayoutDashboard,
    category: 'operate',
    tags: ['workspaces', 'access'],
    searchKeywords: ['project', 'proje'],
  },
  {
    id: 'providers',
    href: '/dashboard/providers',
    navLabelKey: 'providers',
    navDescriptionKey: 'providersDescription',
    icon: IconPlug,
    category: 'admin',
    tags: ['providers', 'integrations'],
    searchKeywords: ['providers', 'integrations', 'sağlayıcılar'],
    tenantAdminOnly: true,
  },
  {
    id: 'tokens',
    href: '/dashboard/tokens',
    navLabelKey: 'tokens',
    navDescriptionKey: 'tokensDescription',
    icon: IconKey,
    category: 'admin',
    tags: ['api', 'tokens', 'keys'],
    searchKeywords: ['token', 'api', 'key', 'anahtar'],
  },
];

type DashboardServicesOptions = {
  isTenantAdmin?: boolean;
  servicesHomeOnly?: boolean;
};

export function getDashboardServices(options: DashboardServicesOptions = {}) {
  const { isTenantAdmin = false, servicesHomeOnly = false } = options;

  return DASHBOARD_SERVICE_DEFINITIONS.filter((service) => {
    if (service.tenantAdminOnly && !isTenantAdmin) {
      return false;
    }

    if (servicesHomeOnly && service.showInServicesHome === false) {
      return false;
    }

    return true;
  });
}
