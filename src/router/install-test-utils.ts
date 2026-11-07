import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The router's answer to install's and doctor's reachability probe, so no test reaches the network. */
export const probe400 = (async () =>
  new Response('{}', {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

export interface InstallSandbox {
  root: string;
  home: string;
  /** Tenjin's data dir: `<root>/data`, or `<home>/.tenjin` with `dataInHome`. */
  data: string;
  /** Where `CLAUDE_CONFIG_DIR` points; not created. */
  cfg: string;
  /** A git root of its own, so `router.*` never resolves from the suite's cwd. */
  work: string;
}

/**
 * A temp root for one install, doctor or uninstall test, with `home`, `data`
 * and `work` created. The root is its real path, so a symlinked tmpdir (macOS
 * `/var`) never spells one folder two ways.
 */
export async function installSandbox(
  prefix: string,
  opts: { dataInHome?: boolean } = {},
): Promise<InstallSandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const home = join(root, 'home');
  const data = opts.dataInHome === true ? join(home, '.tenjin') : join(root, 'data');
  const work = join(root, 'work');
  await mkdir(join(work, '.git'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
  return { root, home, data, cfg: join(root, 'cfg'), work };
}
