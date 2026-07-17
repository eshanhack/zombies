import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface LockPackage {
  dev?: boolean;
  optional?: boolean;
}

interface PackageManifest {
  name?: string;
  version?: string;
  license?: string | { type?: string };
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const failures: string[] = [];
const requiredFiles = [
  'README.md',
  'BUILDLOG.md',
  'DEPLOYMENT.md',
  'SECURITY.md',
  'assets/CREDITS.md',
  'ecosystem.config.cjs',
  'vercel.json',
  'dist/index.html',
  'dist/manifest.webmanifest',
  'dist/sw.js',
  'dist-server/server/src/index.js',
] as const;

for (const file of requiredFiles) check(existsSync(join(root, file)), `Missing release file: ${file}`);

const packageJson = json<{
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}>(join(root, 'package.json'));
const exactVersions: Record<string, string> = {
  typescript: '7.0.2',
  three: '0.185.1',
  vite: '8.1.5',
  vitest: '4.1.10',
  colyseus: '0.17.10',
  '@colyseus/sdk': '0.17.43',
  '@colyseus/schema': '4.0.27',
  'vite-plugin-pwa': '1.3.0',
};
for (const [name, expected] of Object.entries(exactVersions)) {
  const actual = packageJson.dependencies[name] ?? packageJson.devDependencies[name];
  check(actual === expected, `${name} must be pinned to ${expected}; received ${String(actual)}.`);
}

const disallowedNames = [
  'Y2FsbCBvZiBkdXR5', 'd29ybGQgYXQgd2Fy', 'dHJleWFyY2g=', 'bmF6aSB6b21iaWVz',
  'bmFjaHQgZGVyIHVudG90ZW4=', 'anVnZ2Vybm9n', 'c3BlZWQgY29sYQ==', 'ZG91YmxlIHRhcA==',
  'cXVpY2sgcmV2aXZl', 'cGFjay1hLXB1bmNo', 'cmF5IGd1bg==', 'd3VuZGVyd2FmZmU=',
  'aGVsbGhvdW5k', 'Y29kIDU=',
].map((encoded) => Buffer.from(encoded, 'base64').toString('utf8'));
const textExtensions = new Set(['.ts', '.js', '.cjs', '.mjs', '.json', '.md', '.html', '.css', '.svg', '.txt', '.example']);
const excludedDirectories = new Set(['.git', '.vercel', 'node_modules', 'dist', 'dist-server', 'evidence', 'coverage']);
for (const file of walk(root)) {
  if (!textExtensions.has(extname(file)) && basename(file) !== '.env.example') continue;
  const source = readFileSync(file, 'utf8').toLowerCase();
  for (const name of disallowedNames) {
    check(!source.includes(name), `Proprietary name found in ${relative(root, file)}.`);
  }
}

for (const sourceRoot of ['src/shared', 'server']) {
  for (const file of walk(join(root, sourceRoot))) {
    if (extname(file) !== '.ts') continue;
    check(!/Math\.random\s*\(/u.test(readFileSync(file, 'utf8')), `Nondeterministic RNG found in ${relative(root, file)}.`);
  }
}

const lock = json<{ packages: Record<string, LockPackage> }>(join(root, 'package-lock.json'));
const licenses = new Map<string, number>();
let runtimePackages = 0;
for (const [packagePath, metadata] of Object.entries(lock.packages)) {
  if (packagePath === '' || metadata.dev === true || !packagePath.includes('node_modules/')) continue;
  const manifestPath = join(root, packagePath, 'package.json');
  if (!existsSync(manifestPath)) {
    check(metadata.optional === true, `Runtime package manifest missing: ${packagePath}`);
    continue;
  }
  const manifest = json<PackageManifest>(manifestPath);
  const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type;
  check(typeof license === 'string' && license.length > 0, `Runtime package lacks a license: ${manifest.name ?? packagePath}`);
  if (license === undefined) continue;
  check(!/AGPL|SSPL|BUSL|Commons Clause|PolyForm|Elastic-2\.0/iu.test(license), `Restricted runtime license ${license}: ${manifest.name ?? packagePath}`);
  licenses.set(license, (licenses.get(license) ?? 0) + 1);
  runtimePackages += 1;
}

const credits = readFileSync(join(root, 'assets/CREDITS.md'), 'utf8');
check(credits.includes('No external source pixels are used.'), 'Asset provenance statement is missing.');
const ecosystem = readFileSync(join(root, 'ecosystem.config.cjs'), 'utf8');
check(ecosystem.includes('dist-server/server/src/index.js'), 'Cloud process entrypoint is incorrect.');
const clientSource = readFileSync(join(root, 'src/network/CoopClient.ts'), 'utf8');
check(clientSource.includes('VITE_GAME_SERVER_URL'), 'Production game-server environment variable is not wired.');
const serverSource = readFileSync(join(root, 'server/src/index.ts'), 'utf8');
check(serverSource.includes('matchMaker.controller.getCorsHeaders'), 'Matchmaking origin allow-list is not configured.');
check(serverSource.includes('verifyClient'), 'WebSocket origin verification is not configured.');
check(!serverSource.includes("from 'colyseus'"), 'Server imports the advisory-bearing umbrella runtime.');
check(packageJson.dependencies.colyseus === undefined && packageJson.devDependencies.colyseus === '0.17.10', 'Colyseus umbrella must remain pinned outside the runtime graph.');

const productionHtml = readFileSync(join(root, 'dist/index.html'), 'utf8');
const mainBundleMatch = productionHtml.match(/assets\/(index-[^"']+\.js)/u);
check(mainBundleMatch !== null, 'Production client bundle was not found.');
const mainBundle = mainBundleMatch?.[1] ?? '';
const artifactPaths = [
  join(root, 'dist/assets', mainBundle),
  ...readdirSync(join(root, 'public/assets/materials'))
    .filter((name) => name.endsWith('.png'))
    .sort()
    .map((name) => join(root, 'public/assets/materials', name)),
];
const artifacts = artifactPaths.map((file) => ({
  file: relative(root, file).replaceAll('\\', '/'),
  bytes: statSync(file).size,
  sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
}));
check((artifacts[0]?.bytes ?? Number.POSITIVE_INFINITY) < 1_500_000, 'Main client bundle exceeds the release size ceiling.');

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    runtimePackages,
    licenses: Object.fromEntries([...licenses.entries()].sort(([left], [right]) => left.localeCompare(right))),
    proprietaryNameMatches: 0,
    nondeterministicGameplayRngMatches: 0,
    artifacts,
  }, null, 2));
}

function check(condition: boolean, failure: string): void {
  if (!condition) failures.push(failure);
}

function json<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(absolute);
    else if (entry.isFile()) yield absolute;
  }
}
