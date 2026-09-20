#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { mask } from '../../lib/redact';
import { releaseOwnedLocks } from '../../lib/lock';
import { writeFileAtomic } from '../../lib/atomic-json';
import { auditResources, snapshotCatalog, discoverCandidates } from './catalog';
import { ConfigSchema, hookOutput, runEvent, recordOutcome } from './runtime';
import type { AutoConfig, Outcome } from './runtime';
import { createBridgeHookOutput, normalizeBridgeEvent, serveBridge } from './bridge';
import { writeBridgeSetup } from './setup';

const program = new Command('tenjin-auto-mode').description(
  'Experimental local Jev → x402 runner. No backend; no global hook installation.',
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const json = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

async function loadConfig(path: string): Promise<{ config: AutoConfig; env: NodeJS.ProcessEnv }> {
  const config = ConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const env = { ...process.env };
  if (config.envFile) {
    const parsed = parseEnv(await readFile(config.envFile, 'utf8'));
    // The referenced env file stays where the operator put it. Do not import
    // unrelated backend credentials or expose their names/values in output.
    for (const key of [
      'TYPESAFE_KEY',
      'TYPESAFE_API_KEY',
      'TENJIN_WALLET_KEY',
      'TENJIN_WALLET_PASSPHRASE',
    ]) {
      if (parsed[key] && !env[key]) env[key] = parsed[key];
    }
  }
  return { config, env };
}

async function input(path?: string): Promise<unknown> {
  if (path) {
    const text = await readFile(path, 'utf8');
    if (text.length > 64_000) throw new Error('Hook input exceeds 64KB.');
    return JSON.parse(text);
  }
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > 64_000) throw new Error('Hook input exceeds 64KB.');
  }
  return JSON.parse(text);
}

