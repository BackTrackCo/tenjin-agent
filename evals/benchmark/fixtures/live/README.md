# Shared benchmark fixture library

Bench-1 owns every task, hidden verifier, and lesson here. `catalog.json` lists the full
library with fixture hashes. Bench-2 and Bench-3 select tasks and treatments from this library;
they use the same container runtime and reporting infrastructure.

Task directories contain source and pinned dependency declarations. The shared image build
installs dependencies inside Docker; no host-native vendored dependency tree is required.
Hidden expectations live under `evals/benchmark/hidden`, outside agent-visible fixture copies.
Run configuration and experiment manifests are separate from this library review.
