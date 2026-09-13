# Bench-3 historical task readiness

These are executable verifier readiness probes for historical public repository
tasks. They establish whether an independent behavioral test fails before and
passes after a known fix. They do not select the representative workload, freeze
pilot/locked assignments, or launch a model.

The representative workload frame is reviewed separately. Eligibility and clustering
remain separate from this small engineering shortlist. A readiness shortlist
chosen for clear transfer relationships must not become a team headline sample.

| Task             | Historical change               | Independent contract                                                                                  | Prior work                                                                              |
| ---------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `actor-grade`    | tenjin-agent#247, scoped subset | Injection grading reads the child's transcript even when the parent supplies opposite evidence        | Proposed earlier producer for `actor-score`                                             |
| `actor-score`    | tenjin-agent#251                | A worker only receives close/search credit for its own evidence; matching evidence still earns credit | #247 established actor-specific injection grading                                       |
| `release-policy` | tenjin-agent#170, scoped subset | Supported builds follow `latest`; absent/malformed `latest` cannot fall back to an unpromoted channel | #136's shared update resolver remains relevant, but its maximum-of-tags policy is stale |

`catalog.json` pins the before/after commit and tree, original PR URL, dependency
lock, scope and proposed earlier producer. Full original-PR boundaries stay in
the private evidence ledger. These replay commits are landed snapshots, not an
assumption that every PR's last commit is its complete diff.

Prepare each revision using a local checkout containing its Git objects:

```sh
python -m evals.benchmark.bench3.replay prepare \
  --repo /path/to/tenjin-agent --task actor-score --revision before \
  --out /path/to/new/actor-before
python -m evals.benchmark.bench3.replay build --context /path/to/new/actor-before
python -m evals.benchmark.bench3.replay verify \
  --context /path/to/new/actor-before --image sha256:IMAGE_ID \
  --run /path/to/readiness-results
```

Repeat with `--revision after` and a fresh output directory. Preparation reads
only committed source and verifies the tree and lock. Repository automation and
installed agent configuration are omitted explicitly; dirty checkout content,
host profiles and credentials are never copied. Installation uses the frozen
historical lock with lifecycle scripts disabled. Source execution happens only
in a network-free Harbor container using the shared Bench-1 container backend.
The same code-owned oracle is injected after source preparation for both sides.

The verifier runs exactly one test file, using the shared pinned Node image and
package-manager version. The image identity binds source, oracle, recipe and
platform. Import, collection, timeout and cleanup errors are invalid, never
evidence of a useful fail-before result. Receipts retain individual assertions,
test counts and cleanup status. A valid readiness pair requires an assertion
failure before, every assertion passing after, and successful cleanup on both.

Model experiments will use the shared Bench-1 runner and readouts. Before their
admission, each task still needs a frozen task prompt, producer acceptance where
applicable, earlier-knowledge cutoff, controlled corpus, and a declared sampling
assignment. Actor-shaped input data here does not establish live subagent or
dispatch coverage. The release-policy probe is explicitly a stale-knowledge
diagnostic; its old prescription is not a correct seeded answer.