program
  .command('init')
  .requiredOption(
    '--directory <path>',
    'New local experiment directory (must not contain config.json)',
  )
  .option('--mode <mode>', 'fixture | route (live Jev, no provider calls) | live', 'fixture')
  .option('--env-file <path>', 'Existing env file containing TYPESAFE_KEY or TYPESAFE_API_KEY')
  .option(
    '--catalog-file <path>',
    'Explicitly selected local CDP catalog; skips live discovery search',
  )
  .option('--wallet-dir <path>', 'Existing Tenjin wallet directory', join(homedir(), '.tenjin'))
  .option('--search-query <text...>', 'Optional 1–3 discovery seeds for WebSearch')
  .option('--fetch-query <text...>', 'Optional 1–3 discovery seeds for WebFetch')
  .option(
    '--allow-resource <method:url...>',
    'Live demo action scope, e.g. POST:https://api.exa.ai/search',
  )
  .action(async (options) => {
    const directory = resolve(options.directory as string);
    const allowedResources = ((options.allowResource ?? []) as string[]).map((entry) => {
      const split = entry.indexOf(':');
      const method = entry.slice(0, split).toUpperCase();
      const url = entry.slice(split + 1);
      if (!['GET', 'POST'].includes(method) || !url.startsWith('https://'))
        throw new Error('Demo scope must use GET:https://... or POST:https://...');
      return { method, url };
    });
    if (options.mode === 'live' && !allowedResources.length)
      throw new Error(
        'Live demo needs --allow-resource METHOD:URL to define its action scope. Payment authorization inside that scope is automatic.',
      );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const policyPath = join(directory, 'policy.json');
    const configPath = join(directory, 'config.json');
    const config = ConfigSchema.parse({
      version: 1,
      mode: options.mode,
      stateDir: join(directory, 'state'),
      policyPath,
      walletDir: resolve(options.walletDir as string),
      envFile: options.envFile ? resolve(options.envFile as string) : undefined,
      catalogFile: options.catalogFile ? resolve(options.catalogFile as string) : undefined,
      discoveryQueries: { WebSearch: options.searchQuery, WebFetch: options.fetchQuery },
    });
    // No-clobber config protects an existing experiment and its budget identity.
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(
      policyPath,
      JSON.stringify(
        {
          runId: randomUUID(),
          revision: randomUUID(),
          authorization: 'auto',
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
          maxCallAtomic: '100000',
          maxRunAtomic: '1000000',
          allowedOperations: ['search', 'fetch'],
          ...(allowedResources.length ? { allowedResources } : {}),
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    const command = `${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} hook --config ${quote(configPath)}`;
    const settingsPath = join(directory, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          enabledPlugins: {},
          permissions: { ask: ['WebSearch', 'WebFetch'] },
          hooks: {
            PreToolUse: [
              { matcher: 'WebSearch|WebFetch', hooks: [{ type: 'command', command, timeout: 90 }] },
            ],
          },
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    json({
      configPath,
      settingsPath,
      mode: config.mode,
      autoAuthorization: true,
      maxCallUsd: '0.10',
      maxRunUsd: '1.00',
      note: 'No global configuration changed. Policy expires in 24h. Fixture mode never invokes Jev, a wallet, or a provider.',
    });
  });

program
  .command('bridge-setup')
  .description(
    'Write isolated bridge settings beside an existing config; preserve its policy and ledger.',
  )
  .requiredOption('--config <path>')
  .action(async (options) => {
    const configPath = resolve(options.config as string);
    ConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
    json(await writeBridgeSetup(configPath, process.execPath, fileURLToPath(import.meta.url)));
  });

program
  .command('bridge')
  .description('Local stdio result carrier; never routes, signs, or requests provider data.')
  .requiredOption('--config <path>')
  .action(async (options) => {
    const config = ConfigSchema.parse(JSON.parse(await readFile(options.config as string, 'utf8')));
    await serveBridge(config);
  });

for (const command of ['hook', 'run', 'bridge-hook']) {
  program
    .command(command)
    .requiredOption('--config <path>')
    .option('--event <path>', 'Read hook event JSON from a file instead of stdin')
    .action(async (options) => {
      let outcome: Outcome;
      // Finish with a denial before Claude's command-hook timeout can discard
      // our output. Durable execution state prevents re-signing on restart.
      const watchdog = command.endsWith('hook')
        ? setTimeout(() => {
            json(
              hookOutput({
                status: 'pending',
                reason:
                  'Local execution deadline reached. Reconcile the saved attempt before retrying.',
              }),
            );
            releaseOwnedLocks();
            process.exit(0);
          }, 70_000)
        : undefined;
      let bridgeOutput: Awaited<ReturnType<typeof createBridgeHookOutput>> | undefined;
      try {
        const { config, env } = await loadConfig(options.config as string);
        const raw = await input(options.event as string | undefined);
        const event = command === 'bridge-hook' ? normalizeBridgeEvent(raw) : raw;
        outcome = await runEvent(event, config, { env });
        await recordOutcome(config, event, outcome);
        if (command === 'bridge-hook')
          bridgeOutput = await createBridgeHookOutput(config, raw, outcome);
      } catch (error) {
        outcome = {
          status: 'failed',
          reason: mask(error instanceof Error ? error.message : 'Auto-mode failed.'),
        };
      }
      clearTimeout(watchdog);
      json(bridgeOutput ?? (command.endsWith('hook') ? hookOutput(outcome) : outcome));
    });
}

program
  .command('discover')
  .requiredOption('--query <text>')
  .action(async (options) => json(await discoverCandidates(options.query as string)));
program
  .command('audit')
  .requiredOption('--output <path>')
  .option('--pages <count>', 'Maximum pages; report incomplete when capped', '200')
  .option('--duration-ms <count>', 'Maximum catalog enumeration time', '200000')
  .option('--snapshot <path>', 'Audit a saved {resources:[...]} snapshot without networking')
  .action(async (options) => {
    const snapshot = options.snapshot
      ? (JSON.parse(await readFile(options.snapshot as string, 'utf8')) as Awaited<
          ReturnType<typeof snapshotCatalog>
        >)
      : await snapshotCatalog({
          maxPages: Number(options.pages),
          maxDurationMs: Number(options.durationMs),
        });
    if (!Array.isArray(snapshot.resources))
      throw new Error('Snapshot must contain resources array.');
    const { resources, ...metadata } = snapshot;
    const audit = auditResources(resources);
    await writeFileAtomic(
      resolve(options.output as string),
      JSON.stringify({ ...metadata, ...audit }, null, 2),
    );
    json({
      output: resolve(options.output as string),
      complete: metadata.complete === true,
      total: audit.total,
      contractValidated: audit.contractValidated,
      unsupported: audit.unsupported,
      note: 'Contract validation is not paid-execution verification.',
    });
  });

process.once('SIGINT', () => {
  releaseOwnedLocks();
  process.exit(130);
});
process.once('SIGTERM', () => {
  releaseOwnedLocks();
  process.exit(143);
});
try {
  await program.parseAsync();
} catch (error) {
  json({
    status: 'failed',
    reason: mask(error instanceof Error ? error.message : 'Auto-mode failed.'),
  });
  process.exitCode = 1;
}
