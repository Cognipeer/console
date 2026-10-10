/**
 * Command line and environment of the pre-upgrade access report.
 *
 * The data source is always named EXPLICITLY (--sqlite-dir / --mongodb-uri);
 * the ambient SQLITE_DATA_DIR / MONGODB_URI of the shell are never used, so a
 * run started from inside a production container cannot end up reading the live
 * database by accident. A MongoDB target must be on this machine unless
 * IAM_PREFLIGHT_ALLOW_REMOTE=1 says otherwise: the provider creates indexes
 * when it connects, which is not something to do to a live cluster.
 */

import path from 'node:path';

/** The environment: `process.env`, or a plain object in tests. */
export type Env = Record<string, string | undefined>;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type PreflightSource =
  | { kind: 'sqlite'; dir: string; mainDbName: string; copy: boolean }
  | { kind: 'mongodb'; uri: string; mainDbName: string; singleDatabase: boolean };

export interface PreflightOptions {
  source: PreflightSource;
  /** Workspace slugs or database names; empty = all. */
  tenants: string[];
  /** Report base path (no extension): `<out>.json` and `<out>.md`. */
  out: string;
  redact: boolean;
  redactSalt?: string;
  /** At most this many people and this many tokens per workspace; null = all. */
  maxPrincipals: number | null;
  /** People listed per section of the Markdown report. */
  maxListed: number;
  /** Activation instant to assume (ms since epoch); null = the time of the run. */
  since: number | null;
  verifyAll: boolean;
  /** Ask the engine for every decision instead of re-using answers between people with identical levels. */
  noMemo: boolean;
  summaryOnly: boolean;
  failOnDifferences: boolean;
  /** Diagnostics: append EVERY compared decision as a JSON line to this file (large on a real directory). */
  dump: string | null;
  quiet: boolean;
  help: boolean;
}

export const DEFAULT_OUT = 'iam-preflight-report';
export const DEFAULT_MAIN_DB = 'console_main';
export const DEFAULT_MAX_LISTED = 100;

export const USAGE = `Pre-upgrade access report for the policy engine (read-only; run it on a COPY of the data)

Usage:
  node --import tsx scripts/iam/preflight-diff.ts --sqlite-dir <dir> [options]
  node --import tsx scripts/iam/preflight-diff.ts --mongodb-uri <uri> --main-db <name> [options]

Data source (a copy, never the live data):
  --sqlite-dir <dir>       Directory with the SQLite files (console_main.db, tenant_<slug>.db).
                           It is copied to a temporary directory first; the original is not opened.
  --mongodb-uri <uri>      A restored copy on THIS machine (localhost, 127.0.0.1, ::1). Other hosts
                           are refused unless IAM_PREFLIGHT_ALLOW_REMOTE=1 is set.
  --main-db <name>         Name of the main database (default ${DEFAULT_MAIN_DB}).
  --single-database        MongoDB only: tenant collections live in the main database.
  --no-copy                SQLite only: read the directory in place. Only for a directory that is
                           already a throwaway copy - the provider adds columns on connect.

Scope:
  --tenants <a,b>          Only these workspaces (slug or database name). Default: all.
  --max-principals <n>     At most n people and n API tokens per workspace (those most likely to
                           change are evaluated first). Default: all.

Output:
  --out <path>             Report base name: writes <path>.json and <path>.md
                           (default ./${DEFAULT_OUT}).
  --redact                 Replace emails, names, token labels and project names by hashes.
  --redact-salt <text>     Salt for --redact (default: random per run; the same salt makes two
                           runs comparable).
  --max-listed <n>         People listed per section of the Markdown report (default ${DEFAULT_MAX_LISTED});
                           the JSON file always has all of them unless --summary-only.
  --summary-only           Leave the per-person lists out of the JSON as well.
  --quiet                  No progress output; print only the written paths.

Behaviour:
  --since <iso-date-time>  The activation instant to assume. From that moment a project permission
                           of "No access" saved earlier is ignored (default: the time of the run).
  --verify-all             Run the attribution checks on every decision, not only on the ones that
                           differ (about 3x slower).
  --no-memo                Ask the engine for every single decision. By default people whose levels
                           are identical share one answer, which is what makes a large directory fast.
  --fail-on-differences    Exit with code 3 when any person's or token's access changes.
  --dump <file>            Diagnostics: write every compared decision as one JSON line to <file>
                           (large on a real directory).
  -h, --help               This text.

Environment equivalents: IAM_PREFLIGHT_SQLITE_DIR, IAM_PREFLIGHT_MONGODB_URI, IAM_PREFLIGHT_MAIN_DB,
IAM_PREFLIGHT_SINGLE_DATABASE=1, IAM_PREFLIGHT_NO_COPY=1, IAM_PREFLIGHT_TENANTS, IAM_PREFLIGHT_MAX_PRINCIPALS,
IAM_PREFLIGHT_OUT, IAM_PREFLIGHT_REDACT=1, IAM_PREFLIGHT_REDACT_SALT, IAM_PREFLIGHT_MAX_LISTED,
IAM_PREFLIGHT_SINCE, IAM_PREFLIGHT_VERIFY_ALL=1, IAM_PREFLIGHT_NO_MEMO=1, IAM_PREFLIGHT_SUMMARY_ONLY=1,
IAM_PREFLIGHT_QUIET=1, IAM_PREFLIGHT_FAIL_ON_DIFFERENCES=1, IAM_PREFLIGHT_DUMP.
IAM_PREFLIGHT_ALLOW_REMOTE=1 (environment only) lets a MongoDB copy on another host be used.

Exit code: 0 done and consistent; 1 usage or connection error; 2 done, but the engine disagreed with
the rules it is checked against (do not rely on the report; tell support); 3 only with --fail-on-differences.
`;

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const isTrue = (value: string | undefined): boolean => value !== undefined && TRUE.has(value.trim().toLowerCase());

function positiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${name} expects a positive whole number, got "${raw}"`);
  return n;
}

export function parseInstant(name: string, raw: string): number {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new UsageError(`${name} expects an ISO 8601 date-time such as 2026-10-12T09:00:00Z, got "${raw}"`);
  return ms;
}

/** Host names of a MongoDB connection string (every member of a replica-set seed list). */
export function mongoHosts(uri: string): string[] {
  const match = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(uri.trim());
  if (!match) return [];
  const list = match[2];
  return list
    .split(',')
    .map((entry) => {
      const host = entry.trim();
      if (host.startsWith('[')) return host.slice(1, host.indexOf(']')); // [::1]:27017
      return host.replace(/:\d+$/, '');
    })
    .filter(Boolean);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function isLocalMongoUri(uri: string): boolean {
  if (/^mongodb\+srv:/i.test(uri.trim())) return false; // resolved through DNS: never "this machine"
  const hosts = mongoHosts(uri);
  return hosts.length > 0 && hosts.every((h) => LOCAL_HOSTS.has(h.toLowerCase()));
}

/** The connection string without credentials and options, for the report. */
export function describeMongoUri(uri: string): string {
  const hosts = mongoHosts(uri);
  const scheme = /^mongodb\+srv:/i.test(uri.trim()) ? 'mongodb+srv' : 'mongodb';
  return `${scheme}://${hosts.join(',') || '(unparsed)'}`;
}

export function assertMongoTargetAllowed(uri: string, env: Env): void {
  if (mongoHosts(uri).length === 0) throw new UsageError('--mongodb-uri is not a MongoDB connection string (mongodb://host:port)');
  if (isLocalMongoUri(uri)) return;
  if (isTrue(env.IAM_PREFLIGHT_ALLOW_REMOTE)) return;
  throw new UsageError(
    `Refusing to connect to ${describeMongoUri(uri)}: restore the copy into a MongoDB on this machine and point the report at localhost. `
    + 'The database provider creates indexes when it connects, which must never happen on a live cluster. '
    + 'If this really is a throwaway copy on another host, set IAM_PREFLIGHT_ALLOW_REMOTE=1.',
  );
}

