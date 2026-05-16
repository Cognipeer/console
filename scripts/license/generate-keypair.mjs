import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? './license';
mkdirSync(outDir, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicPem = publicKey.export({ format: 'pem', type: 'spki' });

writeFileSync(path.join(outDir, 'private.pem'), privatePem, { mode: 0o600 });
writeFileSync(path.join(outDir, 'public.pem'), publicPem);

console.log(`License keypair written to ${outDir}`);
