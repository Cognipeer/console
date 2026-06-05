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
import { RerankerMixin } from './sqlite/reranker.mixin';
import { MemoryMixin } from './sqlite/memory.mixin';
import { ConfigMixin } from './sqlite/config.mixin';
import { McpServerMixin } from './sqlite/mcp-server.mixin';
import { JsSandboxMixin } from './sqlite/js-sandbox.mixin';
import { ToolMixin } from './sqlite/tool.mixin';
import { AgentMixin } from './sqlite/agent.mixin';
import { VectorMigrationMixin } from './sqlite/vector-migration.mixin';
import { BrowserMixin } from './sqlite/browser.mixin';
import { CrawlerMixin } from './sqlite/crawler.mixin';
import { OcrJobMixin } from './sqlite/ocr-jobs.mixin';
import { AuditMixin } from './sqlite/audit.mixin';
import { UserProjectMixin } from './sqlite/user-project.mixin';
import { ClusterMixin } from './sqlite/cluster.mixin';
import { applyEnterpriseSqliteDbMixins } from '@/enterprise/registry';

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
const KnowledgeBase = MemoryMixin(RerankerMixin(RagMixin(AlertingBase)));
const PlatformBase = JsSandboxMixin(McpServerMixin(ConfigMixin(KnowledgeBase)));
const ToolingBase = VectorMigrationMixin(AgentMixin(ToolMixin(PlatformBase)));
const AdvancedBase = OcrJobMixin(CrawlerMixin(AuditMixin(BrowserMixin(ToolingBase))));

// Group 6 – Cluster (system-wide; uses main DB). Single-node node registry
// stays in the community edition; the cluster ORCHESTRATION/admin lives in the
// enterprise overlay.
const ClusterBase = ClusterMixin(AdvancedBase);

// ── Enterprise overlay seam ───────────────────────────────────────────────
// Enterprise DB mixins (sandbox runtime + gpu-fleet) are contributed by the
// overlay registry; this is a no-op in the community edition.
// See the cognipeer-console-ee repo (docs/licensing/MANIFEST.md).
const FinalBase = applyEnterpriseSqliteDbMixins(ClusterBase);

// ── Final composed class ─────────────────────────────────────────────────

export class SQLiteProvider extends FinalBase implements DatabaseProvider {}
