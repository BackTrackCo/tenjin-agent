#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const files = ['AGENTS.md', 'CLAUDE.md'];
const contents = files.map((file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const header =
  /^<!-- Generated from tenjin-workspace\/tooling\/policy\/tenjin-agent-contributor\.md -->\n<!-- Source-SHA256: ([0-9a-f]{64}) -->\n\n/;

let failed = false;
for (const [index, content] of contents.entries()) {
  const match = header.exec(content);
  if (!match) {
    console.error(`${files[index]}: missing generated source header`);
    failed = true;
    continue;
  }
  const body = content.slice(match[0].length);
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== match[1]) {
    console.error(`${files[index]}: generated body digest mismatch`);
    failed = true;
  }
}
if (contents[0] !== contents[1]) {
  console.error('AGENTS.md and CLAUDE.md generated adapters differ');
  failed = true;
}
process.exitCode = failed ? 1 : 0;
