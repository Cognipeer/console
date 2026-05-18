import { readFileSync, writeFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args['private-key'] || !args.payload) {
  console.error('Usage: npm run license:sign -- --private-key ./offline-license/private.pem --payload ./offline-license/payload.json --out ./offline-license/license.jwt');
  process.exit(1);
}

const privatePem = readFileSync(args['private-key'], 'utf8');
const payload = JSON.parse(readFileSync(args.payload, 'utf8'));
const issuer = args.issuer ?? 'cognipeer';
const audience = args.audience ?? 'cognipeer-console';
const alg = 'EdDSA';
const privateKey = await importPKCS8(privatePem, alg);

let jwt = new SignJWT(payload)
  .setProtectedHeader({ alg })
  .setIssuedAt()
  .setIssuer(issuer)
  .setAudience(audience);

if (args.expires) {
  jwt = jwt.setExpirationTime(args.expires);
}

const token = await jwt.sign(privateKey);

if (args.out) {
  writeFileSync(args.out, `${token}\n`, { mode: 0o600 });
} else {
  console.log(token);
}
