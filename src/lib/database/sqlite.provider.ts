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
import { AuditMixin } from './sqlite/audit.mixin';
import { UserProjectMixin } from './sqlite/user-project.mixin';
import { ClusterMixin } from './sqlite/cluster.mixin';

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
const AdvancedBase = CrawlerMixin(AuditMixin(BrowserMixin(VectorMigrationMixin(AgentMixin(ToolMixin(JsSandboxMixin(McpServerMixin(ConfigMixin(MemoryMixin(RerankerMixin(RagMixin(IncidentMixin(AlertMixin(PiiPolicyMixin(GuardrailMixin(InferenceMixin(StorageBase)))))))))))))))));

// Group 6 – Cluster (system-wide; uses main DB)
const ClusterBase = ClusterMixin(AdvancedBase);

// ── Final composed class ─────────────────────────────────────────────────

export class SQLiteProvider extends ClusterBase implements DatabaseProvider {}
