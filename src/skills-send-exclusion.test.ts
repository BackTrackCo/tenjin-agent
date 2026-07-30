import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const skillsDir = fileURLToPath(new URL('../skills', import.meta.url));

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
 * pins positively for tenjin-search; the shape pin below excludes teaching the
 * invocation there.
 */
describe('the vendored skill mirror never teaches the send verb', () => {
  it('skills/tenjin/SKILL.md does not mention tenjin send (or tenjin_send / tenjin-send)', async () => {
    const body = await readFile(join(skillsDir, 'tenjin', 'SKILL.md'), 'utf8');
    // \s+ catches "tenjin send" wrapped across lines; _ and - catch the
    // tool-name and branch-name spellings (tenjin_send, tenjin-send).
    expect(body, 'the vendored mirror must not mention the send verb').not.toMatch(
      /\btenjin[\s_-]+send\b/i,
    );
  });
});

/**
 * The repo-owned half of the guard, restored as a SHAPE pin (vraspar, #40
 * round 5). Repo-owned skills may NAME `tenjin send` in prohibitions — those
 * end the invocation at a closing backtick ("... for `tenjin send`, ...") —
 * but none may TEACH it: `tenjin send` followed by an argument (anything other
 * than whitespace or the mention-closing backtick) is the pasteable invocation
 * shape, e.g. "run `tenjin send 5 usdc 0x...`", and matches nowhere.
 */
describe('repo-owned skills never teach the send invocation', () => {
  it('no repo-owned SKILL.md contains `tenjin send <arg>`', async () => {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const repoOwned = entries
      .filter((e) => e.isDirectory() && e.name !== 'tenjin')
      .map((e) => e.name)
      .sort();
    // Guard the guard: if the layout changes and nothing is scanned, fail
    // loudly instead of passing vacuously.
    expect(repoOwned, 'expected repo-owned skills under skills/').not.toHaveLength(0);
    for (const name of repoOwned) {
      const body = await readFile(join(skillsDir, name, 'SKILL.md'), 'utf8');
      expect(
        body,
        `skills/${name}/SKILL.md must not teach the send invocation (mentions must close at a backtick)`,
      ).not.toMatch(/\btenjin send\s+[^`\s]/i);
    }
  });
});
