/**
 * THE TABLE THAT HOLDS THE TWO `repoSlug` COPIES TOGETHER (tenjin-agent#249).
 *
 * The coarse team-shelf key is salted with `host/full/path`, and that reduction
 * is written twice: once as the exported `repoSlug` in lib/state-store.ts, which
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
 * It is also the only thing pinning the two together. Nothing enforces
 * byte-identity between the bodies, and nothing should: what has to hold is
 * that they agree on every shape a `.git/config` can spell, which is what these
 * rows are.
 *
 * Not bundled into dist — nothing in the entry graph imports it — the same
 * pattern as lib/read-test-utils.ts.
 */
export const REPO_SLUG_CASES: ReadonlyArray<readonly [url: string, slug: string]> = [
  // The four spellings of one repo, which is the whole reason the salt is not
  // the URL: before #249 these were four different salts for one project. What
  // they differ in — scheme, userinfo, port, `.git`, a trailing slash — is
  // exactly what the reduction drops.
  ['git@github.com:acme/api.git', 'github.com/acme/api'],
  ['https://github.com/acme/api.git', 'github.com/acme/api'],
  ['https://github.com/acme/api', 'github.com/acme/api'],
  ['ssh://git@github.com/acme/api.git', 'github.com/acme/api'],
  // A port, a trailing slash, mixed case, and whitespace git never writes but a
  // hand-edited config can.
  ['ssh://git@github.com:2222/acme/api.git', 'github.com/acme/api'],
  ['ssh://git@github.com:22/acme/api/', 'github.com/acme/api'],
  ['https://github.com/acme/api/', 'github.com/acme/api'],
  ['https://GitHub.com/Acme/API.git', 'github.com/acme/api'],
  ['  git@github.com:acme/api.git  ', 'github.com/acme/api'],
  ['git://github.com/acme/api.git', 'github.com/acme/api'],
  // Userinfo is DROPPED, not hashed: a remote url can carry a token, and the
  // salt should not be the thing that carries it forward.
  ['https://someone:ghp_deadbeef@github.com/acme/api.git', 'github.com/acme/api'],
  // A different owner is a different salt: a fork does not read the upstream's
  // coarse keys, which is the scoping the salt exists for.
  ['git@github.com:other/api.git', 'github.com/other/api'],
  ['git@github.com:acme/web.git', 'github.com/acme/web'],
  // THE HOST IS PART OF THE SALT (round-1 review of #256). The same owner/name
  // on two hosts is two repos — a mirror, an internal fork, a self-hosted
  // rewrite — and dropping the host pooled them into one coarse scope.
  ['git@git.internal.acme.dev:acme/api.git', 'git.internal.acme.dev/acme/api'],
  ['git@git.internal.acme.dev:platform/api.git', 'git.internal.acme.dev/platform/api'],
  ['https://git.sr.ht/~user/api', 'git.sr.ht/~user/api'],
  // THE PATH IS KEPT WHOLE, for the same reason: the last-two rule pooled every
  // deep namespace that ended alike. These two GitLab paths share their final
  // two segments and are different repos.
  ['https://gitlab.com/acme/platform/api.git', 'gitlab.com/acme/platform/api'],
  ['https://gitlab.com/a/b/c/api.git', 'gitlab.com/a/b/c/api'],
  ['https://gitlab.com/x/y/c/api.git', 'gitlab.com/x/y/c/api'],
  // AZURE DEVOPS IS A KNOWN LIMIT, pinned rather than fixed: one repo, but the
  // https and ssh spellings carry different hosts AND different paths, so an
  // Azure team matches coarse keys only within a transport. Both strings stay
  // distinct and specific, which is the failure mode worth having — a miss that
  // reads as "no teammate has hit this", never a neighbouring repo's fix handed
  // over as a strong match. Un-splitting it means one forge's URL grammar in
  // the salt, and then the next forge's.
  ['https://dev.azure.com/org/proj/_git/api', 'dev.azure.com/org/proj/_git/api'],
  ['git@ssh.dev.azure.com:v3/org/proj/api', 'ssh.dev.azure.com/v3/org/proj/api'],
  // A single-segment path keeps its one name rather than falling back to ''.
  ['https://git.internal/api.git', 'git.internal/api'],
  // The scp form with an ABSOLUTE path, which self-hosted ssh remotes spell.
  // It is a remote and salts as one; before #256 it fell through to '' and
  // pooled with every origin-less checkout.
  ['git@git.acme.dev:/srv/git/api.git', 'git.acme.dev/srv/git/api'],
  ['git.acme.dev:/srv/git/api.git', 'git.acme.dev/srv/git/api'],
  // Everything that is not a remote salts as '', which is NOT a salt anything
  // publishes or queries under: it means no remote, and both sides skip the
  // coarse key entirely (#249, owner decision).
  ['', ''],
  ['   ', ''],
  ['/srv/mirrors/api', ''],
  ['../api', ''],
  ['./api.git', ''],
  ['file:///srv/mirrors/api.git', ''],
  // A host with no path under it names no repo.
  ['https://github.com/', ''],
  // A Windows drive letter is a path, not a `host:path` remote: the scp form
  // needs a DOTTED host, and `C` has no dot. That requirement is what keeps
  // these out — not the absolute-path exclusion, which is gone (see above).
  ['C:/src/api', ''],
  ['C:\\src\\api', ''],
];
