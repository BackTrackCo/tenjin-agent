/**
 * THE KERNEL'S bounds: every number the lifecycle, the store, the daemon and the
 * shim use that is not one of the two config knobs (`loop.human_wait_ms`,
 * `loop.tool_wait_ms`), each with the reason it is a constant
 * (tenjin-notes loop-redesign/02-redesign.md §7).
 *
 * An ARM's own bounds are not here and must not be moved here: they are evidence
 * about one arm's input — a prompt's junk thresholds, a file head's size, a
 * churn count — and each is only readable next to the code and the measurement
 * that justifies it. They live in `hooks/question.ts`, `hooks/text.ts`,
 * `hooks/legs/search.ts` and the arm files, and every one carries its reason
 * there the way these do here.
 */

/** Left on every fetch so the response can be encoded and flushed before the
 *  fire's own deadline lands. */
export const RESERVE_MS = 150;

/** The gap between a fire's deadline and the harness's own kill: encode, socket
 *  write, and the harness's parse. */
export const SLACK_MS = 500;

/**
 * The harness timeout `install` stamps on every entry, in ms. A backstop only:
 * the fire's own deadline (2500 or 4000) always lands first, and a hung daemon
 * costs a session this much per fire, never a stuck turn. Derived:
 * `tool_wait_ms + SLACK_MS = 4500 -> 5 s`.
 */
export const HARNESS_MS = 5000;

/**
 * How long the shim polls `/health` after spawning a daemon. A minimal daemon
 * measured 75 to 120 ms cold on this laptop (03-decisions.md, "Measured"); the
 * smoke test re-measures the real bundle against this number.
 */
export const SPAWN_MS = 500;

/** The shim's `GET /health` budget. Loopback answers in 1 to 2 ms; anything
 *  slower is a daemon mid-exit or a foreign listener. */
export const HEALTH_MS = 200;

/**
 * After a spawn that never became healthy, no shim spawns again for this long.
 * A corrupt `loop.db` or a half-written bundle must not cost every prompt a
 * spawn plus `SPAWN_MS`. The record is the mtime of an empty `daemon.spawn`
 * file; `tenjin doctor` reads it (PR E).
 */
export const SPAWN_BACKOFF_MS = 60_000;

/** A parked parent-to-child handoff and the parent-answer fallback live this
 *  long. A dispatch that never became a child must not seed a stranger later. */
export const HANDOFF_TTL_MS = 120_000;

/** Ledger rows older than this are deleted at the daemon's idle exit. Matches
 *  Claude Code's own transcript sweep default. */
export const RETENTION_DAYS = 30;

/** And past this many `fires` rows the oldest go regardless of age: a bound for
 *  a team on default-on, not for one laptop. */
export const FIRES_ROW_CAP = 50_000;

/** Retention runs in batches of this many rows: node 24's `node:sqlite` lacks
 *  `DELETE ... LIMIT`, so it is `WHERE id IN (SELECT ... LIMIT n)` looped. */
export const RETENTION_BATCH = 500;

/** Retention at idle exit stops after this long so a successor daemon is never
 *  refused the port for longer than a shim will wait. */
export const RETENTION_MAX_MS = 5000;

/** A request handler whose synchronous span exceeds this logs a warning: the
 *  daemon serves every session on the machine from one loop. */
export const IDLE_SYNC_WARN_MS = 20;

/** Largest hook body the daemon reads. A `tool_response` or
 *  `last_assistant_message` past this is 413 and a log line. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** `daemon.log` is truncated at daemon start once it passes this. No rotation:
 *  the idle exit bounds a log's lifetime already. */
export const LOG_TRUNCATE_BYTES = 5 * 1024 * 1024;

/** After the idle timer fires this much later than armed, the laptop slept:
 *  re-arm for {@link SLEEP_REARM_MS} instead of exiting under a resumed turn. */
export const SLEEP_GRACE_MS = 60_000;
export const SLEEP_REARM_MS = 120_000;

/** The daemon's `busy_timeout`: the CLI writes `loop.db` rarely and briefly, so
 *  a busy wait this long only ever happens at a CLI write's tail. */
export const DAEMON_BUSY_TIMEOUT_MS = 2000;

/** `server.requestTimeout` and `headersTimeout` for the daemon's listener. */
export const REQUEST_TIMEOUT_MS = 10_000;
export const HEADERS_TIMEOUT_MS = 5000;

/** The derived port range: `30000 + hash % 2000` sits below Linux's default
 *  ephemeral range (32768+) and below macOS/Windows's (49152+), so a transient
 *  outbound socket can never squat it. */
export const PORT_BASE = 30_000;
export const PORT_SPAN = 2000;

/** Claude Code caps `additionalContext` here; the encoder slices to it. */
export const CLAUDE_CONTEXT_MAX = 10_000;

/** How long `tenjin daemon stop` waits after SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 3000;
