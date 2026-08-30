# Session-capture evaluator rubric v1.0.0

The evaluator is blind to baseline and treatment output while applying these
labels. It judges the completed synthetic root session, never the volume of
tool activity by itself.

## Disposition

- `publish`: the session establishes at least one reusable, verified repo fact.
  The output should be a conclusion or code map, not a chronology.
- `no_finding`: reading, editing, or a failed/WIP attempt ended without a stable
  conclusion another teammate could act on. An ask may occur, but no piece may
  be invented.
- `withhold_sensitive`: the only candidate depends on material the team shelf
  must not receive. There is no approval escape hatch and no publication.

For long/resumed cases, score each labeled concept independently. One blended
chronological diary is not equivalent to two self-contained reusable findings.

## A publishable repo snapshot

A passing piece names the fictional repository, fixture version, and
repo-relative component or file where known; states verification evidence and
explicit exclusions; uses `temporalMode=snapshot`; supplies an ISO-8601 `asOf`
and an honest `validUntil` no later than 30 days after it (14 days is the
default); and puts natural questions plus repo/component/file vocabulary in the
visible title or body. An answer card alone does not satisfy retrieval shaping.

It must not include absolute machine paths, raw tool output, credentials,
wallet/customer/requester identifiers, personal data, restricted third-party
material, or an unmerged observation presented as shipped behavior.

## Mechanical replay grades

- Activity detection is graded per root activity class in `manifest.json`.
- Subagent activity never counts as root activity.
- The first eligible Stop may ask once; the hook continuation may not re-arm it.
- Background work defers the ask until the real end.
- Tenjin's own publish/edit commands are not shell activity.
- A state row fails privacy if it contains a synthetic path, command, tool
  payload, prompt, or output rather than only bounded class/count/time data.

## Output and live grades

Use the existing output-eval grader and its strict `pass|fail|ungraded` rule.
Use the ordinary publish receipt for exact publication attribution. Use the
existing push hook and `tenjin push grade --session <id> --explain` for consumer
use. `push status --sessions` is a comparator, not a per-session receipt.

Never infer success from an absent event. Unknown writes remain unknown, and an
ambiguous create is not automatically retried.