export function parseOptions(argv: readonly string[], env: Env = {}, cwd: string = process.cwd()): PreflightOptions {
  const flags = new Map<string, string | true>();
  const valueFlags = new Set([
    '--sqlite-dir', '--mongodb-uri', '--main-db', '--tenants', '--max-principals', '--out', '--redact-salt',
    '--max-listed', '--since', '--dump',
  ]);
  const boolFlags = new Set([
    '--single-database', '--no-copy', '--redact', '--summary-only', '--quiet', '--verify-all', '--no-memo',
    '--fail-on-differences', '--help', '-h',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (valueFlags.has(name)) {
      const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
      if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new UsageError(`${name} expects a value`);
      flags.set(name, value);
      if (eq === -1) i += 1;
    } else if (boolFlags.has(name)) {
      flags.set(name, true);
    } else {
      throw new UsageError(`Unknown option: ${arg}`);
    }
  }

  const text = (flag: string, envName: string): string | undefined => {
    const fromFlag = flags.get(flag);
    if (typeof fromFlag === 'string') return fromFlag;
    const fromEnv = env[envName];
    return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined;
  };
  const bool = (flag: string, envName: string): boolean => flags.has(flag) || isTrue(env[envName]);

  const help = flags.has('--help') || flags.has('-h');
  const sqliteDir = text('--sqlite-dir', 'IAM_PREFLIGHT_SQLITE_DIR');
  const mongoUri = text('--mongodb-uri', 'IAM_PREFLIGHT_MONGODB_URI');
  const mainDbName = text('--main-db', 'IAM_PREFLIGHT_MAIN_DB') ?? DEFAULT_MAIN_DB;

  let source: PreflightSource | undefined;
  if (!help) {
    if (sqliteDir && mongoUri) throw new UsageError('Give either --sqlite-dir or --mongodb-uri, not both');
    if (!sqliteDir && !mongoUri) {
      throw new UsageError('Name the data to read: --sqlite-dir <dir> or --mongodb-uri <uri> (a COPY of the data; see --help)');
    }
    if (sqliteDir) {
      source = { kind: 'sqlite', dir: path.resolve(cwd, sqliteDir), mainDbName, copy: !bool('--no-copy', 'IAM_PREFLIGHT_NO_COPY') };
    } else if (mongoUri) {
      assertMongoTargetAllowed(mongoUri, env);
      source = { kind: 'mongodb', uri: mongoUri, mainDbName, singleDatabase: bool('--single-database', 'IAM_PREFLIGHT_SINGLE_DATABASE') };
    }
    if (source?.kind === 'mongodb' && flags.has('--no-copy')) throw new UsageError('--no-copy applies to SQLite only');
  }

  const maxPrincipalsRaw = text('--max-principals', 'IAM_PREFLIGHT_MAX_PRINCIPALS');
  const maxListedRaw = text('--max-listed', 'IAM_PREFLIGHT_MAX_LISTED');
  const sinceRaw = text('--since', 'IAM_PREFLIGHT_SINCE');
  const tenantsRaw = text('--tenants', 'IAM_PREFLIGHT_TENANTS');
  const dumpRaw = text('--dump', 'IAM_PREFLIGHT_DUMP');

  return {
    source: source ?? { kind: 'sqlite', dir: '', mainDbName, copy: true },
    tenants: (tenantsRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    out: path.resolve(cwd, text('--out', 'IAM_PREFLIGHT_OUT') ?? DEFAULT_OUT).replace(/\.(json|md)$/i, ''),
    redact: bool('--redact', 'IAM_PREFLIGHT_REDACT'),
    redactSalt: text('--redact-salt', 'IAM_PREFLIGHT_REDACT_SALT'),
    maxPrincipals: maxPrincipalsRaw ? positiveInt('--max-principals', maxPrincipalsRaw) : null,
    maxListed: maxListedRaw ? positiveInt('--max-listed', maxListedRaw) : DEFAULT_MAX_LISTED,
    since: sinceRaw ? parseInstant('--since', sinceRaw) : null,
    verifyAll: bool('--verify-all', 'IAM_PREFLIGHT_VERIFY_ALL'),
    noMemo: bool('--no-memo', 'IAM_PREFLIGHT_NO_MEMO'),
    summaryOnly: bool('--summary-only', 'IAM_PREFLIGHT_SUMMARY_ONLY'),
    failOnDifferences: bool('--fail-on-differences', 'IAM_PREFLIGHT_FAIL_ON_DIFFERENCES'),
    dump: dumpRaw ? path.resolve(cwd, dumpRaw) : null,
    quiet: bool('--quiet', 'IAM_PREFLIGHT_QUIET'),
    help,
  };
}
