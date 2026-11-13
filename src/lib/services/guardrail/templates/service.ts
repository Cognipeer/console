/**
 * Listing and preparing guardrail templates for one project.
 *
 * The route owns the guardrail write itself (it goes through the same
 * parse/validate/project path as `POST /guardrails`, so a template can never
 * produce a record a hand-authored request could not). This module owns what
 * the route cannot know: which templates exist, which ones this project already
 * used, and the PII policy a template scans through.
 */

import type { GuardrailHookId, GuardrailHooksConfig } from '@/lib/database/provider/types.domain';
import { PII_CATEGORIES } from '@/lib/services/pii/categories';
import { createPiiPolicy, listPiiPolicies } from '@/lib/services/pii/piiService';
import type { PiiServicePolicyView } from '@/lib/services/pii/types';
import { listGuardrails } from '../guardrailService';
import {
  GUARDRAIL_TEMPLATE_CATALOG_VERSION,
  GUARDRAIL_TEMPLATE_CATEGORIES,
  GUARDRAIL_TEMPLATE_PII_PRESETS,
  GUARDRAIL_TEMPLATES,
  findGuardrailTemplate,
  templateHighlights,
  templateHooks,
  type GuardrailTemplateCategory,
  type GuardrailTemplateDefinition,
  type GuardrailTemplatePiiPreset,
  type GuardrailTemplateTarget,
} from './catalog';

/** Stored on a guardrail created from a template. */
export interface GuardrailTemplateMarker {
  key: string;
  version: number;
}

/** Stored on a PII policy a template created, so the next apply reuses it. */
const PII_PRESET_MARKER = 'guardrailTemplatePiiPreset';

export interface GuardrailTemplateItem {
  key: string;
  version: number;
  category: GuardrailTemplateCategory;
  name: string;
  description: string;
  recommended: boolean;
  attachTo: readonly GuardrailTemplateTarget[];
  /** The policy labels the template creates, in order. */
  policies: string[];
  hooks: GuardrailHookId[];
  /** Set when applying creates (or reuses) a PII policy. */
  piiPolicy?: { preset: string; name: string; existingKey?: string };
  /** Guardrails in this project created from this template. */
  usedBy: number;
}

export interface GuardrailTemplateList {
  catalogVersion: number;
  categories: typeof GUARDRAIL_TEMPLATE_CATEGORIES;
  templates: GuardrailTemplateItem[];
}

export function readTemplateMarker(metadata: unknown): GuardrailTemplateMarker | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const marker = (metadata as Record<string, unknown>).template;
  if (!marker || typeof marker !== 'object') return undefined;
  const { key, version } = marker as Record<string, unknown>;
  return typeof key === 'string' && typeof version === 'number' ? { key, version } : undefined;
}

function presetOf(template: GuardrailTemplateDefinition): GuardrailTemplatePiiPreset | undefined {
  return template.piiPreset ? GUARDRAIL_TEMPLATE_PII_PRESETS[template.piiPreset] : undefined;
}

function presetCategories(preset: GuardrailTemplatePiiPreset): Record<string, boolean> {
  const on = new Set(preset.categories);
  return Object.fromEntries(PII_CATEGORIES.map((category) => [category.id, on.has(category.id)]));
}

function findPresetPolicy(
  policies: readonly PiiServicePolicyView[],
  preset: GuardrailTemplatePiiPreset,
  projectId: string,
): PiiServicePolicyView | undefined {
  return policies.find(
    (policy) =>
      policy.enabled !== false &&
      policy.projectId === projectId &&
      (policy.metadata as Record<string, unknown> | undefined)?.[PII_PRESET_MARKER] === preset.id,
  );
}

export async function listGuardrailTemplates(
  tenantDbName: string,
  projectId: string,
): Promise<GuardrailTemplateList> {
  const [guardrails, piiPolicies] = await Promise.all([
    listGuardrails(tenantDbName, { projectId }),
    listPiiPolicies(tenantDbName, { projectId }),
  ]);

  const usedBy = new Map<string, number>();
  for (const guardrail of guardrails) {
    const marker = readTemplateMarker((guardrail as { metadata?: unknown }).metadata);
    if (marker) usedBy.set(marker.key, (usedBy.get(marker.key) ?? 0) + 1);
  }

  const templates = GUARDRAIL_TEMPLATES.map((template): GuardrailTemplateItem => {
    const preset = presetOf(template);
    const existing = preset ? findPresetPolicy(piiPolicies, preset, projectId) : undefined;
    return {
      key: template.key,
      version: template.version,
      category: template.category,
      name: template.name,
      description: template.description,
      recommended: template.recommended === true,
      attachTo: template.attachTo,
      policies: templateHighlights(template),
      hooks: templateHooks(template),
      ...(preset
        ? { piiPolicy: { preset: preset.id, name: preset.name, ...(existing ? { existingKey: existing.key } : {}) } }
        : {}),
      usedBy: usedBy.get(template.key) ?? 0,
    };
  });

  return {
    catalogVersion: GUARDRAIL_TEMPLATE_CATALOG_VERSION,
    categories: GUARDRAIL_TEMPLATE_CATEGORIES,
    templates,
  };
}

export interface PreparedGuardrailTemplate {
  template: GuardrailTemplateDefinition;
  hooks: GuardrailHooksConfig;
  marker: GuardrailTemplateMarker;
  /** The PII policy the hooks scan through, and whether this call created it. */
  piiPolicy?: { key: string; name: string; created: boolean };
}

export class GuardrailTemplateNotFoundError extends Error {
  constructor(key: string) {
    super(`Unknown guardrail template "${key}"`);
    this.name = 'GuardrailTemplateNotFoundError';
  }
}

/**
 * Everything the route needs to create a guardrail from `key`: the hook config
 * and the marker. Creates the template's PII policy in this project when it
 * does not exist yet; that is the only write, and it is idempotent per preset.
 *
 * The PII policy is a fixed, template-defined asset (no caller-supplied
 * content), the same kind of implicit provisioning `ensureLiftedPiiPolicy`
 * does for a legacy guardrail, so it is created under the caller's guardrail
 * permission rather than requiring a separate PII grant.
 */
export async function prepareGuardrailTemplate(params: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  actorId: string;
  key: string;
}): Promise<PreparedGuardrailTemplate> {
  const template = findGuardrailTemplate(params.key);
  if (!template) throw new GuardrailTemplateNotFoundError(params.key);

  const preset = presetOf(template);
  let piiPolicy: PreparedGuardrailTemplate['piiPolicy'];
  if (preset) {
    const existing = findPresetPolicy(
      await listPiiPolicies(params.tenantDbName, { projectId: params.projectId }),
      preset,
      params.projectId,
    );
    if (existing) {
      piiPolicy = { key: existing.key, name: existing.name, created: false };
    } else {
      const created = await createPiiPolicy(params.tenantDbName, params.tenantId, params.actorId, {
        name: preset.name,
        description: preset.description,
        projectId: params.projectId,
        defaultAction: 'mask',
        engine: 'regex',
        categories: presetCategories(preset),
        languages: [...preset.languages],
        enabled: true,
        metadata: { [PII_PRESET_MARKER]: preset.id, createdByTemplate: template.key },
      });
      piiPolicy = { key: created.key, name: created.name, created: true };
    }
  }

  return {
    template,
    hooks: template.build({ piiPolicyKey: piiPolicy?.key }),
    marker: { key: template.key, version: template.version },
    ...(piiPolicy ? { piiPolicy } : {}),
  };
}
