/**
 * Read-only retention inventory: for every tenant (or one via --tenant), every
 * collection in the retention registry, how many rows it holds and how many
 * the tenant's current policy would delete or redact now. Run it before
 * turning RETENTION_DRY_RUN off, to see what the first real sweep will do.
 *
 * Counts go through the same database primitives the engine uses, so it works
 * on MongoDB and SQLite alike. For on-disk sizes per collection (MongoDB) see
 * `npm run report:data-footprint`.
 *
 * Usage:
 *   npm run retention:inventory
 *   npm run retention:inventory -- --tenant acme
 *   npm run retention:inventory -- --json
 */
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

interface CliArgs {
  tenant?: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant') {
      args.tenant = argv[i + 1];
      if (!args.tenant) throw new Error('--tenant expects a tenant slug or dbName');
      i += 1;
    } else if (arg === '--json') {
      args.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

interface Row {
  tenant: string;
  target: string;
  collection: string;
  class: string;
  action: string;
  days: number;
  total: number;
  expired: number;
  error?: string;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const { getDatabase, disconnectDatabase, runWithTenantScope } = await import('../src/lib/database');
  const { loadPolicy } = await import('../src/lib/retention/policy');
  const { countWork, planWork } = await import('../src/lib/retention/engine');
  const { getConfig } = await import('../src/lib/core/config');

  const db = await getDatabase();
  const rows: Row[] = [];
  try {
    let tenants = (await db.listTenants()).filter((tenant) => tenant.dbName);
    if (args.tenant) {
      tenants = tenants.filter((tenant) => tenant.slug === args.tenant || tenant.dbName === args.tenant);
      if (tenants.length === 0) {
        console.error(`No tenant matched --tenant ${args.tenant}`);
        return 1;
      }
    }
    const now = new Date();
    const farFuture = new Date(now.getTime() + 365 * 86_400_000);

    for (const tenant of tenants) {
      await runWithTenantScope(tenant.dbName, async (tenantDb) => {
        const policy = await loadPolicy(tenantDb, now, false);
        const items = planWork(policy, { mode: { kind: 'policy' }, now });
        const counts = await countWork(tenantDb, items);
        const totals = new Map<string, number>();
        for (const item of items) {
          const key = `${item.collection}|${JSON.stringify(item.filter.where ?? [])}`;
          if (!totals.has(key)) {
            totals.set(key, await tenantDb.retentionCount(item.collection, { timeField: item.filter.timeField, before: farFuture, where: item.filter.where }).catch(() => -1));
          }
        }
        items.forEach((item, i) => {
          rows.push({
            tenant: tenant.slug,
            target: item.targetId,
            collection: item.collection,
            class: item.class,
            action: item.action,
            days: item.days,
            total: totals.get(`${item.collection}|${JSON.stringify(item.filter.where ?? [])}`) ?? -1,
            expired: counts[i].affected,
            ...(counts[i].error ? { error: counts[i].error } : {}),
          });
        });
      });
    }
  } finally {
    await disconnectDatabase();
  }

  if (args.json) {
    console.log(JSON.stringify({ dryRun: getConfig().retention.dryRun, rows }, null, 2));
    return 0;
  }
  const cfg = getConfig().retention;
  console.log(`Retention inventory (engine ${cfg.enabled ? 'on' : 'off'}, ${cfg.dryRun ? 'DRY RUN: nothing is deleted yet' : 'live'})\n`);
  for (const tenant of [...new Set(rows.map((r) => r.tenant))]) {
    console.log(`── ${tenant}`);
    for (const row of rows.filter((r) => r.tenant === tenant)) {
      const verb = row.action === 'delete' ? 'delete' : 'redact';
      const note = row.error ? `  ERROR ${row.error}` : '';
      console.log(`  ${row.target.padEnd(28)} ${row.class.padEnd(10)} ${String(row.days).padStart(5)}d  ${verb} ${String(row.expired).padStart(9)} / ${String(row.total).padStart(9)} rows${note}`);
    }
    const tenantRows = rows.filter((r) => r.tenant === tenant);
    const del = tenantRows.filter((r) => r.action === 'delete').reduce((sum, r) => sum + r.expired, 0);
    const red = tenantRows.filter((r) => r.action === 'redact').reduce((sum, r) => sum + r.expired, 0);
    console.log(`  → would delete ${del} and redact ${red} row(s) now\n`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
