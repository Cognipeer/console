/**
 * Seed beta access codes into the main database.
 *
 * Registration with REGISTRATION_MODE=beta requires one of these codes; each
 * code is single-use. The script is idempotent: existing codes are left
 * untouched and reported as such.
 *
 * Reads the same .env / environment as the server (DB_PROVIDER, MONGODB_URI /
 * SQLITE_DATA_DIR, MAIN_DB_NAME), so run it from the project root against the
 * deployment you want to seed.
 *
 * Usage:
 *   npm run seed:beta-codes -- CODE-ONE CODE-TWO        # seed explicit codes
 *   npm run seed:beta-codes -- --count 10               # generate 10 random codes
 *   npm run seed:beta-codes -- --count 5 --note "wave 2"
 *   npm run seed:beta-codes -- --list                   # print all codes + status
 */
import { randomBytes } from 'node:crypto';
import { loadEnvConfig } from '@next/env';

// Config is read at import time — load env BEFORE any '@/'-aliased import.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

// Unambiguous alphabet (no 0/O, 1/I/L) so codes survive being read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  const block = (length: number): string => {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
  };
  return `BETA-${block(4)}-${block(4)}`;
}

interface CliArgs {
  codes: string[];
  count: number;
  note: string | null;
  list: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { codes: [], count: 0, note: null, list: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--count') {
      args.count = Number.parseInt(argv[i + 1] ?? '', 10);
      if (!Number.isFinite(args.count) || args.count <= 0) {
        throw new Error('--count expects a positive integer');
      }
      i += 1;
    } else if (arg === '--note') {
      args.note = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--list') {
      args.list = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      args.codes.push(arg);
    }
  }

  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const { getDatabase, disconnectDatabase } = await import('../src/lib/database');
  const db = await getDatabase();

  try {
    if (args.list) {
      const codes = await db.listBetaAccessCodes();
      if (codes.length === 0) {
        console.log('No beta access codes in the database.');
      } else {
        console.log(`${codes.length} beta access code(s):\n`);
        for (const code of codes) {
          const usage =
            code.status === 'used'
              ? ` — used by ${code.usedByEmail ?? '?'} at ${code.usedAt?.toISOString() ?? '?'}`
              : '';
          const note = code.note ? ` (${code.note})` : '';
          console.log(`  ${code.code}  [${code.status}]${usage}${note}`);
        }
      }
      return 0;
    }

    const toSeed = [...args.codes];
    for (let i = 0; i < args.count; i += 1) {
      toSeed.push(generateCode());
    }

    if (toSeed.length === 0) {
      console.error(
        'Nothing to seed. Pass codes as arguments, or --count N to generate random ones.\n'
        + 'Example: npm run seed:beta-codes -- --count 10',
      );
      return 1;
    }

    console.log(`Seeding ${toSeed.length} beta access code(s)...\n`);

    for (const rawCode of toSeed) {
      const existing = await db.findBetaAccessCode(rawCode);
      const record = await db.createBetaAccessCode({
        code: rawCode,
        note: args.note,
      });
      const label = existing ? `already existed [${record.status}]` : 'created';
      console.log(`  ${record.code}  ${label}`);
    }

    console.log('\nDone. Codes above are single-use and required when REGISTRATION_MODE=beta.');
    return 0;
  } finally {
    await disconnectDatabase();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('Seed failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
