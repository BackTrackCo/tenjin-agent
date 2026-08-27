// Post-build guard: the bundle must not carry a bare `sqlite` specifier.
// esbuild rewrites `import('node:sqlite')` to `import("sqlite")` because it
// does not know the module as a builtin; that shipped a CLI whose store reads
// all failed open (2026-08-27). The source now resolves the module through
// process.getBuiltinModule, so a bare specifier here means someone wrote a
// literal import again. Fails the build rather than the next install.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(process.cwd(), 'dist');
const offenders = [];
for (const name of readdirSync(dist)) {
  if (!name.endsWith('.js')) continue;
  const text = readFileSync(join(dist, name), 'utf8');
  if (/import\(\s*["']sqlite["']\s*\)|require\(\s*["']sqlite["']\s*\)/.test(text)) {
    offenders.push(name);
  }
}
if (offenders.length > 0) {
  console.error(
    `check-dist-builtins: bare "sqlite" specifier in ${offenders.join(', ')} — use loadSqlite() (process.getBuiltinModule), never a literal import('node:sqlite') in CLI code.`,
  );
  process.exit(1);
}
console.log('check-dist-builtins: ok');
