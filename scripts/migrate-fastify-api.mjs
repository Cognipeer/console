import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const sourceApiDir = path.join(rootDir, 'src/app/api');
const targetApiDir = path.join(rootDir, 'src/server/api/routes');
const testsDir = path.join(rootDir, 'src/__tests__');
const manifestPath = path.join(rootDir, 'src/server/api/routeManifest.ts');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return walk(fullPath);
      }
      return [fullPath];
    }),
  );
  return files.flat();
}

function transformNextServerImports(source) {
  return source.replace(
    /import\s*\{([^}]+)\}\s*from\s*['"]next\/server['"];/g,
    (_match, rawSpecifiers) => {
      const specifiers = rawSpecifiers
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((specifier) => {
          if (specifier.startsWith('type ')) {
            return specifier;
          }
          if (specifier === 'NextRequest' || specifier === 'NextResponse') {
            return specifier;
          }
          return specifier;
        });

      return `import { ${specifiers.join(', ')} } from '@/server/api/http';`;
    },
  );
}

function stripRuntimeExport(source) {
  return source
    .replace(/^\s*export const runtime = ['"]nodejs['"];\n?/m, '')
    .replace(/\n{3,}/g, '\n\n');
}

function toRoutePath(relativeRouteFile) {
  const routeDir = relativeRouteFile.replace(/\/route\.ts$/, '');
  const segments = routeDir.split(path.sep).filter(Boolean);
  let catchAllParam;

  const routePath = segments
    .map((segment) => {
      const catchAllMatch = segment.match(/^\[\.\.\.(.+)\]$/);
      if (catchAllMatch) {
        catchAllParam = catchAllMatch[1];
        return '*';
      }

      const paramMatch = segment.match(/^\[(.+)\]$/);
      if (paramMatch) {
        return `:${paramMatch[1]}`;
      }

      return segment;
    })
    .join('/');

  return {
    catchAllParam,
    routePath: `/${routePath}`,
  };
}

function toImportPath(relativeRouteFile) {
  return `./routes/${relativeRouteFile.replace(/\.ts$/, '').split(path.sep).join('/')}`;
}

async function copyRoutes() {
  const files = (await walk(sourceApiDir))
    .filter((file) => file.endsWith('/route.ts'))
    .sort();

  await rm(targetApiDir, { force: true, recursive: true });

  const manifest = [];

  for (const file of files) {
    const relativePath = path.relative(sourceApiDir, file);
    const outputPath = path.join(targetApiDir, relativePath);
    const outputDir = path.dirname(outputPath);

    await mkdir(outputDir, { recursive: true });

    const source = await readFile(file, 'utf8');
    const transformed = stripRuntimeExport(transformNextServerImports(source));
    await writeFile(outputPath, transformed, 'utf8');

    const { routePath, catchAllParam } = toRoutePath(relativePath);
    manifest.push({
      catchAllParam,
      importPath: toImportPath(relativePath),
      relativePath,
      routePath,
    });
  }

  return manifest;
}

async function updateTests() {
  const files = (await walk(testsDir)).filter((file) => file.endsWith('.ts'));

  await Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, 'utf8');
      if (!source.includes("@/app/api/")) {
        return;
      }

      const updated = source.replaceAll(
        '@/app/api/',
        '@/server/api/routes/',
      );

      await writeFile(file, updated, 'utf8');
    }),
  );
}

async function writeManifest(entries) {
  const importLines = entries.map(
    (entry, index) => `import * as route${index} from '${entry.importPath}';`,
  );

  const manifestEntries = entries.map((entry, index) => {
    const catchAllLine = entry.catchAllParam
      ? `,\n    catchAllParam: '${entry.catchAllParam}'`
      : '';

    return `  {\n    importPath: '${entry.importPath}',\n    routePath: '${entry.routePath}'${catchAllLine},\n    module: route${index},\n  }`;
  });

  const output = `import type { ApiRouteManifestEntry } from './types';\n${importLines.join('\n')}\n\nexport const apiRouteManifest: ApiRouteManifestEntry[] = [\n${manifestEntries.join(',\n')}\n];\n`;
  await writeFile(manifestPath, output, 'utf8');
}

async function removeOldApiDir() {
  const exists = await stat(sourceApiDir).then(() => true).catch(() => false);
  if (exists) {
    await rm(sourceApiDir, { force: true, recursive: true });
  }
}

async function main() {
  const manifest = await copyRoutes();
  await writeManifest(manifest);
  await updateTests();
  await removeOldApiDir();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
