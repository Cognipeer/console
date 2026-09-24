/**
 * Agent manifests — the portable, reviewable form of an agent.
 *
 * A manifest is the agent's config with every tenant-local id stripped and
 * every dependency reduced to a *key*. That is deliberate: keys are what a
 * customer's second environment also has, ids are not. Importing therefore
 * becomes a reconciliation ("does this tenant have `jira-mcp`?") rather than a
 * restore, and the dry run below is what turns a missing dependency into a
 * reviewable list instead of a runtime failure three turns into a chat.
 *
 * Secrets never enter a manifest. `connection.apiKeyEnc` is encrypted with the
 * source tenant's key and would be undecryptable anywhere else anyway — but the
 * more important reason is that a manifest is meant to be pasted into a PR.
 */

import YAML from 'yaml';

import { getDatabase } from '@/lib/database';
import type { IAgent, IAgentConfig, IAgentToolBinding } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { maskAgentSandboxConfig, sealAgentConfigSecrets } from './agentSandboxSecrets';


const logger = createLogger('agent-manifest');

export const AGENT_MANIFEST_API_VERSION = 'cognipeer.console/v1' as const;

export type AgentManifestFormat = 'json' | 'yaml';

export interface AgentManifestDependency {
    /** What the key points at, so the importer can send the user to the right page. */
    type: 'model' | 'prompt' | 'tool' | 'mcp' | 'knowledge' | 'guardrail' | 'agent';
    key: string;
    /** Where in the spec it is referenced — shown next to a missing dependency. */
    usedBy: string;
}

export interface AgentManifest {
    apiVersion: typeof AGENT_MANIFEST_API_VERSION;
    kind: 'Agent';
    metadata: {
        key: string;
        name: string;
        description?: string;
        status?: string;
        /** Version the manifest was taken from; null when exported from the draft. */
        version?: number | null;
        exportedAt: string;
    };
    spec: IAgentConfig;
    /** Flat list of every key the spec references. Informational — derived, not authoritative. */
    dependencies: AgentManifestDependency[];
}

// ── Build ────────────────────────────────────────────────────────────────

/** Strips secret material from a config destined for export. */
function sanitizeConfig(config: IAgentConfig): IAgentConfig {
    const spec: IAgentConfig = JSON.parse(JSON.stringify(config ?? {}));
    if (spec.connection) {
        // Encrypted with the source tenant's key — useless elsewhere, and a
        // manifest is a document people paste into pull requests.
        delete spec.connection.apiKeyEnc;
    }
    if (spec.sandbox) {
        // Same reasoning for sandbox secrets: the keys travel (so an importer
        // sees which secrets to fill in), the sealed values never do.
        spec.sandbox = maskAgentSandboxConfig(spec.sandbox);
    }
    return spec;
}

function collectBindingDependencies(
    bindings: IAgentToolBinding[] | undefined,
    usedBy: string,
    out: AgentManifestDependency[],
): void {
    for (const binding of bindings ?? []) {
        if (binding.source === 'tool') out.push({ type: 'tool', key: binding.sourceKey, usedBy });
        else if (binding.source === 'mcp') out.push({ type: 'mcp', key: binding.sourceKey, usedBy });
        // 'system' bindings (browser_use and friends) are built into the binary —
        // there is nothing for an importing tenant to be missing.
    }
}

