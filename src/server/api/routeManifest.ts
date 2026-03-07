import type { ApiRouteManifestEntry } from './types';
import * as route0 from './routes/agents/[agentId]/chat/route';
import * as route1 from './routes/agents/[agentId]/conversations/route';
import * as route2 from './routes/agents/[agentId]/publish/route';
import * as route3 from './routes/agents/[agentId]/route';
import * as route4 from './routes/agents/[agentId]/versions/route';
import * as route5 from './routes/agents/route';
import * as route6 from './routes/alerts/history/[eventId]/acknowledge/route';
import * as route7 from './routes/alerts/history/route';
import * as route8 from './routes/alerts/incidents/[incidentId]/notes/route';
import * as route9 from './routes/alerts/incidents/[incidentId]/route';
import * as route10 from './routes/alerts/incidents/route';
import * as route11 from './routes/alerts/rules/[ruleId]/route';
import * as route12 from './routes/alerts/rules/route';
import * as route13 from './routes/auth/change-password/route';
import * as route14 from './routes/auth/forgot-password/route';
import * as route15 from './routes/auth/login/route';
import * as route16 from './routes/auth/logout/route';
import * as route17 from './routes/auth/register/route';
import * as route18 from './routes/auth/reset-password/route';
import * as route19 from './routes/auth/session/route';
import * as route20 from './routes/client/v1/agents/[agentKey]/route';
import * as route21 from './routes/client/v1/agents/responses/route';
import * as route22 from './routes/client/v1/agents/route';
import * as route23 from './routes/client/v1/chat/completions/route';
import * as route24 from './routes/client/v1/config/groups/[groupKey]/items/route';
import * as route25 from './routes/client/v1/config/groups/[groupKey]/route';
import * as route26 from './routes/client/v1/config/groups/route';
import * as route27 from './routes/client/v1/config/items/[key]/audit/route';
import * as route28 from './routes/client/v1/config/items/[key]/route';
import * as route29 from './routes/client/v1/config/items/route';
import * as route30 from './routes/client/v1/config/resolve/route';
import * as route31 from './routes/client/v1/embeddings/route';
import * as route32 from './routes/client/v1/files/buckets/[bucketKey]/objects/[objectKey]/download/route';
import * as route33 from './routes/client/v1/files/buckets/[bucketKey]/objects/[objectKey]/route';
import * as route34 from './routes/client/v1/files/buckets/[bucketKey]/objects/route';
import * as route35 from './routes/client/v1/files/buckets/[bucketKey]/route';
import * as route36 from './routes/client/v1/files/buckets/route';
import * as route37 from './routes/client/v1/files/providers/route';
import * as route38 from './routes/client/v1/guardrails/evaluate/route';
import * as route39 from './routes/client/v1/mcp/[serverKey]/execute/route';
import * as route40 from './routes/client/v1/mcp/[serverKey]/message/route';
import * as route41 from './routes/client/v1/mcp/[serverKey]/sse/route';
import * as route42 from './routes/client/v1/memory/stores/[storeKey]/memories/[memoryId]/route';
import * as route43 from './routes/client/v1/memory/stores/[storeKey]/memories/batch/route';
import * as route44 from './routes/client/v1/memory/stores/[storeKey]/memories/route';
import * as route45 from './routes/client/v1/memory/stores/[storeKey]/recall/route';
import * as route46 from './routes/client/v1/memory/stores/[storeKey]/route';
import * as route47 from './routes/client/v1/memory/stores/[storeKey]/search/route';
import * as route48 from './routes/client/v1/memory/stores/route';
import * as route49 from './routes/client/v1/prompts/[key]/compare/route';
import * as route50 from './routes/client/v1/prompts/[key]/deployments/route';
import * as route51 from './routes/client/v1/prompts/[key]/render/route';
import * as route52 from './routes/client/v1/prompts/[key]/route';
import * as route53 from './routes/client/v1/prompts/[key]/versions/route';
import * as route54 from './routes/client/v1/prompts/route';
import * as route55 from './routes/client/v1/rag/modules/[key]/documents/[documentId]/route';
import * as route56 from './routes/client/v1/rag/modules/[key]/documents/route';
import * as route57 from './routes/client/v1/rag/modules/[key]/ingest/route';
import * as route58 from './routes/client/v1/rag/modules/[key]/query/route';
import * as route59 from './routes/client/v1/rag/modules/[key]/route';
import * as route60 from './routes/client/v1/rag/modules/route';
import * as route61 from './routes/client/v1/responses/route';
import * as route62 from './routes/client/v1/tools/[toolKey]/actions/[actionKey]/execute/route';
import * as route63 from './routes/client/v1/tools/[toolKey]/route';
import * as route64 from './routes/client/v1/tools/route';
import * as route65 from './routes/client/v1/traces/route';
import * as route66 from './routes/client/v1/tracing/sessions/route';
import * as route67 from './routes/client/v1/tracing/sessions/stream/[sessionId]/end/route';
import * as route68 from './routes/client/v1/tracing/sessions/stream/[sessionId]/events/route';
import * as route69 from './routes/client/v1/tracing/sessions/stream/[sessionId]/start/route';
import * as route70 from './routes/client/v1/vector/providers/[providerKey]/indexes/[externalId]/query/route';
import * as route71 from './routes/client/v1/vector/providers/[providerKey]/indexes/[externalId]/route';
import * as route72 from './routes/client/v1/vector/providers/[providerKey]/indexes/[externalId]/upsert/route';
import * as route73 from './routes/client/v1/vector/providers/[providerKey]/indexes/[externalId]/vectors/route';
import * as route74 from './routes/client/v1/vector/providers/[providerKey]/indexes/route';
import * as route75 from './routes/client/v1/vector/providers/drivers/[driverId]/form/route';
import * as route76 from './routes/client/v1/vector/providers/drivers/route';
import * as route77 from './routes/client/v1/vector/providers/route';
import * as route78 from './routes/config/groups/[groupId]/items/route';
import * as route79 from './routes/config/groups/[groupId]/route';
import * as route80 from './routes/config/groups/route';
import * as route81 from './routes/config/items/[itemId]/route';
import * as route82 from './routes/config/items/route';
import * as route83 from './routes/dashboard/playground/chat/route';
import * as route84 from './routes/dashboard/route';
import * as route85 from './routes/files/buckets/[bucketKey]/objects/[...objectKey]/route';
import * as route86 from './routes/files/buckets/[bucketKey]/objects/route';
import * as route87 from './routes/files/buckets/[bucketKey]/route';
import * as route88 from './routes/files/buckets/route';
import * as route89 from './routes/files/dashboard/route';
import * as route90 from './routes/files/providers/drivers/route';
import * as route91 from './routes/files/providers/route';
import * as route92 from './routes/guardrails/[id]/evaluations/route';
import * as route93 from './routes/guardrails/[id]/route';
import * as route94 from './routes/guardrails/evaluate/route';
import * as route95 from './routes/guardrails/route';
import * as route96 from './routes/health/live/route';
import * as route97 from './routes/health/ready/route';
import * as route98 from './routes/inference-monitoring/dashboard/route';
import * as route99 from './routes/inference-monitoring/servers/[serverKey]/metrics/route';
import * as route100 from './routes/inference-monitoring/servers/[serverKey]/poll/route';
import * as route101 from './routes/inference-monitoring/servers/[serverKey]/route';
import * as route102 from './routes/inference-monitoring/servers/route';
import * as route103 from './routes/mcp/[id]/logs/route';
import * as route104 from './routes/mcp/[id]/route';
import * as route105 from './routes/mcp/route';
import * as route106 from './routes/memory/stores/[storeKey]/memories/route';
import * as route107 from './routes/memory/stores/[storeKey]/route';
import * as route108 from './routes/memory/stores/route';
import * as route109 from './routes/metrics/route';
import * as route110 from './routes/models/[id]/logs/route';
import * as route111 from './routes/models/[id]/route';
import * as route112 from './routes/models/[id]/usage/route';
import * as route113 from './routes/models/dashboard/route';
import * as route114 from './routes/models/providers/drivers/[driverId]/form/route';
import * as route115 from './routes/models/providers/drivers/route';
import * as route116 from './routes/models/providers/route';
import * as route117 from './routes/models/route';
import * as route118 from './routes/projects/[projectId]/member-candidates/route';
import * as route119 from './routes/projects/[projectId]/members/route';
import * as route120 from './routes/projects/[projectId]/route';
import * as route121 from './routes/projects/[projectId]/tokens/[id]/route';
import * as route122 from './routes/projects/[projectId]/tokens/route';
import * as route123 from './routes/projects/active/route';
import * as route124 from './routes/projects/route';
import * as route125 from './routes/prompts/[id]/comments/[commentId]/route';
import * as route126 from './routes/prompts/[id]/comments/route';
import * as route127 from './routes/prompts/[id]/compare/route';
import * as route128 from './routes/prompts/[id]/deployments/route';
import * as route129 from './routes/prompts/[id]/route';
import * as route130 from './routes/prompts/[id]/versions/route';
import * as route131 from './routes/prompts/route';
import * as route132 from './routes/prompts/stats/route';
import * as route133 from './routes/providers/[id]/route';
import * as route134 from './routes/providers/drivers/[driverId]/form/route';
import * as route135 from './routes/providers/drivers/route';
import * as route136 from './routes/providers/route';
import * as route137 from './routes/quota/defaults/route';
import * as route138 from './routes/quota/policies/[id]/route';
import * as route139 from './routes/quota/policies/route';
import * as route140 from './routes/rag/modules/[key]/documents/[documentId]/route';
import * as route141 from './routes/rag/modules/[key]/documents/route';
import * as route142 from './routes/rag/modules/[key]/query/route';
import * as route143 from './routes/rag/modules/[key]/route';
import * as route144 from './routes/rag/modules/[key]/usage/route';
import * as route145 from './routes/rag/modules/route';
import * as route146 from './routes/tokens/[id]/route';
import * as route147 from './routes/tokens/route';
import * as route148 from './routes/tools/[toolId]/actions/[actionKey]/execute/route';
import * as route149 from './routes/tools/[toolId]/logs/route';
import * as route150 from './routes/tools/[toolId]/route';
import * as route151 from './routes/tools/route';
import * as route152 from './routes/tracing/agents/[agentName]/overview/route';
import * as route153 from './routes/tracing/dashboard/route';
import * as route154 from './routes/tracing/sessions/[sessionId]/route';
import * as route155 from './routes/tracing/sessions/route';
import * as route156 from './routes/tracing/threads/[threadId]/route';
import * as route157 from './routes/tracing/threads/route';
import * as route158 from './routes/users/[id]/route';
import * as route159 from './routes/users/invite/route';
import * as route160 from './routes/users/route';
import * as route161 from './routes/vector/dashboard/route';
import * as route162 from './routes/vector/indexes/[externalId]/query/route';
import * as route163 from './routes/vector/indexes/[externalId]/route';
import * as route164 from './routes/vector/indexes/[externalId]/stats/route';
import * as route165 from './routes/vector/indexes/[externalId]/upsert/route';
import * as route166 from './routes/vector/indexes/[externalId]/vectors/route';
import * as route167 from './routes/vector/indexes/route';
import * as route168 from './routes/vector/providers/drivers/[driverId]/form/route';
import * as route169 from './routes/vector/providers/drivers/route';
import * as route170 from './routes/vector/providers/route';

