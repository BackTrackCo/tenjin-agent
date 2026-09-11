// The container entrypoint for one attempt, and the command that ends it.
//
// Harbor brings the service up with `sh -c "sleep infinity"` and execs the
// agent into the running container afterwards, so the daemon's life is no
// longer bracketed by one process. Two modes:
//
//   (no arguments beyond the keepalive)  start the daemon when BENCH2_DAEMON
//                                        is set, write `daemon.json`, then
//                                        exec the keepalive as pid 1.
//   --stop                               stop the daemon and any the shim
//                                        respawned, wait for the WAL, and
//                                        merge the result into `daemon.json`.
//
// The daemon lives here rather than on the host because the data dir it serves
// is a bind mount at the same absolute path in both, and a loopback daemon a
// hook posts to has to be reachable from inside this network namespace. The
// host reads what happened out of `daemon.json` in the trial's output root; a
// daemon that never became healthy is recorded there and the host refuses the
// attempt without ever execing the agent.
//
// The daemon is spawned detached from pid 1's own lifetime on purpose: pid 1
// is the keepalive, and `docker compose exec` is a different process, so
// nothing links the agent's exit to the daemon's.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_MS = 50;
const STOP_GRACE_MS = 5_000;
const WAL_TIMEOUT_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DAEMON_VAR = 'BENCH2_DAEMON';

function usage(message) {
  process.stderr.write(`bench2-trial: ${message}\n`);
  process.stderr.write('usage: bench2-trial [--stop] [command [args...]]\n');
  process.exit(2);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    const body = await response.json();
    return typeof body?.pid === 'number' && typeof body?.data_dir === 'string' ? body : null;
  } catch {
    return null;
  }
}

async function waitHealthy(dataDir, child, deadline) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the daemon exited with ${child.exitCode} before it was healthy`);
    }
    const record = readJson(join(dataDir, 'daemon.pid'));
    if (record && typeof record.port === 'number') {
      const body = await health(record.port);
      if (body && body.data_dir === dataDir && body.pid === child.pid) {
        return { pid: body.pid, port: record.port };
      }
    }
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(`the daemon did not answer /health within ${HEALTH_TIMEOUT_MS}ms`);
}

// The run's only route out is the allowlist proxy, and this container is on an
// `--internal` network. A daemon told nothing about the proxy dials each host
// directly and reaches nothing, so every shelf leg fails as a bare `error` with
// no search id while the attempt still passes its verifier and the run reports
// a plausible ratio. Node reads the addresses for `fetch` only under
// NODE_USE_ENV_PROXY, so the flag is one of them. Found 2026-09-09.
const FORWARDED = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'LANG',
  // The CLI's daily npm check is one request to a host no arm asked for; the
  // proxy refuses it and the refusal is what invalidates the trial.
  'TENJIN_NO_UPDATE_CHECK',
  // The daemon's shelf and marketplace legs are most of a trial's public
  // traffic, and an unnamed one counts as public demand.
  'TENJIN_CALLER_USER_AGENT',
];

async function startDaemon(dataDir, output) {
  const bundle = join(dataDir, 'hooks', 'tenjin-daemon.mjs');
  if (!existsSync(bundle)) throw new Error(`no tenjin-daemon.mjs under ${dataDir}/hooks`);
  const log = openSync(join(output, 'daemon.log'), 'a');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TENJIN_DATA_DIR: dataDir,
  };
  for (const name of FORWARDED) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const child = spawn(process.execPath, [bundle], {
    cwd: dataDir,
    stdio: ['ignore', log, log],
    env,
  });
  const live = await waitHealthy(dataDir, child, Date.now() + HEALTH_TIMEOUT_MS);
  return { child, ...live };
}

async function terminate(pid, graceMs) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return true;
  }
  const end = Date.now() + graceMs;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(HEALTH_POLL_MS);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone between the check and the signal.
  }
  return true;
}

// The shim starts a detached daemon of its own when the one it expects is not
// healthy. That process is this container's, so it is stopped here too, and
// the fact that it existed is what the record calls `daemon_respawned`.
async function stopDaemon(dataDir, started) {
  const report = { respawned: false, wal_live: false };
  const record = readJson(join(dataDir, 'daemon.pid'));
  if (record && typeof record.pid === 'number' && (!started || record.pid !== started.pid)) {
    const body = await health(record.port);
    if (body && body.data_dir === dataDir && body.pid === record.pid) {
      report.respawned = true;
      await terminate(record.pid, STOP_GRACE_MS);
    }
  }
  if (started) await terminate(started.pid, STOP_GRACE_MS);
  const wal = join(dataDir, 'loop.db-wal');
  const end = Date.now() + WAL_TIMEOUT_MS;
  while (existsSync(wal) && Date.now() < end) await sleep(HEALTH_POLL_MS);
  report.wal_live = existsSync(wal);
  return report;
}

function reportPath(output) {
  return join(output, 'daemon.json');
}

function mergeReport(output, fields) {
  const current = readJson(reportPath(output)) ?? {};
  const merged = { ...current, ...fields };
  writeFileSync(reportPath(output), JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

// The keepalive Harbor's compose file hands this entrypoint. Replacing this
// process with it keeps pid 1 the thing `docker compose down` signals.
function keepAlive(command) {
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // Already gone; there is nothing else this process owns.
    }
  };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));
  return new Promise((resolve) => {
    child.on('error', () => resolve(127));
    child.on('exit', (code, signal) => resolve(signal ? 128 : (code ?? 1)));
  });
}

async function start(output, dataDir) {
  const wanted = Boolean(process.env[DAEMON_VAR]);
  const report = { requested: wanted, started: false, pid: null, port: null, error: null };
  if (!wanted) {
    mergeReport(output, report);
    return null;
  }
  try {
    const live = await startDaemon(dataDir, output);
    mergeReport(output, { ...report, started: true, pid: live.pid, port: live.port });
    return live;
  } catch (error) {
    // A daemon that never became healthy is a refusal the host reads off this
    // file before it execs anything. The container still comes up, because a
    // service that exits is a compose failure rather than a readable one.
    mergeReport(output, { ...report, error: String(error?.message ?? error) });
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const stopping = argv[0] === '--stop';
  const command = stopping ? argv.slice(1) : argv;
  const output = process.env.BENCH2_OUTPUT;
  if (!output) usage('BENCH2_OUTPUT is not set');
  mkdirSync(output, { recursive: true });
  const dataDir = process.env.TENJIN_DATA_DIR ?? '';

  if (stopping) {
    const report = readJson(reportPath(output)) ?? {};
    const started = typeof report.pid === 'number' ? { pid: report.pid, port: report.port } : null;
    mergeReport(output, await stopDaemon(dataDir, started));
    return 0;
  }

  await start(output, dataDir);
  if (command.length === 0) usage('no command to keep the container alive');
  return keepAlive(command);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`bench2-trial: ${error?.stack ?? error}\n`);
    process.exit(70);
  },
);
