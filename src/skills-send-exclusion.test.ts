import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * The skills-side twin of the MCP-toolset pin in mcp/server.test.ts: `tenjin
 * send` is a human-invoked escape hatch and no skill may teach it. The vendored
 * skills/tenjin/SKILL.md is synced byte-for-byte from tenjin.blog/skills.md by
 * CI (skill-drift.yml), which checks drift but not content, so a remote edit
 * mentioning send would otherwise land here silently.
 *
 * Scope (operator decision on #40, reconciling with #41): this pin covers the
 * VENDORED MIRROR ONLY — the one skill whose text arrives from a remote. The
 * repo-owned skills may name `tenjin send` in name-to-forbid prohibitions
 * ("Never propose an allowlist line for ..."), which src/skills-text.test.ts
 * pins positively for tenjin-search. Teaching the verb is still excluded there
 * by those tests' shape: prohibition prose only, never a pasteable fenced rule.
 */
describe('the vendored skill mirror never teaches the send verb', () => {
  it('skills/tenjin/SKILL.md does not mention tenjin send (or tenjin_send / tenjin-send)', async () => {
    const mirror = fileURLToPath(new URL('../skills/tenjin/SKILL.md', import.meta.url));
    const body = await readFile(mirror, 'utf8');
    // \s+ catches "tenjin send" wrapped across lines; _ and - catch the
    // tool-name and branch-name spellings (tenjin_send, tenjin-send).
    expect(body, 'the vendored mirror must not mention the send verb').not.toMatch(
      /\btenjin[\s_-]+send\b/i,
    );
  });
});
