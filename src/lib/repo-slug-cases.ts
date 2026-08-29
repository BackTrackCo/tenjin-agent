/**
 * THE TABLE THAT HOLDS THE TWO `repoSlug` COPIES TOGETHER (tenjin-agent#249).
 *
 * The coarse team-shelf key is salted with `owner/name`, and that reduction is
 * written twice: once as the exported `repoSlug` in lib/state-store.ts, which
 * `tenjin sync` publishes with, and once inside the generated failure arm
 * (lib/push-scripts.ts), which the resolve leg queries with — a hook script
 * cannot import, so it carries a copy. The two must reduce one remote to the
 * SAME string or a query and the post it should find salt two different ways
 * and never meet, and the miss looks exactly like "no teammate has hit this".
 *
 * So the table lives here, outside both test files, and BOTH implementations are
 * run against it: state-store.test.ts against the export, push-scripts.test.ts
 * against the copy it lifts out of the generated source. Adding a case to one
 * side is impossible; a shape either holds for both or the suite is red.
 *
 * Not bundled into dist — nothing in the entry graph imports it — the same
 * pattern as lib/read-test-utils.ts.
 */
export const REPO_SLUG_CASES: ReadonlyArray<readonly [url: string, slug: string]> = [
  // The four spellings of one repo, which is the whole reason the salt is not
  // the URL: before #249 these were four different salts for one project.
  ['git@github.com:acme/api.git', 'acme/api'],
  ['https://github.com/acme/api.git', 'acme/api'],
  ['https://github.com/acme/api', 'acme/api'],
  ['ssh://git@github.com/acme/api.git', 'acme/api'],
  // A port, a trailing slash, mixed case, and whitespace git never writes but a
  // hand-edited config can.
  ['ssh://git@github.com:2222/acme/api.git', 'acme/api'],
  ['https://github.com/acme/api/', 'acme/api'],
  ['https://GitHub.com/Acme/API.git', 'acme/api'],
  ['  git@github.com:acme/api.git  ', 'acme/api'],
  ['git://github.com/acme/api.git', 'acme/api'],
  // Userinfo is DROPPED, not hashed: a remote url can carry a token, and the
  // salt should not be the thing that carries it forward.
  ['https://someone:ghp_deadbeef@github.com/acme/api.git', 'acme/api'],
  // A different owner is a different salt: a fork does not read the upstream's
  // coarse keys, which is the scoping the salt exists for.
  ['git@github.com:other/api.git', 'other/api'],
  ['git@github.com:acme/web.git', 'acme/web'],
  // Self-hosted and non-GitHub hosts reduce the same way; a GitLab subgroup
  // keeps its last two segments so two subgroups' `api` do not collide.
  ['git@git.internal.acme.dev:platform/api.git', 'platform/api'],
  ['https://gitlab.com/acme/platform/api.git', 'platform/api'],
  ['https://git.sr.ht/~user/api', '~user/api'],
  // A single-segment path keeps its one name rather than falling back to ''.
  ['https://git.internal/api.git', 'api'],
  // Everything that is not a remote salts as '' — a real salt, sent by both
  // sides, and not a reason to drop the coarse key.
  ['', ''],
  ['   ', ''],
  ['/srv/mirrors/api', ''],
  ['../api', ''],
  ['./api.git', ''],
  ['file:///srv/mirrors/api.git', ''],
  ['https://github.com/', ''],
  // A Windows drive letter is a path, not a `host:path` remote: the scp form
  // needs a dotted host, which is what keeps these out.
  ['C:/src/api', ''],
  ['C:\\src\\api', ''],
];
