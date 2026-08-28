---
'tenjin-cli': minor
---

`tenjin update` re-materializes what `install` wrote, instead of swapping only
the binary.

The skills and the generated hook scripts are copies of a particular version, so
an upgrade left them at the previous one until someone re-ran `tenjin install` by
hand. The highest-volume request path kept reporting the old version, and agents
kept reading the previous release's guidance. `update` now spawns
`tenjin install --refresh` on the freshly installed entry once the swap
succeeds, and the stale "New builds pick it up immediately" line is replaced by a
report of what the refresh actually did.

`install --refresh` is a new non-interactive mode: it re-renders the wired
skills, rewrites the hook scripts already on disk, and updates the settings.json
hook entries this CLI already owns. It adds nothing. A skill that is not wired
stays unwired, a script that is absent stays absent, an event with no entry of
ours gets none, and no permission rule is written at all: rules a newer version
would grant are reported and left for an explicit `tenjin install`, because
widening an agent's allowlist during an unattended upgrade is not a refresh. It
never prompts, never creates a wallet, and never writes config. It refuses
`--dry-run`, which the mode dispatches above and so could not honour. On a
machine where nothing was ever installed there is nothing to converge, and it
says so and exits non-zero rather than reporting a refresh that did not happen.

The refresh runs once per profile whose hooks this machine has registered, with
`TENJIN_DATA_DIR` set to each. `install` bakes its data dir into the scripts it
generates, so a machine set up under a redirected data dir has hooks belonging to
that profile while a bare `tenjin update` resolves the default one; refreshing
only the invoking profile would leave the scripts the harness actually fires
stale forever. A new `detectHookOwners` reads those profiles back out of the
harness settings, tolerating anything it finds there. Each pass converges only
the entries already pointed at its own data dir, so two profiles on one machine
never repoint each other's hooks, and a shelf profile with the push experiment on
cannot widen the default profile's matcher.

A failed, refused or timed-out refresh, or one that found nothing to converge, is
a warning naming `tenjin install` and never fails the update: the swap already
happened, and it is what was asked for.

Those profile paths come out of a settings file this CLI does not own, so a
detected data dir that is not already a directory is reported rather than
created, the list is capped, and the children run with the update check off so a
refresh materializes no tree and makes no registry request of its own.

Two things the refresh will not do. It does not re-execute an entry path that
names a version: under pnpm `process.argv[1]` points into the virtual store,
whose directory names pin one, so running it after the swap would execute the
build that was just replaced and report success over the previous version's
bytes. The version-free link beside the store is derived and used when it is
there, and otherwise the profile is reported unrefreshed. And it rewrites a hook
script only when the bytes on disk carry the generated header marker, never
through a symlink standing where a script should be, and not at all when the
`hooks` directory has itself been replaced by a link: an unattended writer takes
its paths from settings.json, which anything on the machine can write, so a path
of the right shape is not proof that the file at it is ours. Symlinks above the
data dir are left alone, since those are ordinary machine layout.
