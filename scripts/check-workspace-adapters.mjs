#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const header =
  /^<!-- Generated from tenjin-workspace\/tooling\/policy\/tenjin-agent-contributor\.md -->\n<!-- Source-SHA256: ([0-9a-f]{64}) -->\n\n/;

let failed = false;
const agents = read('AGENTS.md');
const match = header.exec(agents);
if (!match) {
  console.error('AGENTS.md: missing generated source header');
  failed = true;
} else if (createHash('sha256').update(agents.slice(match[0].length)).digest('hex') !== match[1]) {
  console.error('AGENTS.md: generated body digest mismatch');
  failed = true;
}
if (read('CLAUDE.md') !== '@AGENTS.md\n') {
  console.error('CLAUDE.md: must contain only the @AGENTS.md import');
  failed = true;
}
process.exitCode = failed ? 1 : 0;
