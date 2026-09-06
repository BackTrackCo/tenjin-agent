---
'tenjin-cli': minor
---

The loop daemon and its kernel (PR B of the loop redesign). `tenjin daemon
start|stop|status` runs one local process per data dir, bound on 127.0.0.1 with
a derived port and a bearer token, that serves every hook fire on the machine
through `POST /hook/claude` and exits after `loop.idle_exit_min` minutes without
one. The kernel is one lifecycle for every arm (`runFire`: actor, deadline,
gates, staged legs, one ledger row) over a new `~/.tenjin/loop.db`; the Claude
Code adapter decodes the native hook payload and encodes the response. Config
gains `loop.*` (four budget numbers plus `idle_exit_min` and `port`) and
`team.publicFallback`. Nothing is wired into a harness settings file yet: the
arms and the install wiring are the next PR, and the existing hook scripts keep
running unchanged.
