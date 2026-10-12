/**
 * Pre-upgrade access report for the policy engine.
 *
 * Before an installation moves to the release in which the policy engine decides
 * every request, this lists - per workspace - which people, API tokens, projects
 * and services get a different answer from the engine than from the
 * workspace-level rules they had until now, grouped by cause:
 *
 *   - project permissions now apply (a project assignment's service levels cap
 *     the workspace level; a "No access" saved earlier is ignored until its row
 *     is saved again),
 *   - API tokens now include the group grants of their owner,
 *   - members who reach a project only through a group can open it,
 *   - surfaces that now check a service permission.
 *
 * It reads a COPY of the data and writes nothing to it:
 *
 *   SQLite   node --import tsx scripts/iam/preflight-diff.ts --sqlite-dir ./copy-of-data/sqlite
 *   MongoDB  mongorestore the backup into a throwaway mongod on this machine, then
 *            node --import tsx scripts/iam/preflight-diff.ts \
 *              --mongodb-uri mongodb://127.0.0.1:27017 --main-db console_main
 *
 * See --help, and docs/guide/upgrading-to-the-policy-engine.md.
 */

import { main } from './preflight/cli';

// Exit explicitly (the application modules may leave timers behind), but only after stdout has been flushed.
const flushed = () => new Promise<void>((resolve) => process.stdout.write('', () => resolve()));

main(process.argv.slice(2)).then(
  async (code) => {
    await flushed();
    process.exit(code);
  },
  async (error) => {
    process.stderr.write(`iam-preflight crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    await flushed();
    process.exit(1);
  },
);
