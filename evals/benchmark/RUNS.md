# Benchmark framework configuration

Bench-1 owns smoke configuration, shared hook presets, the container CI runner, and reusable
reporting/artifact plumbing. Local and CI runs use the same Docker Compose execution path.
Colima can provide Docker locally; no host-native live runner is needed.

Pass `--manifest PATH` to `live-run` and `--baseline PATH` to `regress`. The framework smoke
configurations live in `configuration.py`. Bench-2 experiment selections and their callers
live above this layer. Configuration tests are in `tests/test_framework_configuration.py`.

The promoted plumbing workflow still explicitly selects its provisional September 7 baseline.
The next planned regression change in Bench-1 #334/#347 will select the last completed matching
main-run artifact for PR comparisons, then remove that old numerical input. This promotion
preserves the existing comparison until that replacement is tested. History stays in
`tenjin-notes`; neither these smoke numbers nor the existing capture-only headline is hardened.
