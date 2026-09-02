/**
 * Bulk user import from a CSV.
 *
 * The console already models a person who never signs in: a PROGRAMMATIC user,
 * `canLogin: false`, which the invite dialog creates and the members table
 * labels as such. A bulk import therefore needs no directory of its own — it
 * creates the same user records, many at a time.
 *
 * That matters beyond tidiness. Because every imported person is a real user,
 * RBAC, project assignment, groups, usage attribution and every report keep
 * working with no special case for "the imported ones", and a gateway can point
 * at them the same way it points at anyone else.
 */
import bcrypt from 'bcryptjs';
import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { generateSecurePassword } from '@/lib/services/auth/passwordGenerator';
import { BCRYPT_ROUNDS } from '@/lib/services/auth/passwordPolicy';

const logger = createLogger('service:users:csv-import');

/**
 * Hard ceiling on usable rows per import. The request body limit (10 MB) would
 * otherwise admit ~200k rows, and each row is a database write on the request
 * thread; an admin with more people than this splits the file, which is the
 * outcome they can actually recover from if a batch goes wrong.
 */
export const MAX_BULK_IMPORT_ROWS = 2000;

/** Rows created between two quota re-checks inside the insert loop. */
export const QUOTA_RECHECK_EVERY = 50;

export interface CsvUserRow {
  name: string;
  email?: string;
}

/**
 * Splits one CSV line, respecting double quotes.
 *
 * A naive `split(delimiter)` breaks the moment a spreadsheet exports a name
 * like `"Doe, John"`: the row becomes three columns and the person is imported
 * as `"Doe`. Quotes are the normal case in a real export, not an edge case.
 * `""` inside a quoted field is an escaped quote, per RFC 4180.
 */
