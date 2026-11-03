---
'tenjin-cli': minor
---

Shape the installed skills by team mode, replacing the guidance that differs
rather than annotating it.

A public-mode install is unchanged: `tenjin-search` and `tenjin-publish` render
byte-for-byte what they rendered before markers existed, and a digest pin in
`src/skills-text.test.ts` says so. On a machine in team mode — a shelf of the
team's own plus its door key — the sections whose guidance actually differs are
REPLACED. Nobody reads guidance for the mode they are not in, and no skill states
a rule and then an exception to it.

In team mode `tenjin-search` says a project-specific question is worth asking,
because the shelf holds quirks of this codebase, probe results and the reasoning
behind past decisions, where the marketplace would be a guaranteed miss.
`tenjin-publish` says teammate-useful instead of public-and-durable, free instead
of priced, and a scan that asks about credentials only — the whole block tier plus
`secret-assignment` and `hex32-value`, with the rest of the warn tier dropped.

One thing the team arm says that the previous appended paragraph did not: search
has no way to suppress the public leg. A team miss sends the SAME question string
to `publicShelfUrl`. So a team shelf relaxes the TOPIC, never the wording, and a
question must still be one you would accept being logged on a shelf that is not
yours. Secrets, credentials, customer and account names stay out in both modes.

The seam #147 left inert is now live, and gains an `else` arm so a region can be
replaced rather than added to: the two arms are exclusive by construction, so no
flag value can render both or neither. `skillContentFlags` is the one mapping from
machine facts to marker flags, and all five comparers go through it — `install`,
the post-command self-heal, the optional-skill placer and `doctor`'s staleness
compare materialize directly, and `scripts/pack-smoke.sh`, which cannot run the
resolver against a packed tarball, asserts the rendered properties instead.

Two behaviors worth knowing. Changing `baseUrl` or `shelfBypassSecret` makes the
wired copies stale, which `doctor` reports and the next ordinary command fixes with
no re-install. And a config that cannot be read or parsed heals NOTHING rather than
defaulting to public: guessing public on a team machine would rewrite every wired
skill to the other mode's guidance, under a notice claiming it now matches this
CLI. An absent config still reads as public, because no shelf is configured.

The mode is read from the stored config, never from a `--base-url` on the run: the
file being written outlives the command that wrote it.

`skills/tenjin/SKILL.md` is untouched. It is the byte-for-byte mirror of
`tenjin.blog/skills.md` that skill-drift CI diffs after re-running the sync, and
its reader has no CLI and so no mode.
