/**
 * SQLite Provider – Composed class
 *
 * Combines the base class with all domain-specific mixins to build the full
 * `SQLiteProvider` implementation that satisfies `DatabaseProvider`.
 *
 * Each mixin lives in its own file under `./sqlite/` for maintainability.
 */

import type { DatabaseProvider } from './provider.interface';

// Base class & mixins
import { SQLiteProviderBase } from './sqlite/base';
import { TenantMixin } from './sqlite/tenant.mixin';
import { UserMixin } from './sqlite/user.mixin';
import { ProjectMixin } from './sqlite/project.mixin';
import { PromptMixin } from './sqlite/prompt.mixin';
import { QuotaMixin } from './sqlite/quota.mixin';
import { ApiTokenMixin } from './sqlite/api-token.mixin';
import { TracingMixin } from './sqlite/tracing.mixin';
import { ModelMixin } from './sqlite/model.mixin';
import { VectorMixin } from './sqlite/vector.mixin';
import { FileMixin } from './sqlite/file.mixin';
import { ProviderRecordMixin } from './sqlite/provider-record.mixin';
import { InferenceMixin } from './sqlite/inference.mixin';
import { GuardrailMixin } from './sqlite/guardrail.mixin';
import { EvaluationMixin } from './sqlite/evaluation.mixin';
import { RedTeamMixin } from './sqlite/redteam.mixin';
import { AnalysisMixin } from './sqlite/analysis.mixin';
import { PiiPolicyMixin } from './sqlite/pii-policy.mixin';
import { AlertMixin } from './sqlite/alert.mixin';
import { IncidentMixin } from './sqlite/incident.mixin';
import { RagMixin } from './sqlite/rag.mixin';
import { RagReindexMixin } from './sqlite/rag-reindex.mixin';
import { RerankerMixin } from './sqlite/reranker.mixin';
import { WebSearchMixin } from './sqlite/websearch.mixin';
import { MemoryMixin } from './sqlite/memory.mixin';
import { ConfigMixin } from './sqlite/config.mixin';
import { McpServerMixin } from './sqlite/mcp-server.mixin';
import { ToolMixin } from './sqlite/tool.mixin';
import { AgentMixin } from './sqlite/agent.mixin';
import { SkillMixin } from './sqlite/skill.mixin';
import { VectorMigrationMixin } from './sqlite/vector-migration.mixin';
import { BrowserMixin } from './sqlite/browser.mixin';
import { CrawlerMixin } from './sqlite/crawler.mixin';
import { AgentRunMixin } from './sqlite/agent-run.mixin';
import { OcrJobMixin } from './sqlite/ocr-jobs.mixin';
import { WebhookMixin } from './sqlite/webhook.mixin';
import { BatchJobMixin } from './sqlite/batch.mixin';
import { UsageRollupMixin } from './sqlite/usage.mixin';
import { EntityMetricsMixin } from './sqlite/entity-metrics.mixin';
import { AlertStateMixin } from './sqlite/alert-state.mixin';
import { SchedulerClaimMixin } from './sqlite/scheduler-claim.mixin';
import { AgentTriggerMixin } from './sqlite/agent-trigger.mixin';
import { AlertChannelLibraryMixin } from './sqlite/alert-channel-library.mixin';
import { ExternalModelPricingMixin } from './sqlite/external-model-pricing.mixin';
import { AuditMixin } from './sqlite/audit.mixin';
import { UserProjectMixin } from './sqlite/user-project.mixin';
import { ClusterMixin } from './sqlite/cluster.mixin';
import { BetaAccessCodeMixin } from './sqlite/beta-access-code.mixin';
import { IamInvalidationMixin } from './iam-invalidation.mixin';
import { IamDocsMixin } from './sqlite/iam-docs.mixin';
import { IamDirectoryMixin } from './sqlite/iam-directory.mixin';
import { applyEnterpriseSqliteDbMixins } from '@/enterprise/registry';
import type { Constructor } from './sqlite/types';

