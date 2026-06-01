/**
 * Built-in sandbox template library. Loads `src/config/sandbox-template-library.json`
 * and can seed a tenant with the default templates on first use.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@/lib/core/logger';
import { createTemplate, listTemplates, updateTemplate } from './templateService';

const log = createLogger('sandbox:template-library');

export interface TemplateLibraryEntry {
  key: string;
  name: string;
  description?: string;
  baseImage: string;
  runtime: string;
  isolation: string;
  resources?: Record<string, unknown>;
  env?: Record<string, string>;
  entrypoint?: string[];
  toolboxPort: number;
  previewPorts?: Array<Record<string, unknown>>;
  volumeMounts?: Array<Record<string, unknown>>;
  default?: boolean;
}

interface TemplateLibraryFile {
  version: number;
  templates: TemplateLibraryEntry[];
}

let cached: TemplateLibraryFile | null = null;

export function loadTemplateLibrary(): TemplateLibraryFile {
  if (cached) return cached;
  const file = path.join(process.cwd(), 'src', 'config', 'sandbox-template-library.json');
  try {
    cached = JSON.parse(readFileSync(file, 'utf8')) as TemplateLibraryFile;
  } catch (error) {
    log.warn('failed to load sandbox template library', {
      error: error instanceof Error ? error.message : String(error),
    });
    cached = { version: 1, templates: [] };
  }
  return cached;
}

/**
 * Seed a tenant with the built-in templates if it has none yet. Idempotent:
 * only creates templates whose `key` is not already present.
 */
export async function seedDefaultTemplates(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
): Promise<number> {
  const library = loadTemplateLibrary();
  const existing = await listTemplates(tenantDbName);
  const existingByKey = new Map(existing.map((t) => [t.key, t]));
  let changed = 0;
  for (const entry of library.templates) {
    const fields = {
      name: entry.name,
      description: entry.description ?? null,
      baseImage: entry.baseImage,
      runtime: entry.runtime,
      isolation: entry.isolation,
      resources: entry.resources ?? {},
      env: entry.env ?? {},
      entrypoint: entry.entrypoint ?? null,
      toolboxPort: entry.toolboxPort,
      previewPorts: entry.previewPorts ?? [],
      volumeMounts: entry.volumeMounts ?? [],
    };
    const found = existingByKey.get(entry.key);
    if (found) {
      // Upsert: refresh built-in templates so stale images (e.g. from earlier
      // seeds) are corrected when the user clicks "Seed defaults".
      await updateTemplate(tenantDbName, found.id, fields);
    } else {
      await createTemplate(tenantDbName, tenantId, { key: entry.key, projectId: null, ...fields }, createdBy);
    }
    changed += 1;
  }
  if (changed > 0) log.info('seeded sandbox templates', { changed });
  return changed;
}
