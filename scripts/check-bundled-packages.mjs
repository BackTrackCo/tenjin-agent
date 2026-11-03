// Lists the third-party packages that ship in dist and fails when that set
// differs from scripts/bundled-packages.json, in either direction. Every
// dependency is bundled (the published `dependencies` is `{}`), so `npm audit`
// on an install sees none of them; this list is how a package entering or
// leaving the bundle shows up in review. It reads the esbuild metafiles
// tsup.config.ts writes to .bundle-meta, so it needs a `pnpm build` first.
//
//   node scripts/check-bundled-packages.mjs           # check the build against the list
//   node scripts/check-bundled-packages.mjs --write   # rewrite the list from the build
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const META_DIR = join(ROOT, '.bundle-meta');
const LIST = join(ROOT, 'scripts', 'bundled-packages.json');

function fail(message) {
  console.error(`check-bundled-packages: ${message}`);
  process.exit(1);
}

/** `node_modules/.pnpm/a@1/node_modules/@scope/name/x.js` -> `@scope/name` */
function packageOf(input) {
  const at = input.lastIndexOf('node_modules/');
  if (at === -1) return undefined;
  const [first, second] = input.slice(at + 'node_modules/'.length).split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

/** Every package with a byte in a built file; a module esbuild tree-shook away does not ship. */
function shippedPackages() {
  const files = existsSync(META_DIR)
    ? readdirSync(META_DIR).filter((f) => f.endsWith('.json'))
    : [];
  if (files.length === 0) fail('no metafiles in .bundle-meta; run `pnpm build` first.');
  const names = new Set();
  for (const file of files) {
    const { outputs } = JSON.parse(readFileSync(join(META_DIR, file), 'utf8'));
    for (const output of Object.values(outputs)) {
      for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
        const name = bytesInOutput > 0 ? packageOf(input) : undefined;
        if (name !== undefined) names.add(name);
      }
    }
  }
  return [...names].sort();
}

const shipped = shippedPackages();

if (process.argv.includes('--write')) {
  writeFileSync(LIST, `${JSON.stringify(shipped, null, 2)}\n`);
  console.error(
    `check-bundled-packages: wrote ${shipped.length} packages to scripts/bundled-packages.json`,
  );
  process.exit(0);
}

const listed = JSON.parse(readFileSync(LIST, 'utf8'));
const added = shipped.filter((name) => !listed.includes(name));
const removed = listed.filter((name) => !shipped.includes(name));
if (added.length > 0 || removed.length > 0) {
  fail(
    [
      'the packages bundled into dist differ from scripts/bundled-packages.json:',
      ...added.map((name) => `  + ${name}   (ships, not listed)`),
      ...removed.map((name) => `  - ${name}   (listed, no longer ships)`),
      'Review what entered or left the bundle, then run',
      '`node scripts/check-bundled-packages.mjs --write` and commit the list.',
    ].join('\n'),
  );
}
console.error(`check-bundled-packages: ${shipped.length} packages ship, all listed`);
