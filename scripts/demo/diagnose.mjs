import { MongoClient } from 'mongodb';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envFiles = [join(__dirname, '../../.env.local'), join(__dirname, '../../.env')];
for (const f of envFiles) {
  if (existsSync(f) && !process.env.MONGODB_URI) {
    const lines = readFileSync(f, 'utf-8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([^#=][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    break;
  }
}

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();

const mainDb  = client.db('console_main');
const tenantDb = client.db('tenant_demo');

const tenant  = await mainDb.collection('tenants').findOne({ slug: 'demo' });
console.log('\n── TENANT ──────────────────────────────────');
console.log('  _id    :', tenant?._id?.toString());
console.log('  slug   :', tenant?.slug);
console.log('  isDemo :', tenant?.isDemo);
console.log('  ownerId:', tenant?.ownerId);

const user = await tenantDb.collection('users').findOne({ email: 'demo@cognipeer.ai' });
console.log('\n── OWNER USER ───────────────────────────────');
console.log('  _id      :', user?._id?.toString());
console.log('  tenantId :', user?.tenantId);
console.log('  role     :', user?.role);
console.log('  MATCH    :', tenant?._id?.toString() === user?.tenantId ? '✅' : '❌ MISMATCH');

const projects = await tenantDb.collection('projects').find({}).toArray();
console.log('\n── PROJECTS ─────────────────────────────────');
console.log('  count:', projects.length);
for (const p of projects) {
  const match = p.tenantId === tenant?._id?.toString() ? '✅' : '❌';
  console.log(`  ${match} ${p.key} | _id: ${p._id?.toString()} | tenantId: ${p.tenantId}`);
}

const models = await tenantDb.collection('models').find({}).toArray();
console.log('\n── MODELS ───────────────────────────────────');
console.log('  count:', models.length);
const projectIds = new Set(projects.map(p => p._id?.toString()));
const projectMap = Object.fromEntries(projects.map(p => [p._id?.toString(), p.key]));
if (models.length > 0) {
  const byProject = {};
  for (const m of models) {
    const key = projectMap[m.projectId] || '(unknown)';
    byProject[key] = (byProject[key] || 0) + 1;
  }
  for (const [proj, cnt] of Object.entries(byProject)) {
    console.log(`  ${cnt} model(s) in project: ${proj}`);
  }
  const orphaned = models.filter(m => !projectIds.has(m.projectId));
  console.log('  orphaned:', orphaned.length);
}

const prompts = await tenantDb.collection('prompts').find({}).toArray();
console.log('\n── PROMPTS ──────────────────────────────────');
console.log('  count:', prompts.length);
const promptVersions = await tenantDb.collection('prompt_versions').find({}).toArray();
console.log('  versions count:', promptVersions.length);

const guardrails = await tenantDb.collection('guardrails').find({}).toArray();
console.log('\n── GUARDRAILS ───────────────────────────────');
console.log('  count:', guardrails.length);

const sessions = await tenantDb.collection('agent_tracing_sessions').find({}).toArray();
console.log('\n── TRACING SESSIONS ─────────────────────────');
console.log('  count:', sessions.length);

const seedMeta = await tenantDb.collection('__seed_metadata__').find({}).toArray();
console.log('\n── SEED VERSIONS ────────────────────────────');
for (const v of seedMeta) console.log(' ', v.version, '—', v.appliedAt?.toISOString());

await client.close();
