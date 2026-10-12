/**
 * The command line of the pre-upgrade access report (scripts/iam/preflight-diff.ts):
 * parse the options, run, write the report, choose the exit code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { UsageError, USAGE, parseOptions, type Env } from './options';
import { renderMarkdown, renderSummary } from './render';
import { integrityProblem } from './report';
import { runPreflight, stripLists } from './run';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_INTEGRITY = 2;
export const EXIT_DIFFERENCES = 3;

export async function main(argv: readonly string[], env: Env = process.env): Promise<number> {
  let options;
  try {
    options = parseOptions(argv, env, process.cwd());
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\nRun with --help for the options.\n`);
      return EXIT_ERROR;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }

  const log = (message: string) => {
    if (!options.quiet) process.stderr.write(`${message}\n`);
  };

  try {
    const full = await runPreflight(options, log, env);
    const markdown = renderMarkdown(full, options.maxListed);
    const report = options.summaryOnly ? stripLists(full) : full;

    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    const jsonPath = `${options.out}.json`;
    const mdPath = `${options.out}.md`;
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(mdPath, options.summaryOnly ? renderMarkdown(report, options.maxListed) : markdown);

    if (!options.quiet) process.stdout.write(`${renderSummary(report)}\n\n`);
    process.stdout.write(`written: ${jsonPath}\n         ${mdPath}\n`);

    if (integrityProblem(report.totals.integrity)) return EXIT_INTEGRITY;
    if (options.failOnDifferences && report.totals.differs > 0) return EXIT_DIFFERENCES;
    return EXIT_OK;
  } catch (error) {
    process.stderr.write(`iam-preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
    if (process.env.DEBUG && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    return EXIT_ERROR;
  }
}
