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
import { AlertMixin } from './sqlite/alert.mixin';
import { RagMixin } from './sqlite/rag.mixin';
import { MemoryMixin } from './sqlite/memory.mixin';

// ── Compose mixins in domain groups ──────────────────────────────────────
// Order follows the MongoDB provider composition for consistency.

// Group 1 – Core identity
const CoreBase = ProjectMixin(UserMixin(TenantMixin(SQLiteProviderBase)));

// Group 2 – Content & auth
const ContentBase = ApiTokenMixin(QuotaMixin(PromptMixin(CoreBase)));

// Group 3 – AI operations
const AIBase = VectorMixin(ModelMixin(TracingMixin(ContentBase)));

// Group 4 – Storage & providers
const StorageBase = ProviderRecordMixin(FileMixin(AIBase));

// Group 5 – Advanced features
const AdvancedBase = MemoryMixin(RagMixin(AlertMixin(GuardrailMixin(InferenceMixin(StorageBase)))));

// ── Final composed class ─────────────────────────────────────────────────

export class SQLiteProvider extends AdvancedBase implements DatabaseProvider {}