// ── Compose mixins in domain groups ──────────────────────────────────────
// Order follows the MongoDB provider composition for consistency.

// Group 1 – Core identity
const CoreBase = UserProjectMixin(ProjectMixin(UserMixin(TenantMixin(SQLiteProviderBase))));

// Group 2 – Content & auth
const ContentBase = ApiTokenMixin(QuotaMixin(PromptMixin(CoreBase)));

// Group 3 – AI operations
const AIBase = VectorMixin(ModelMixin(TracingMixin(ContentBase)));

// Group 4 – Storage & providers
const StorageBase = ProviderRecordMixin(FileMixin(AIBase));

// Group 5 – Advanced features
// Split into intermediate steps (rather than one deeply-nested call) so no
// single expression is deep enough to trip esbuild/tsc's parser nesting limit.
// Application order (inner → outer) is preserved exactly.
const CoreServicesBase = GuardrailMixin(InferenceMixin(StorageBase));
const EvalAnalysisBase = RedTeamMixin(AnalysisMixin(EvaluationMixin(CoreServicesBase)));
const AlertingBase = IncidentMixin(AlertMixin(PiiPolicyMixin(EvalAnalysisBase)));
const RagBase = RagReindexMixin(RagMixin(AlertingBase));
const KnowledgeBase = MemoryMixin(WebSearchMixin(RerankerMixin(RagBase)));
const PlatformBase = McpServerMixin(ConfigMixin(KnowledgeBase));
const ToolingBase = VectorMigrationMixin(SkillMixin(AgentMixin(ToolMixin(PlatformBase))));
const AdvancedBase = OcrJobMixin(CrawlerMixin(AuditMixin(BrowserMixin(ToolingBase))));
const BulkBase = UsageRollupMixin(BatchJobMixin(AgentRunMixin(AdvancedBase)));
// A named instance type here caps how deep the checker walks the mixin chain:
// past ~50 nested mixins, generic helpers over the provider type (`vi.spyOn`)
// fail with "type instantiation is excessively deep" (TS2589).
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an interface (not an alias) is what caps the depth
interface BulkInstance extends InstanceType<typeof BulkBase> {}
const BulkFlat: Constructor<BulkInstance> = BulkBase;
const PricingBase = AgentTriggerMixin(SchedulerClaimMixin(WebhookMixin(ExternalModelPricingMixin(BulkFlat))));

// Group 6 – Cluster (system-wide; uses main DB). Single-node node registry
// stays in the community edition; the cluster ORCHESTRATION/admin lives in the
// enterprise overlay.
// Entity health rollup + alert evaluation state (split steps keep the nesting shallow).
const HealthBase = EntityMetricsMixin(AlertChannelLibraryMixin(AlertStateMixin(PricingBase)));
const ClusterBase = ClusterMixin(HealthBase);

// Group 7 – Signup gating (main database; beta access codes)
const SignupBase = BetaAccessCodeMixin(ClusterBase);

// Group 8 – IAM document store (tenant-scoped, lazily created collections/tables)
const IamBase = IamDirectoryMixin(IamDocsMixin(SignupBase));

// ── Enterprise overlay seam ───────────────────────────────────────────────
// Enterprise DB mixins (sandbox runtime + gpu-fleet) are contributed by the
// overlay registry; this is a no-op in the community edition.
// See the cognipeer-console-ee repo (docs/licensing/MANIFEST.md).
const FinalBase = applyEnterpriseSqliteDbMixins(IamBase);

// ── Final composed class ─────────────────────────────────────────────────

// Outermost: observes writes of every layer (core + enterprise overlay) so the
// policy engine's principal cache drops stale slices (src/lib/iam).
const ObservedBase = IamInvalidationMixin(FinalBase);

export class SQLiteProvider extends ObservedBase implements DatabaseProvider {}
