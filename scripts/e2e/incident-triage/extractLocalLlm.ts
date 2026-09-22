/**
 * Prints the base URL and API key of a model provider stored in a LOCAL
 * tenant database, as JSON on stdout — so the e2e run can call a real LLM
 * without the operator pasting a key into their shell.
 *
 * Runs as its own process, on purpose: decrypting needs the SAME secret the
 * dev server encrypted with, which the e2e runner cannot hold (it isolates its
 * own environment for a throwaway tenant before importing any config).
 *
 * The key is printed to stdout for the parent to read and is never logged.
 * Only ever point this at a local development database.
 *
 *   tsx extractLocalLlm.ts <envDir> <tenantDbFile> <providerKey>
 */
import { loadEnvConfig } from '@next/env';

const [envDir, tenantDbFile, providerKey] = process.argv.slice(2);
if (!envDir || !tenantDbFile || !providerKey) {
    process.stderr.write('usage: extractLocalLlm.ts <envDir> <tenantDbFile> <providerKey>\n');
    process.exit(2);
}
loadEnvConfig(envDir, true);

async function main() {
    const Database = (await import('better-sqlite3')).default;
    const { decryptObject } = await import('@/lib/utils/crypto');
    const db = new Database(tenantDbFile, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT credentialsEnc, settings FROM providers WHERE key = ?').get(providerKey) as
        | { credentialsEnc: string; settings: string }
        | undefined;
    db.close();
    if (!row) throw new Error(`provider "${providerKey}" not found in ${tenantDbFile}`);
    const credentials = decryptObject<Record<string, unknown>>(row.credentialsEnc);
    const settings = JSON.parse(row.settings || '{}') as Record<string, unknown>;
    process.stdout.write(JSON.stringify({
        baseUrl: settings.baseUrl ?? credentials.baseUrl,
        apiKey: credentials.apiKey,
    }));
}

main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
