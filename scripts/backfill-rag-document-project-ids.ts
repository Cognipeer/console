/**
 * Stamp the owning project onto Knowledge Engine documents that were ingested
 * WITHOUT one.
 *
 * WHY THIS EXISTS (F-02, finance-institution assessment 2026-09-05): the
 * client RAG API used to pass `projectId: undefined` on ingest/list/query, and
 * the database layer reads `undefined` as "no project filter — tenant-wide".
 * Every document ingested through `/api/client/v1/rag/...` before that fix
 * therefore has no `projectId` at all. The fix makes those same calls pass
 * `ctx.projectId`, which is an EXACT match filter — so without this backfill,
 * a project-scoped token stops seeing its own previously-ingested documents
 * the moment the fix ships (they are not deleted, just invisible to the
 * list/delete/reingest paths, and their chunks stay searchable because vector
 * search filters by module, not project).
 *
 * The owning project is not guessed: a document belongs to its RAG MODULE
 * (`ragModuleKey`), and the module carries the projectId the dashboard
 * created it under. Documents whose module ALSO has no projectId cannot be
 * attributed and are reported, not written — see the summary at the end.
 *
 * IDEMPOTENT: only touches documents whose projectId is missing/empty, so a
 * second run is a no-op.
 *
 * Reads the same .env as the server (DB_PROVIDER, MONGODB_URI /
 * SQLITE_DATA_DIR, MAIN_DB_NAME) — run from the project root against the
 * deployment you want to backfill.
 *
 * Usage:
 *   npm run backfill:rag-project-ids -- --dry-run     # report only (RUN THIS FIRST)
 *   npm run backfill:rag-project-ids                  # write, all tenants
 *   npm run backfill:rag-project-ids -- --tenant acme # one tenant
 */
import { loadEnvConfig } from '@next/env';

// Config is read at import time — load env BEFORE any '@/'-aliased import.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

interface CliArgs {
  tenant?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant') {
      args.tenant = argv[i + 1];
      if (!args.tenant) throw new Error('--tenant expects a tenant slug or dbName');
      i += 1;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function isMissing(value: string | undefined): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const { getDatabase, disconnectDatabase } = await import('../src/lib/database');
  const db = await getDatabase();

  let totalStamped = 0;
  let totalUnattributable = 0;
  const unattributableModules = new Set<string>();

  try {
    let tenants = await db.listTenants();
    if (args.tenant) {
      const wanted = args.tenant;
      tenants = tenants.filter((t) => t.slug === wanted || t.dbName === wanted);
      if (tenants.length === 0) throw new Error(`No tenant matched "${wanted}"`);
    }

    for (const tenant of tenants) {
      await db.switchToTenant(tenant.dbName);
      // No project filter: we want every module, including the legacy ones
      // that have no projectId of their own.
      const modules = await db.listRagModules();
      let tenantStamped = 0;
      let tenantUnattributable = 0;

      for (const ragModule of modules) {
        const documents = await db.listRagDocuments(ragModule.key);
        const orphans = documents.filter((doc) => isMissing(doc.projectId));
        if (orphans.length === 0) continue;

        if (isMissing(ragModule.projectId)) {
          // The module itself is unscoped, so there is nothing to inherit.
          // Reported rather than guessed — assigning these to some project
          // would be inventing an ownership claim, which is the opposite of
          // what the finding asked for.
          tenantUnattributable += orphans.length;
          unattributableModules.add(`${tenant.slug}/${ragModule.key}`);
          continue;
        }

        for (const doc of orphans) {
          const id = doc._id ? String(doc._id) : '';
          if (!id) continue;
          if (!args.dryRun) {
            await db.updateRagDocument(id, { projectId: ragModule.projectId });
          }
          tenantStamped += 1;
        }
      }

      if (tenantStamped > 0 || tenantUnattributable > 0) {
        console.log(
          `[${tenant.slug}] ${args.dryRun ? 'would stamp' : 'stamped'} ${tenantStamped} document(s)`
          + (tenantUnattributable > 0
            ? `; ${tenantUnattributable} left alone (their module has no projectId either)`
            : ''),
        );
      }
      totalStamped += tenantStamped;
      totalUnattributable += tenantUnattributable;
    }

    console.log(
      `\n${args.dryRun ? 'DRY RUN — ' : ''}${totalStamped} document(s) `
      + `${args.dryRun ? 'would be' : ''} stamped with their module's projectId.`,
    );
    if (totalUnattributable > 0) {
      console.log(
        `${totalUnattributable} document(s) in ${unattributableModules.size} unscoped module(s) `
        + 'could not be attributed. These modules have no projectId of their own, so a '
        + 'project-scoped client token cannot reach them either (findRagModuleByKey is an '
        + 'exact match). Assign each module to a project in the dashboard, then re-run:',
      );
      for (const key of unattributableModules) console.log(`  - ${key}`);
    }
    return 0;
  } finally {
    await disconnectDatabase();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