function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = false; }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { cells.push(cell.trim()); cell = ''; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

const DELIMITERS = ['\t', ';', ','] as const;

/**
 * Picks the delimiter ONCE, from the first non-empty line, counting only
 * separators outside quotes. Sniffing per line by mere presence let a quoted
 * `"Smith; John",john@x.com` split on the `;` inside the quotes, swallow the
 * email into the name cell and import a person called `Smith; John,john@x.com`.
 * A file has one delimiter; the first line is where it shows.
 */
function sniffDelimiter(line: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best: string = ',';
  let bestCount = 0;
  // Iteration order doubles as the tie-break: tab beats semicolon beats comma.
  for (const d of DELIMITERS) {
    const n = counts.get(d) ?? 0;
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Matched WHOLE, never as a prefix. `/^(…|ad|isim)/` looked reasonable and
 * quietly swallowed "Ada Lovelace" and "İsmail Kaya" as header rows.
 */
const HEADER_WORDS = new Set([
  'email', 'e-mail', 'mail', 'name', 'full name', 'fullname', 'username', 'user',
  'ad', 'isim', 'ad soyad', 'kullanıcı', 'kullanici', 'eposta', 'e-posta',
]);
/**
 * Looser rule for the FIRST line only: `Email Address,Display Name` is not
 * all header words, has no email, and used to become a user named "Email
 * Address". Anchored/word-bounded so the person "İsmail Kaya" (contains
 * "mail") on line one is still a person: `mail` counts only at the start of a
 * cell, `ad`/`name`/… only as whole words.
 */
const HEADER_HINT_RE = /^(e-?mail|e-?posta|mail)\b|\b(name|ad|adı|isim|soyad|address|adres|display|full|user)\b/iu;
/** A usable name has at least one letter or digit — `@@@` names nobody. */
const NAME_RE = /[\p{L}\p{N}]/u;

function isHeaderCell(cell: string): boolean {
  return HEADER_WORDS.has(cell.trim().toLowerCase());
}

export class CsvImportError extends Error {
  readonly status: number;
  /** Extra fields for the response body (e.g. the cap that was exceeded). */
  readonly details: Record<string, unknown>;
  constructor(message: string, status = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CsvImportError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Forgiving CSV reader.
 *
 * An export from Active Directory, Excel or a wiki table has a different shape
 * every time, and refusing the file over a header row is a bad trade. Accepts a
 * header or none, comma/semicolon/tab, quoted or bare, and either column order.
 *
 * Rows it cannot use come BACK in `invalid` rather than vanishing: an admin who
 * uploads 500 rows and reads "480 created" needs the other twenty.
 *
 * Throws `CsvImportError` (400) once more than `maxRows` usable rows have been
 * seen, so a pasted 10 MB file stops here rather than at the database.
 */
export function parseUserCsv(
  text: string,
  options: { maxRows?: number } = {},
): { rows: CsvUserRow[]; invalid: string[] } {
  const maxRows = options.maxRows ?? MAX_BULK_IMPORT_ROWS;
  const rows: CsvUserRow[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let delimiter: string | null = null;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const isFirstLine = delimiter === null;
    if (delimiter === null) delimiter = sniffDelimiter(line);
    const cells = splitCsvLine(line, delimiter).filter((c) => c.length > 0);
    if (cells.length === 0) continue;

    const email = cells.find((c) => EMAIL_RE.test(c));
    const named = cells.find((c) => c !== email);

    // A header row is every-cell-a-header-word, so a real person called "Ad"
    // is not mistaken for one; the first line alone also accepts header-like
    // phrases ("Email Address", "Display Name") that no export uses as a name.
    if (!email && cells.every(isHeaderCell)) continue;
    if (!email && isFirstLine && cells.some((c) => HEADER_HINT_RE.test(c))) continue;

    // A row with only an email still names someone — use the local part rather
    // than throwing the person away.
    const name = named || (email ? email.split('@')[0] : '');
    if (!name || !NAME_RE.test(name)) { invalid.push(line); continue; }

    const key = email ? email.toLowerCase() : `name:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (rows.length >= maxRows) {
      throw new CsvImportError(
        `The file has more than ${maxRows} usable rows — split it and import in batches`,
        400,
        { maxRows },
      );
    }
    rows.push({ name, email });
  }
  return { rows, invalid };
}

export interface CsvImportResult {
  created: Array<{ id: string; name: string; email?: string }>;
  /** People who already have an account here. */
  skippedExisting: string[];
  invalid: string[];
}

export interface CsvImportOutcome {
  created: Array<{ id: string; name: string; email?: string }>;
  /**
   * Set when a mid-batch quota re-check refused to continue: `remaining` rows
   * were not attempted. The batch was checked whole up front, so this only
   * happens when something else (a concurrent import or invite) consumed the
   * headroom in the meantime.
   */
  halted?: { reason: string; remaining: number };
}

/**
 * Whether `row` already has an account, by the SAME rule the insert loop uses:
 * email when the row has one, otherwise name. Exported so the route's quota
 * arithmetic counts exactly the rows the loop would create.
 */
export function rowAlreadyExists(
  row: CsvUserRow,
  byEmail: ReadonlySet<string>,
  byName: ReadonlySet<string>,
): boolean {
  return row.email ? byEmail.has(row.email.toLowerCase()) : byName.has(row.name.toLowerCase());
}

/**
 * Creates one programmatic user per row.
 *
 * Idempotent on email — re-uploading the same file creates nobody twice. Rows
 * with no email fall back to matching on name, which is imperfect and the
 * reason the import screen asks for email first.
 *
 * The caller has already checked the user quota for the whole batch. Because a
 * concurrent import or invite can consume that headroom while this loop runs,
 * `checkQuota` (when given) is consulted again every `QUOTA_RECHECK_EVERY`
 * creations with the live count; a refusal stops the loop and is reported in
 * `halted` rather than thrown, so the rows already created are still returned.
 */
export async function importProgrammaticUsers(args: {
  tenantId: string;
  rows: CsvUserRow[];
  role?: 'user' | 'admin' | 'project_admin';
  projectIds?: string[];
  /** Tenant licence type, stored on the record exactly as the invite route does. */
  licenseId: string;
  createdBy?: string;
  /** Re-checked mid-batch with the live user count (existing + created so far). */
  checkQuota?: (currentCount: number) => Promise<{ allowed: boolean; reason?: string }>;
}): Promise<CsvImportOutcome> {
  const db = await getDatabase();
  const existing = await db.listUsers();
  const byEmail = new Set(existing.filter((u) => u.email).map((u) => String(u.email).toLowerCase()));
  const byName = new Set(existing.map((u) => String(u.name ?? '').toLowerCase()));

  // ONE hash for the whole batch, computed lazily on the first insert. Every
  // row here is `canLogin: false`, so the value is never handed to
  // `bcrypt.compare` — it exists because a blank password hash is the kind of
  // thing that later becomes a login bypass, not because anyone will type it.
  // The password behind it is CSPRNG-random and discarded, so sharing the hash
  // across rows leaks nothing; hashing per row (bcrypt cost 12, ~250 ms of
  // pure-JS work each) would pin the event loop for minutes on a large file.
  let sharedPasswordHash: string | null = null;

  const created: Array<{ id: string; name: string; email?: string }> = [];
  let halted: CsvImportOutcome['halted'];
  for (let i = 0; i < args.rows.length; i += 1) {
    const row = args.rows[i];
    if (rowAlreadyExists(row, byEmail, byName)) continue;

    if (args.checkQuota && created.length > 0 && created.length % QUOTA_RECHECK_EVERY === 0) {
      const quota = await args.checkQuota(existing.length + created.length);
      if (!quota.allowed) {
        halted = {
          reason: quota.reason ?? 'User quota exceeded',
          remaining: args.rows.length - i,
        };
        break;
      }
    }

    sharedPasswordHash ??= await bcrypt.hash(generateSecurePassword(), BCRYPT_ROUNDS);
    // Same field set the invite route writes, minus the invite itself: a
    // programmatic account has nobody to email and no first login to force a
    // password change on.
    const user = await db.createUser({
      canLogin: false,
      // Empty string rather than null — the deliberate shape for a
      // programmatic account, documented on IUser.email.
      email: row.email ?? '',
      features: [],
      invitedAt: new Date(),
      invitedBy: args.createdBy,
      licenseId: args.licenseId,
      mustChangePassword: false,
      name: row.name,
      password: sharedPasswordHash,
      projectIds: args.projectIds,
      role: args.role ?? 'user',
      servicePermissions: undefined,
      tenantId: args.tenantId,
    });

    const id = String((user as { _id?: unknown })._id ?? '');
    created.push({ id, name: row.name, email: row.email || undefined });
    if (row.email) byEmail.add(row.email.toLowerCase());
    byName.add(row.name.toLowerCase());
  }

  logger.info('programmatic users imported', {
    tenantId: args.tenantId,
    created: created.length,
    ...(halted ? { halted } : {}),
  });
  return { created, halted };
}