export const apiRouteManifest: ApiRouteManifestEntry[] = [
  {
    importPath: './routes/agents/[agentId]/chat/route',
    routePath: '/agents/:agentId/chat',
    module: route0,
  },
  {
    importPath: './routes/agents/[agentId]/conversations/route',
    routePath: '/agents/:agentId/conversations',
    module: route1,
  },
  {
    importPath: './routes/agents/[agentId]/publish/route',
    routePath: '/agents/:agentId/publish',
    module: route2,
  },
  {
    importPath: './routes/agents/[agentId]/route',
    routePath: '/agents/:agentId',
    module: route3,
  },
  {
    importPath: './routes/agents/[agentId]/versions/route',
    routePath: '/agents/:agentId/versions',
    module: route4,
  },
  {
    importPath: './routes/agents/route',
    routePath: '/agents',
    module: route5,
  },
  {
    importPath: './routes/alerts/history/[eventId]/acknowledge/route',
    routePath: '/alerts/history/:eventId/acknowledge',
    module: route6,
  },
  {
    importPath: './routes/alerts/history/route',
    routePath: '/alerts/history',
    module: route7,
  },
  {
    importPath: './routes/alerts/incidents/[incidentId]/notes/route',
    routePath: '/alerts/incidents/:incidentId/notes',
    module: route8,
  },
  {
    importPath: './routes/alerts/incidents/[incidentId]/route',
    routePath: '/alerts/incidents/:incidentId',
    module: route9,
  },
  {
    importPath: './routes/alerts/incidents/route',
    routePath: '/alerts/incidents',
    module: route10,
  },
  {
    importPath: './routes/alerts/rules/[ruleId]/route',
    routePath: '/alerts/rules/:ruleId',
    module: route11,
  },
  {
    importPath: './routes/alerts/rules/route',
    routePath: '/alerts/rules',
    module: route12,
  },
  {
    importPath: './routes/auth/change-password/route',
    routePath: '/auth/change-password',
    module: route13,
  },
  {
    importPath: './routes/auth/forgot-password/route',
    routePath: '/auth/forgot-password',
    module: route14,
  },
  {
    importPath: './routes/auth/login/route',
    routePath: '/auth/login',
    module: route15,
  },
  {
    importPath: './routes/auth/logout/route',
    routePath: '/auth/logout',
    module: route16,
  },
  {
    importPath: './routes/auth/register/route',
    routePath: '/auth/register',
    module: route17,
  },
  {
    importPath: './routes/auth/reset-password/route',
    routePath: '/auth/reset-password',
    module: route18,
  },
  {
    importPath: './routes/auth/session/route',
    routePath: '/auth/session',
    module: route19,
  },
  {
    importPath: './routes/client/v1/agents/[agentKey]/route',
    routePath: '/client/v1/agents/:agentKey',
    module: route20,
  },
  {
    importPath: './routes/client/v1/agents/responses/route',
    routePath: '/client/v1/agents/responses',
    module: route21,
  },
  {
    importPath: './routes/client/v1/agents/route',
    routePath: '/client/v1/agents',
    module: route22,
  },
  {
    importPath: './routes/client/v1/chat/completions/route',
    routePath: '/client/v1/chat/completions',
    module: route23,
  },
  {
    importPath: './routes/client/v1/config/groups/[groupKey]/items/route',
    routePath: '/client/v1/config/groups/:groupKey/items',
    module: route24,
  },
  {
    importPath: './routes/client/v1/config/groups/[groupKey]/route',
    routePath: '/client/v1/config/groups/:groupKey',
    module: route25,
  },
  {
    importPath: './routes/client/v1/config/groups/route',
    routePath: '/client/v1/config/groups',
    module: route26,
  },
  {
    importPath: './routes/client/v1/config/items/[key]/audit/route',
    routePath: '/client/v1/config/items/:key/audit',
    module: route27,
  },
  {
    importPath: './routes/client/v1/config/items/[key]/route',
    routePath: '/client/v1/config/items/:key',
    module: route28,
  },
  {
    importPath: './routes/client/v1/config/items/route',
    routePath: '/client/v1/config/items',
    module: route29,
  },
  {
    importPath: './routes/client/v1/config/resolve/route',
    routePath: '/client/v1/config/resolve',
    module: route30,
  },
  {
    importPath: './routes/client/v1/embeddings/route',
    routePath: '/client/v1/embeddings',
    module: route31,
  },
  {
    importPath: './routes/client/v1/files/buckets/[bucketKey]/objects/[objectKey]/download/route',
    routePath: '/client/v1/files/buckets/:bucketKey/objects/:objectKey/download',
    module: route32,
  },
  {
    importPath: './routes/client/v1/files/buckets/[bucketKey]/objects/[objectKey]/route',
    routePath: '/client/v1/files/buckets/:bucketKey/objects/:objectKey',
    module: route33,
  },
  {
    importPath: './routes/client/v1/files/buckets/[bucketKey]/objects/route',
    routePath: '/client/v1/files/buckets/:bucketKey/objects',
    module: route34,
  },
  {
    importPath: './routes/client/v1/files/buckets/[bucketKey]/route',
    routePath: '/client/v1/files/buckets/:bucketKey',
    module: route35,
  },
  {
    importPath: './routes/client/v1/files/buckets/route',
    routePath: '/client/v1/files/buckets',
    module: route36,
  },
  {
    importPath: './routes/client/v1/files/providers/route',
    routePath: '/client/v1/files/providers',
    module: route37,
  },
  {
    importPath: './routes/client/v1/guardrails/evaluate/route',
    routePath: '/client/v1/guardrails/evaluate',
    module: route38,
  },
  {
    importPath: './routes/client/v1/mcp/[serverKey]/execute/route',
    routePath: '/client/v1/mcp/:serverKey/execute',
    module: route39,
  },
  {
    importPath: './routes/client/v1/mcp/[serverKey]/message/route',
    routePath: '/client/v1/mcp/:serverKey/message',
    module: route40,
  },
  {
    importPath: './routes/client/v1/mcp/[serverKey]/sse/route',
    routePath: '/client/v1/mcp/:serverKey/sse',
    module: route41,
  },
  {
    importPath: './routes/client/v1/memory/stores/[storeKey]/memories/[memoryId]/route',
    routePath: '/client/v1/memory/stores/:storeKey/memories/:memoryId',
    module: route42,
  },
  {
    importPath: './routes/client/v1/memory/stores/[storeKey]/memories/batch/route',
    routePath: '/client/v1/memory/stores/:storeKey/memories/batch',
    module: route43,
  },
  {
    importPath: './routes/client/v1/memory/stores/[storeKey]/memories/route',
    routePath: '/client/v1/memory/stores/:storeKey/memories',
    module: route44,
  },
  {
    importPath: './routes/client/v1/memory/stores/[storeKey]/recall/route',
    routePath: '/client/v1/memory/stores/:storeKey/recall',
    module: route45,
  },
  {
    importPath: './routes/client/v1/memory/stores/[storeKey]/route',
    routePath: '/client/v1/memory/stores/:storeKey',
    module: route46,
  },
  {
    importPath: './routes/client/v1/memory/stores/[storeKey]/search/route',
    routePath: '/client/v1/memory/stores/:storeKey/search',
    module: route47,
  },
  {
    importPath: './routes/client/v1/memory/stores/route',
    routePath: '/client/v1/memory/stores',
    module: route48,
  },
  {
    importPath: './routes/client/v1/prompts/[key]/compare/route',
    routePath: '/client/v1/prompts/:key/compare',
    module: route49,
  },
  {
    importPath: './routes/client/v1/prompts/[key]/deployments/route',
    routePath: '/client/v1/prompts/:key/deployments',
    module: route50,
  },
  {
    importPath: './routes/client/v1/prompts/[key]/render/route',
    routePath: '/client/v1/prompts/:key/render',
    module: route51,
  },
  {
    importPath: './routes/client/v1/prompts/[key]/route',
    routePath: '/client/v1/prompts/:key',
    module: route52,
  },
  {
    importPath: './routes/client/v1/prompts/[key]/versions/route',
    routePath: '/client/v1/prompts/:key/versions',
    module: route53,
  },
  {
    importPath: './routes/client/v1/prompts/route',
    routePath: '/client/v1/prompts',
    module: route54,
  },
  {
    importPath: './routes/client/v1/rag/modules/[key]/documents/[documentId]/route',
    routePath: '/client/v1/rag/modules/:key/documents/:documentId',
    module: route55,
  },
  {
    importPath: './routes/client/v1/rag/modules/[key]/documents/route',
    routePath: '/client/v1/rag/modules/:key/documents',
    module: route56,
  },
  {
    importPath: './routes/client/v1/rag/modules/[key]/ingest/route',
    routePath: '/client/v1/rag/modules/:key/ingest',
    module: route57,
  },
  {
    importPath: './routes/client/v1/rag/modules/[key]/query/route',
    routePath: '/client/v1/rag/modules/:key/query',
    module: route58,
  },
  {
    importPath: './routes/client/v1/rag/modules/[key]/route',
    routePath: '/client/v1/rag/modules/:key',
    module: route59,
  },
  {
    importPath: './routes/client/v1/rag/modules/route',
    routePath: '/client/v1/rag/modules',
    module: route60,
  },
  {
    importPath: './routes/client/v1/responses/route',
    routePath: '/client/v1/responses',
    module: route61,
  },
  {
    importPath: './routes/client/v1/tools/[toolKey]/actions/[actionKey]/execute/route',
    routePath: '/client/v1/tools/:toolKey/actions/:actionKey/execute',
    module: route62,
  },
  {
    importPath: './routes/client/v1/tools/[toolKey]/route',
    routePath: '/client/v1/tools/:toolKey',
    module: route63,
  },
  {
    importPath: './routes/client/v1/tools/route',
    routePath: '/client/v1/tools',
    module: route64,
  },
  {
    importPath: './routes/client/v1/traces/route',
    routePath: '/client/v1/traces',
    module: route65,
  },
  {
    importPath: './routes/client/v1/tracing/sessions/route',
    routePath: '/client/v1/tracing/sessions',
    module: route66,
  },
  {
    importPath: './routes/client/v1/tracing/sessions/stream/[sessionId]/end/route',
    routePath: '/client/v1/tracing/sessions/stream/:sessionId/end',
    module: route67,
  },
  {
    importPath: './routes/client/v1/tracing/sessions/stream/[sessionId]/events/route',
    routePath: '/client/v1/tracing/sessions/stream/:sessionId/events',
    module: route68,
  },
  {
    importPath: './routes/client/v1/tracing/sessions/stream/[sessionId]/start/route',
    routePath: '/client/v1/tracing/sessions/stream/:sessionId/start',
    module: route69,
  },
  {
    importPath: './routes/client/v1/vector/providers/[providerKey]/indexes/[externalId]/query/route',
    routePath: '/client/v1/vector/providers/:providerKey/indexes/:externalId/query',
    module: route70,
  },
  {
    importPath: './routes/client/v1/vector/providers/[providerKey]/indexes/[externalId]/route',
    routePath: '/client/v1/vector/providers/:providerKey/indexes/:externalId',
    module: route71,
  },
  {
    importPath: './routes/client/v1/vector/providers/[providerKey]/indexes/[externalId]/upsert/route',
    routePath: '/client/v1/vector/providers/:providerKey/indexes/:externalId/upsert',
    module: route72,
  },
  {
    importPath: './routes/client/v1/vector/providers/[providerKey]/indexes/[externalId]/vectors/route',
    routePath: '/client/v1/vector/providers/:providerKey/indexes/:externalId/vectors',
    module: route73,
  },
  {
    importPath: './routes/client/v1/vector/providers/[providerKey]/indexes/route',
    routePath: '/client/v1/vector/providers/:providerKey/indexes',
    module: route74,
  },
  {
    importPath: './routes/client/v1/vector/providers/drivers/[driverId]/form/route',
    routePath: '/client/v1/vector/providers/drivers/:driverId/form',
    module: route75,
  },
  {
    importPath: './routes/client/v1/vector/providers/drivers/route',
    routePath: '/client/v1/vector/providers/drivers',
    module: route76,
  },
  {
    importPath: './routes/client/v1/vector/providers/route',
    routePath: '/client/v1/vector/providers',
    module: route77,
  },
  {
    importPath: './routes/config/groups/[groupId]/items/route',
    routePath: '/config/groups/:groupId/items',
    module: route78,
  },
  {
    importPath: './routes/config/groups/[groupId]/route',
    routePath: '/config/groups/:groupId',
    module: route79,
  },
  {
    importPath: './routes/config/groups/route',
    routePath: '/config/groups',
    module: route80,
  },
  {
    importPath: './routes/config/items/[itemId]/route',
    routePath: '/config/items/:itemId',
    module: route81,
  },
  {
    importPath: './routes/config/items/route',
    routePath: '/config/items',
    module: route82,
  },
  {
    importPath: './routes/dashboard/playground/chat/route',
    routePath: '/dashboard/playground/chat',
    module: route83,
  },
  {
    importPath: './routes/dashboard/route',
    routePath: '/dashboard',
    module: route84,
  },
  {
    importPath: './routes/files/buckets/[bucketKey]/objects/[...objectKey]/route',
    routePath: '/files/buckets/:bucketKey/objects/*',
    catchAllParam: 'objectKey',
    module: route85,
  },
  {
    importPath: './routes/files/buckets/[bucketKey]/objects/route',
    routePath: '/files/buckets/:bucketKey/objects',
    module: route86,
  },
  {
    importPath: './routes/files/buckets/[bucketKey]/route',
    routePath: '/files/buckets/:bucketKey',
    module: route87,
  },
  {
    importPath: './routes/files/buckets/route',
    routePath: '/files/buckets',
    module: route88,
  },
  {
    importPath: './routes/files/dashboard/route',
    routePath: '/files/dashboard',
    module: route89,
  },
  {
    importPath: './routes/files/providers/drivers/route',
    routePath: '/files/providers/drivers',
    module: route90,
  },
  {
    importPath: './routes/files/providers/route',
    routePath: '/files/providers',
    module: route91,
  },
  {
    importPath: './routes/guardrails/[id]/evaluations/route',
    routePath: '/guardrails/:id/evaluations',
    module: route92,
  },
  {
    importPath: './routes/guardrails/[id]/route',
    routePath: '/guardrails/:id',
    module: route93,
  },
  {
    importPath: './routes/guardrails/evaluate/route',
    routePath: '/guardrails/evaluate',
    module: route94,
  },
  {
    importPath: './routes/guardrails/route',
    routePath: '/guardrails',
    module: route95,
  },
  {
    importPath: './routes/health/live/route',
    routePath: '/health/live',
    module: route96,
  },
  {
    importPath: './routes/health/ready/route',
    routePath: '/health/ready',
    module: route97,
  },
  {
    importPath: './routes/inference-monitoring/dashboard/route',
    routePath: '/inference-monitoring/dashboard',
    module: route98,
  },
  {
    importPath: './routes/inference-monitoring/servers/[serverKey]/metrics/route',
    routePath: '/inference-monitoring/servers/:serverKey/metrics',
    module: route99,
  },
  {
    importPath: './routes/inference-monitoring/servers/[serverKey]/poll/route',
    routePath: '/inference-monitoring/servers/:serverKey/poll',
    module: route100,
  },
  {
    importPath: './routes/inference-monitoring/servers/[serverKey]/route',
    routePath: '/inference-monitoring/servers/:serverKey',
    module: route101,
  },
  {
    importPath: './routes/inference-monitoring/servers/route',
    routePath: '/inference-monitoring/servers',
    module: route102,
  },
  {
    importPath: './routes/mcp/[id]/logs/route',
    routePath: '/mcp/:id/logs',
    module: route103,
  },
  {
    importPath: './routes/mcp/[id]/route',
    routePath: '/mcp/:id',
    module: route104,
  },
  {
    importPath: './routes/mcp/route',
    routePath: '/mcp',
    module: route105,
  },
  {
    importPath: './routes/memory/stores/[storeKey]/memories/route',
    routePath: '/memory/stores/:storeKey/memories',
    module: route106,
  },
  {
    importPath: './routes/memory/stores/[storeKey]/route',
    routePath: '/memory/stores/:storeKey',
    module: route107,
  },
  {
    importPath: './routes/memory/stores/route',
    routePath: '/memory/stores',
    module: route108,
  },
  {
    importPath: './routes/metrics/route',
    routePath: '/metrics',
    module: route109,
  },
  {
    importPath: './routes/models/[id]/logs/route',
    routePath: '/models/:id/logs',
    module: route110,
  },
  {
    importPath: './routes/models/[id]/route',
    routePath: '/models/:id',
    module: route111,
  },
  {
    importPath: './routes/models/[id]/usage/route',
    routePath: '/models/:id/usage',
    module: route112,
  },
  {
    importPath: './routes/models/dashboard/route',
    routePath: '/models/dashboard',
    module: route113,
  },
  {
    importPath: './routes/models/providers/drivers/[driverId]/form/route',
    routePath: '/models/providers/drivers/:driverId/form',
    module: route114,
  },
  {
    importPath: './routes/models/providers/drivers/route',
    routePath: '/models/providers/drivers',
    module: route115,
  },
  {
    importPath: './routes/models/providers/route',
    routePath: '/models/providers',
    module: route116,
  },
  {
    importPath: './routes/models/route',
    routePath: '/models',
    module: route117,
  },
  {
    importPath: './routes/projects/[projectId]/member-candidates/route',
    routePath: '/projects/:projectId/member-candidates',
    module: route118,
  },
  {
    importPath: './routes/projects/[projectId]/members/route',
    routePath: '/projects/:projectId/members',
    module: route119,
  },
  {
    importPath: './routes/projects/[projectId]/route',
    routePath: '/projects/:projectId',
    module: route120,
  },
  {
    importPath: './routes/projects/[projectId]/tokens/[id]/route',
    routePath: '/projects/:projectId/tokens/:id',
    module: route121,
  },
  {
    importPath: './routes/projects/[projectId]/tokens/route',
    routePath: '/projects/:projectId/tokens',
    module: route122,
  },
  {
    importPath: './routes/projects/active/route',
    routePath: '/projects/active',
    module: route123,
  },
  {
    importPath: './routes/projects/route',
    routePath: '/projects',
    module: route124,
  },
  {
    importPath: './routes/prompts/[id]/comments/[commentId]/route',
    routePath: '/prompts/:id/comments/:commentId',
    module: route125,
  },
  {
    importPath: './routes/prompts/[id]/comments/route',
    routePath: '/prompts/:id/comments',
    module: route126,
  },
  {
    importPath: './routes/prompts/[id]/compare/route',
    routePath: '/prompts/:id/compare',
    module: route127,
  },
  {
    importPath: './routes/prompts/[id]/deployments/route',
    routePath: '/prompts/:id/deployments',
    module: route128,
  },
  {
    importPath: './routes/prompts/[id]/route',
    routePath: '/prompts/:id',
    module: route129,
  },
  {
    importPath: './routes/prompts/[id]/versions/route',
    routePath: '/prompts/:id/versions',
    module: route130,
  },
  {
    importPath: './routes/prompts/route',
    routePath: '/prompts',
    module: route131,
  },
  {
    importPath: './routes/prompts/stats/route',
    routePath: '/prompts/stats',
    module: route132,
  },
  {
    importPath: './routes/providers/[id]/route',
    routePath: '/providers/:id',
    module: route133,
  },
  {
    importPath: './routes/providers/drivers/[driverId]/form/route',
    routePath: '/providers/drivers/:driverId/form',
    module: route134,
  },
  {
    importPath: './routes/providers/drivers/route',
    routePath: '/providers/drivers',
    module: route135,
  },
  {
    importPath: './routes/providers/route',
    routePath: '/providers',
    module: route136,
  },
  {
    importPath: './routes/quota/defaults/route',
    routePath: '/quota/defaults',
    module: route137,
  },
  {
    importPath: './routes/quota/policies/[id]/route',
    routePath: '/quota/policies/:id',
    module: route138,
  },
  {
    importPath: './routes/quota/policies/route',
    routePath: '/quota/policies',
    module: route139,
  },
  {
    importPath: './routes/rag/modules/[key]/documents/[documentId]/route',
    routePath: '/rag/modules/:key/documents/:documentId',
    module: route140,
  },
  {
    importPath: './routes/rag/modules/[key]/documents/route',
    routePath: '/rag/modules/:key/documents',
    module: route141,
  },
  {
    importPath: './routes/rag/modules/[key]/query/route',
    routePath: '/rag/modules/:key/query',
    module: route142,
  },
  {
    importPath: './routes/rag/modules/[key]/route',
    routePath: '/rag/modules/:key',
    module: route143,
  },
  {
    importPath: './routes/rag/modules/[key]/usage/route',
    routePath: '/rag/modules/:key/usage',
    module: route144,
  },
  {
    importPath: './routes/rag/modules/route',
    routePath: '/rag/modules',
    module: route145,
  },
  {
    importPath: './routes/tokens/[id]/route',
    routePath: '/tokens/:id',
    module: route146,
  },
  {
    importPath: './routes/tokens/route',
    routePath: '/tokens',
    module: route147,
  },
  {
    importPath: './routes/tools/[toolId]/actions/[actionKey]/execute/route',
    routePath: '/tools/:toolId/actions/:actionKey/execute',
    module: route148,
  },
  {
    importPath: './routes/tools/[toolId]/logs/route',
    routePath: '/tools/:toolId/logs',
    module: route149,
  },
  {
    importPath: './routes/tools/[toolId]/route',
    routePath: '/tools/:toolId',
    module: route150,
  },
  {
    importPath: './routes/tools/route',
    routePath: '/tools',
    module: route151,
  },
  {
    importPath: './routes/tracing/agents/[agentName]/overview/route',
    routePath: '/tracing/agents/:agentName/overview',
    module: route152,
  },
  {
    importPath: './routes/tracing/dashboard/route',
    routePath: '/tracing/dashboard',
    module: route153,
  },
  {
    importPath: './routes/tracing/sessions/[sessionId]/route',
    routePath: '/tracing/sessions/:sessionId',
    module: route154,
  },
  {
    importPath: './routes/tracing/sessions/route',
    routePath: '/tracing/sessions',
    module: route155,
  },
  {
    importPath: './routes/tracing/threads/[threadId]/route',
    routePath: '/tracing/threads/:threadId',
    module: route156,
  },
  {
    importPath: './routes/tracing/threads/route',
    routePath: '/tracing/threads',
    module: route157,
  },
  {
    importPath: './routes/users/[id]/route',
    routePath: '/users/:id',
    module: route158,
  },
  {
    importPath: './routes/users/invite/route',
    routePath: '/users/invite',
    module: route159,
  },
  {
    importPath: './routes/users/route',
    routePath: '/users',
    module: route160,
  },
  {
    importPath: './routes/vector/dashboard/route',
    routePath: '/vector/dashboard',
    module: route161,
  },
  {
    importPath: './routes/vector/indexes/[externalId]/query/route',
    routePath: '/vector/indexes/:externalId/query',
    module: route162,
  },
  {
    importPath: './routes/vector/indexes/[externalId]/route',
    routePath: '/vector/indexes/:externalId',
    module: route163,
  },
  {
    importPath: './routes/vector/indexes/[externalId]/stats/route',
    routePath: '/vector/indexes/:externalId/stats',
    module: route164,
  },
  {
    importPath: './routes/vector/indexes/[externalId]/upsert/route',
    routePath: '/vector/indexes/:externalId/upsert',
    module: route165,
  },
  {
    importPath: './routes/vector/indexes/[externalId]/vectors/route',
    routePath: '/vector/indexes/:externalId/vectors',
    module: route166,
  },
  {
    importPath: './routes/vector/indexes/route',
    routePath: '/vector/indexes',
    module: route167,
  },
  {
    importPath: './routes/vector/providers/drivers/[driverId]/form/route',
    routePath: '/vector/providers/drivers/:driverId/form',
    module: route168,
  },
  {
    importPath: './routes/vector/providers/drivers/route',
    routePath: '/vector/providers/drivers',
    module: route169,
  },
  {
    importPath: './routes/vector/providers/route',
    routePath: '/vector/providers',
    module: route170,
  }
];
