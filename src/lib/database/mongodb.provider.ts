/**
 * MongoDB Provider – Composed class
 *
 * Combines the base class with all domain-specific mixins to build the full
 * `MongoDBProvider` implementation that satisfies `DatabaseProvider`.
 *
 * Each mixin lives in its own file under `./mongodb/` for maintainability.
 */

import type { DatabaseProvider } from './provider.interface';

// Base class & mixins
import { SandboxMixin } from './mongodb/sandbox.mixin';
import { MongoDBProviderBase } from './mongodb/base';
import { TenantMixin } from './mongodb/tenant.mixin';
import { UserMixin } from './mongodb/user.mixin';
import { ProjectMixin } from './mongodb/project.mixin';
import { PromptMixin } from './mongodb/prompt.mixin';
import { QuotaMixin } from './mongodb/quota.mixin';
import { ApiTokenMixin } from './mongodb/api-token.mixin';
import { TracingMixin } from './mongodb/tracing.mixin';
import { ModelMixin } from './mongodb/model.mixin';
import { VectorMixin } from './mongodb/vector.mixin';
import { FileMixin } from './mongodb/file.mixin';
import { ProviderRecordMixin } from './mongodb/provider-record.mixin';
import { InferenceMixin } from './mongodb/inference.mixin';
import { GuardrailMixin } from './mongodb/guardrail.mixin';
import { EvaluationMixin } from './mongodb/evaluation.mixin';
import { AnalysisMixin } from './mongodb/analysis.mixin';
import { PiiPolicyMixin } from './mongodb/pii-policy.mixin';
import { AlertMixin } from './mongodb/alert.mixin';
import { IncidentMixin } from './mongodb/incident.mixin';
import { RagMixin } from './mongodb/rag.mixin';
import { RerankerMixin } from './mongodb/reranker.mixin';
import { MemoryMixin } from './mongodb/memory.mixin';
import { ConfigMixin } from './mongodb/config.mixin';
import { McpServerMixin } from './mongodb/mcp-server.mixin';
import { JsSandboxMixin } from './mongodb/js-sandbox.mixin';
import { ToolMixin } from './mongodb/tool.mixin';
import { AgentMixin } from './mongodb/agent.mixin';
import { VectorMigrationMixin } from './mongodb/vector-migration.mixin';
import { BrowserMixin } from './mongodb/browser.mixin';
import { CrawlerMixin } from './mongodb/crawler.mixin';
import { AuditMixin } from './mongodb/audit.mixin';
import { UserProjectMixin } from './mongodb/user-project.mixin';
import { ClusterMixin } from './mongodb/cluster.mixin';
import { GpuFleetMixin } from './mongodb/gpu-fleet.mixin';

// ── Compose mixins in domain groups ──────────────────────────────────────
// Order matters where there are cross-mixin dependencies.
// UserMixin depends on TenantMixin (WithTenantOps constraint).

// Group 1 – Core identity
const CoreBase = UserProjectMixin(ProjectMixin(UserMixin(TenantMixin(MongoDBProviderBase))));

// Group 2 – Content & auth
const ContentBase = ApiTokenMixin(QuotaMixin(PromptMixin(CoreBase)));

// Group 3 – AI operations
const AIBase = VectorMixin(ModelMixin(TracingMixin(ContentBase)));

// Group 4 – Storage & providers
const StorageBase = ProviderRecordMixin(FileMixin(AIBase));

// Group 5 – Advanced features
const AdvancedBase = CrawlerMixin(AuditMixin(BrowserMixin(VectorMigrationMixin(AgentMixin(ToolMixin(JsSandboxMixin(McpServerMixin(ConfigMixin(MemoryMixin(RerankerMixin(RagMixin(IncidentMixin(AlertMixin(PiiPolicyMixin(AnalysisMixin(EvaluationMixin(GuardrailMixin(InferenceMixin(StorageBase)))))))))))))))))));

// Group 6 – Cluster (system-wide; uses main DB)
const ClusterBase = ClusterMixin(AdvancedBase);

// Sandbox runtime (tenant-scoped) — composed independently of gpu-fleet.
const SandboxBase = SandboxMixin(ClusterBase);

// Group 7 – GPU fleet (tenant-scoped)
const GpuFleetBase = GpuFleetMixin(SandboxBase);

// ── Final composed class ─────────────────────────────────────────────────

export class MongoDBProvider extends GpuFleetBase implements DatabaseProvider {}
