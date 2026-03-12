#!/usr/bin/env node
/**
 * Fix Provider Key Whitespace
 * ===========================
 * Trims leading/trailing whitespace from provider keys across all tenant databases.
 *
 * Affected tables and columns:
 *   - providers.key
 *   - vector_indexes.providerKey
 *   - file_buckets.providerKey
 *   - files.providerKey
 *   - rag_modules.vectorProviderKey
 *   - rag_modules.fileProviderKey
 *   - memory_stores.vectorProviderKey
 *
 * Usage:
 *   node scripts/fix-provider-key-whitespace.mjs [--data-dir ./data/sqlite]
 *
 * Options:
 *   --data-dir <path>   SQLite data directory (default: ./data/sqlite)
 *   --dry-run           Show what would be changed without modifying data
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dataDirIdx = args.indexOf('--data-dir');
const dataDir = dataDirIdx >= 0 && args[dataDirIdx + 1]
  ? args[dataDirIdx + 1]
  : process.env.SQLITE_DATA_DIR || './data/sqlite';

const TABLES_TO_FIX = [
  { table: 'providers',      column: 'key' },
  { table: 'vector_indexes', column: 'providerKey' },
  { table: 'file_buckets',   column: 'providerKey' },
  { table: 'files',          column: 'providerKey' },
  { table: 'rag_modules',    column: 'vectorProviderKey' },
  { table: 'rag_modules',    column: 'fileProviderKey' },
  { table: 'memory_stores',  column: 'vectorProviderKey' },
];

function fixDatabase(dbPath) {
  const dbName = path.basename(dbPath);
  let db;
  try {
    db = new Database(dbPath);
  } catch (err) {
    console.warn(`  ⚠ Could not open ${dbName}: ${err.message}`);
    return;
  }

  let totalFixed = 0;

  try {
    for (const { table, column } of TABLES_TO_FIX) {
      // Check if table exists
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      if (!tableExists) continue;

      // Find rows with whitespace in the column
      const affected = db
        .prepare(`SELECT rowid, "${column}" AS val FROM "${table}" WHERE "${column}" != TRIM("${column}")`)
        .all();

      if (affected.length === 0) continue;

      console.log(`  ${dbName} → ${table}.${column}: ${affected.length} row(s) with whitespace`);
      for (const row of affected) {
        const trimmed = String(row.val).trim();
        console.log(`    rowid=${row.rowid}: "${row.val}" → "${trimmed}"`);
      }

      if (!dryRun) {
        const result = db
          .prepare(`UPDATE "${table}" SET "${column}" = TRIM("${column}") WHERE "${column}" != TRIM("${column}")`)
          .run();
        totalFixed += result.changes;
      } else {
        totalFixed += affected.length;
      }
    }
  } finally {
    db.close();
  }

  return totalFixed;
}

// ── Main ─────────────────────────────────────────────────────────────

const resolvedDir = path.resolve(dataDir);
if (!fs.existsSync(resolvedDir)) {
  console.error(`Data directory not found: ${resolvedDir}`);
  process.exit(1);
}

console.log(`${dryRun ? '[DRY RUN] ' : ''}Scanning SQLite databases in: ${resolvedDir}\n`);

const dbFiles = fs
  .readdirSync(resolvedDir)
  .filter((f) => f.endsWith('.db'));

if (dbFiles.length === 0) {
  console.log('No .db files found.');
  process.exit(0);
}

let grandTotal = 0;

for (const file of dbFiles) {
  const dbPath = path.join(resolvedDir, file);
  const fixed = fixDatabase(dbPath);
  if (fixed > 0) grandTotal += fixed;
}

console.log(`\n${dryRun ? '[DRY RUN] Would fix' : 'Fixed'} ${grandTotal} row(s) total.`);