export function collectManifestDependencies(spec: IAgentConfig): AgentManifestDependency[] {
    const out: AgentManifestDependency[] = [];
    if (spec.modelKey) out.push({ type: 'model', key: spec.modelKey, usedBy: 'spec.modelKey' });
    if (spec.promptKey) out.push({ type: 'prompt', key: spec.promptKey, usedBy: 'spec.promptKey' });
    if (spec.knowledgeEngineKey) {
        out.push({ type: 'knowledge', key: spec.knowledgeEngineKey, usedBy: 'spec.knowledgeEngineKey' });
    }
    for (const guardrail of spec.guardrails ?? []) {
        if (guardrail.key) out.push({ type: 'guardrail', key: guardrail.key, usedBy: 'spec.guardrails' });
    }
    if (spec.inputGuardrailKey) {
        out.push({ type: 'guardrail', key: spec.inputGuardrailKey, usedBy: 'spec.inputGuardrailKey' });
    }
    if (spec.outputGuardrailKey) {
        out.push({ type: 'guardrail', key: spec.outputGuardrailKey, usedBy: 'spec.outputGuardrailKey' });
    }
    collectBindingDependencies(spec.toolBindings, 'spec.toolBindings', out);

    for (const subagent of spec.subagents ?? []) {
        const where = `spec.subagents[${subagent.name}]`;
        if (subagent.kind === 'ref' && subagent.agentKey) {
            out.push({ type: 'agent', key: subagent.agentKey, usedBy: where });
            continue;
        }
        if (subagent.modelKey) out.push({ type: 'model', key: subagent.modelKey, usedBy: where });
        if (subagent.knowledgeEngineKey) {
            out.push({ type: 'knowledge', key: subagent.knowledgeEngineKey, usedBy: where });
        }
        collectBindingDependencies(subagent.toolBindings, where, out);
    }

    // Dedupe on type+key; `usedBy` keeps the first reference, which is enough to
    // point a reader at where to look.
    const seen = new Set<string>();
    return out.filter((dep) => {
        const id = `${dep.type}:${dep.key}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

export function buildAgentManifest(
    agent: Pick<IAgent, 'key' | 'name' | 'description' | 'status'>,
    config: IAgentConfig,
    version: number | null = null,
): AgentManifest {
    const spec = sanitizeConfig(config);
    return {
        apiVersion: AGENT_MANIFEST_API_VERSION,
        kind: 'Agent',
        metadata: {
            key: agent.key,
            name: agent.name,
            ...(agent.description ? { description: agent.description } : {}),
            ...(agent.status ? { status: agent.status } : {}),
            version,
            exportedAt: new Date().toISOString(),
        },
        spec,
        dependencies: collectManifestDependencies(spec),
    };
}

export function serializeAgentManifest(manifest: AgentManifest, format: AgentManifestFormat): string {
    return format === 'yaml'
        ? YAML.stringify(manifest, { lineWidth: 0 })
        : `${JSON.stringify(manifest, null, 2)}\n`;
}

// ── Parse & validate ─────────────────────────────────────────────────────

export class AgentManifestError extends Error {
    readonly issues: string[];
    constructor(message: string, issues: string[] = []) {
        super(message);
        this.name = 'AgentManifestError';
        this.issues = issues;
    }
}

/**
 * Parses a manifest from text. The format is detected rather than declared:
 * YAML is a superset of JSON, so one parser would do — but a JSON syntax error
 * reported as a YAML error is confusing, and people paste both.
 */
export function parseAgentManifest(text: string, format?: AgentManifestFormat): AgentManifest {
    const trimmed = text.trim();
    if (!trimmed) throw new AgentManifestError('Manifest is empty');

    const detected: AgentManifestFormat = format ?? (trimmed.startsWith('{') ? 'json' : 'yaml');
    let parsed: unknown;
    try {
        parsed = detected === 'json' ? JSON.parse(trimmed) : YAML.parse(trimmed);
    } catch (error) {
        throw new AgentManifestError(
            `Manifest is not valid ${detected.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const issues = validateAgentManifest(parsed);
    if (issues.length > 0) throw new AgentManifestError('Manifest failed validation', issues);
    return parsed as AgentManifest;
}

export function validateAgentManifest(input: unknown): string[] {
    const issues: string[] = [];
    if (!input || typeof input !== 'object') return ['Manifest must be an object'];
    const manifest = input as Partial<AgentManifest>;

    if (manifest.apiVersion !== AGENT_MANIFEST_API_VERSION) {
        issues.push(`apiVersion must be "${AGENT_MANIFEST_API_VERSION}" (got ${String(manifest.apiVersion)})`);
    }
    if (manifest.kind !== 'Agent') {
        issues.push(`kind must be "Agent" (got ${String(manifest.kind)})`);
    }
    if (!manifest.metadata?.key || typeof manifest.metadata.key !== 'string') {
        issues.push('metadata.key is required');
    } else if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(manifest.metadata.key)) {
        issues.push('metadata.key must be alphanumeric with dashes/underscores, max 64 chars');
    }
    if (!manifest.metadata?.name || typeof manifest.metadata.name !== 'string') {
        issues.push('metadata.name is required');
    }
    if (!manifest.spec || typeof manifest.spec !== 'object') {
        issues.push('spec is required');
        return issues;
    }

    const spec = manifest.spec as IAgentConfig;
    const kind = spec.kind ?? 'native';
    if (kind === 'native' && !spec.modelKey) {
        issues.push('spec.modelKey is required for native agents');
    }
    if (kind === 'external' && !spec.connection?.url) {
        issues.push('spec.connection.url is required for connected agents');
    }

    const names = new Set<string>();
    for (const subagent of spec.subagents ?? []) {
        if (!subagent.name) issues.push('every spec.subagents entry needs a name');
        else if (names.has(subagent.name)) issues.push(`duplicate sub-agent name "${subagent.name}"`);
        else names.add(subagent.name);
        if (subagent.kind === 'ref' && !subagent.agentKey) {
            issues.push(`sub-agent "${subagent.name}" is a reference but has no agentKey`);
        }
        if (subagent.kind !== 'ref' && subagent.kind !== 'inline') {
            issues.push(`sub-agent "${subagent.name}" has an unknown kind "${String(subagent.kind)}"`);
        }
    }

    if (spec.structuredOutput?.enabled && !spec.structuredOutput.schema) {
        issues.push('spec.structuredOutput.enabled is true but no schema is set');
    }

    return issues;
}

// ── Dependency reconciliation ────────────────────────────────────────────

export interface ManifestDependencyStatus extends AgentManifestDependency {
    present: boolean;
}

export interface AgentImportPreview {
    manifest: AgentManifest;
    /** True when an agent with this key already exists in the target project. */
    exists: boolean;
    dependencies: ManifestDependencyStatus[];
    missing: ManifestDependencyStatus[];
}

async function dependencyExists(
    db: Awaited<ReturnType<typeof getDatabase>>,
    projectId: string,
    dep: AgentManifestDependency,
): Promise<boolean> {
    try {
        switch (dep.type) {
            case 'model':
                return Boolean(await db.findModelByKey(dep.key, projectId));
            case 'prompt':
                return Boolean(await db.findPromptByKey(dep.key, projectId));
            case 'tool':
                return Boolean(await db.findToolByKey(dep.key, projectId));
            case 'mcp':
                return Boolean(await db.findMcpServerByKey(dep.key, projectId));
            case 'knowledge':
                return Boolean(await db.findRagModuleByKey(dep.key, projectId));
            case 'guardrail':
                return Boolean(await db.findGuardrailByKey(dep.key, projectId));
            case 'agent':
                return Boolean(await db.findAgentByKey(dep.key, projectId));
            default:
                return false;
        }
    } catch (error) {
        // A lookup that throws is reported as missing, not as a failed import —
        // the preview's whole job is to say what will not work.
        logger.warn('Dependency lookup failed', {
            type: dep.type,
            key: dep.key,
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}

/**
 * Dry run. Never writes. Returns the manifest alongside what the target project
 * is missing, so the UI can refuse (or warn) before anything is created.
 */
export async function previewAgentImport(
    tenantDbName: string,
    projectId: string,
    manifest: AgentManifest,
): Promise<AgentImportPreview> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const declared = collectManifestDependencies(manifest.spec);
    const dependencies: ManifestDependencyStatus[] = [];
    for (const dep of declared) {
        dependencies.push({ ...dep, present: await dependencyExists(db, projectId, dep) });
    }

    const existing = await db.findAgentByKey(manifest.metadata.key, projectId);

    return {
        manifest,
        exists: Boolean(existing),
        dependencies,
        missing: dependencies.filter((dep) => !dep.present),
    };
}

// ── Apply ────────────────────────────────────────────────────────────────

export type AgentImportMode = 'create' | 'update' | 'upsert';

export interface AgentImportResult {
    agent: IAgent;
    action: 'created' | 'updated';
    /** Dependencies the target project does not have. The agent is still written. */
    missing: ManifestDependencyStatus[];
}

/**
 * Writes a manifest into the target project.
 *
 * The imported agent always lands as a **draft** config on the existing record
 * (or a new one): importing must never change what `/v1/responses` is serving.
 * Publishing stays a separate, deliberate action — the same rule the playground
 * follows.
 *
 * Missing dependencies do not block the write by default. They are returned, and
 * `allowMissingDependencies: false` turns them into a refusal for callers (CI,
 * the import dialog's strict mode) that would rather fail early.
 */
export async function applyAgentManifest(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    manifest: AgentManifest,
    options: {
        mode?: AgentImportMode;
        /** Override the manifest's own key — used when importing a copy alongside the original. */
        key?: string;
        name?: string;
        allowMissingDependencies?: boolean;
    } = {},
): Promise<AgentImportResult> {
    const issues = validateAgentManifest(manifest);
    if (issues.length > 0) throw new AgentManifestError('Manifest failed validation', issues);

    const preview = await previewAgentImport(tenantDbName, projectId, manifest);
    if (preview.missing.length > 0 && options.allowMissingDependencies === false) {
        throw new AgentManifestError(
            'Manifest references dependencies this project does not have',
            preview.missing.map((dep) => `${dep.type} "${dep.key}" (${dep.usedBy})`),
        );
    }

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const key = options.key?.trim() || manifest.metadata.key;
    const name = options.name?.trim() || manifest.metadata.name;
    const mode = options.mode ?? 'upsert';
    const existing = await db.findAgentByKey(key, projectId);

    if (existing) {
        if (mode === 'create') throw new AgentManifestError(`Agent key "${key}" already exists`);
        const updated = await db.updateAgent(String(existing._id), {
            name,
            description: manifest.metadata.description,
            // Masked secret values keep what this agent already stores.
            config: sealAgentConfigSecrets(sanitizeConfig(manifest.spec), existing.config),
            updatedBy: userId,
        });
        if (!updated) throw new AgentManifestError(`Agent "${key}" could not be updated`);
        logger.info('Agent imported over existing record', { key, projectId, missing: preview.missing.length });
        return { agent: updated, action: 'updated', missing: preview.missing };
    }

    if (mode === 'update') throw new AgentManifestError(`Agent "${key}" does not exist`);

    const created = await db.createAgent({
        tenantId,
        projectId,
        key,
        name,
        description: manifest.metadata.description,
        config: sealAgentConfigSecrets(sanitizeConfig(manifest.spec), undefined),
        // Imported agents start inactive: an import is a proposal until someone
        // opens it, checks the dependency list and publishes.
        status: 'draft',
        createdBy: userId,
    });
    logger.info('Agent imported as new record', { key, projectId, missing: preview.missing.length });
    return { agent: created, action: 'created', missing: preview.missing };
}
