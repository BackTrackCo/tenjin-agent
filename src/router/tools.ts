import type { CommandContext, CommandResult } from '../context';
import { loadRawConfig, resolveSettings } from '../lib/config';
import {
  describeLimits,
  POLICY_INVALID_TEXT,
  replacementSupport,
  settingsReadback,
  type ReplacementSupport,
  type RuleReadback,
} from '../commands/config-readback';
import { allowed, type AccessRule } from './access';
import type { DirectoryListing } from './decision';
import { cachedDirectory, fetchDirectory, labelOf } from './directory';
import { routerSettings, type RouterSettings } from './settings';

export interface ToolsRow {
  id: string;
  label: string;
  task: string;
  source: string;
  state: 'enabled' | 'disabled' | 'unverified' | 'unavailable';
  reason: string;
}

export interface ToolsView {
  catalog: 'current' | 'cached' | 'unavailable';
  revision?: string;
  filter: string;
  enabled: RouterSettings['enabled'];
  rows: ToolsRow[];
  header: string[];
  lines: string[];
}

export interface ToolsDeps {
  cwd?: string;
  fetchImpl?: typeof fetch;
  support?: ReplacementSupport;
}

const text = (value: string) =>
  value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim()
    .slice(0, 1000);

function ruleReason(rule: AccessRule, rules: RuleReadback[], listing: DirectoryListing): string {
  if (rule.kind === 'unavailable')
    return `${labelOf(rule.target!, listing)} is not connected on this machine.`;
  if (rule.kind === 'block')
    return `Blocked by your ${rule.target!.kind} setting: ${labelOf(rule.target!, listing)}.`;
  const readback = rules.find(
    (entry) =>
      entry.kind === 'only' &&
      'scope' in entry.rule &&
      'dimension' in entry.rule &&
      entry.rule.dimension === rule.dimension &&
      entry.rule.scope.kind === rule.scope?.kind &&
      (entry.rule.scope.kind === 'global' ||
        (rule.scope?.kind === 'task' && entry.rule.scope.id === rule.scope.id)),
  );
  return `Excluded by your restriction. ${readback?.text ?? 'Your settings allow other services only.'}`;
}

/** One read-only projection for the CLI and /tenjin-tools. No task text is sent:
 * the only network request is the free directory, without routing or payment. */
export async function runTools(
  { filter = '' }: { filter?: string },
  ctx: CommandContext,
  deps: ToolsDeps = {},
): Promise<CommandResult & { data: ToolsView }> {
  const initial = await loadRawConfig(ctx.dataDir);
  const base = resolveSettings({
    config: initial,
    flags: { baseUrl: ctx.flags.baseUrl },
    env: process.env,
  });
  const fetched = await fetchDirectory(ctx.dataDir, {
    ctx,
    baseUrl: base.baseUrl.value,
    timeoutMs: ctx.flags.timeout,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const listing = fetched.ok ? fetched.listing : await cachedDirectory(ctx.dataDir);
  const catalog = fetched.ok ? 'current' : listing ? 'cached' : 'unavailable';
  // Read after the network wait: a block saved while the directory was loading
  // must already be visible when this invocation answers.
  const raw = await loadRawConfig(ctx.dataDir);
  const router = await routerSettings({
    cwd: deps.cwd ?? process.cwd(),
    dataDir: ctx.dataDir,
    config: raw,
  });
  const effective = resolveSettings({ config: raw, flags: {}, env: process.env });
  const readback = settingsReadback(
    router,
    listing,
    describeLimits(effective.maxAutoSpend.value, effective.sessionBudget.value),
    deps.support ?? (await replacementSupport(ctx.dataDir)),
  );
  const rows: ToolsRow[] = (listing?.services ?? []).map(({ id, label, identity }) => {
    const access = allowed(
      identity,
      router.policy.status === 'ok' ? router.policy.wire : undefined,
    );
    let state: ToolsRow['state'] = 'enabled';
    let reason = 'Allowed by your settings.';
    if (!router.enabled.value) {
      state = 'disabled';
      reason = `Tenjin is paused by ${router.enabled.source === 'default' ? 'default' : router.enabled.source} settings.`;
    } else if (router.policy.status === 'invalid') {
      state = 'disabled';
      reason = "Your Tenjin settings can't be read; services won't run until they are fixed.";
    } else if (!access.ok) {
      state = 'disabled';
      reason = ruleReason(access.rule, readback.data.rules, listing!);
    }
    if (catalog !== 'current') {
      reason = `Cached assessment: ${reason} The catalog could not be verified.`;
      state = 'unverified';
    }
    return {
      id,
      label: text(label),
      task: text(identity.task ?? 'Other tools'),
      source: text(labelOf({ kind: 'source', id: identity.source }, listing)),
      state,
      reason: text(reason),
    };
  });
  const savedTargets =
    router.policy.status === 'ok'
      ? [
          ...(router.policy.saved.block ?? []),
          ...(router.policy.saved.only ?? []).flatMap(({ targets }) => targets),
          ...(router.policy.saved.prefer ?? []).flatMap(({ targets }) => targets),
        ]
      : [];
  const missing = new Set([
    ...(listing?.retired.filter(({ kind }) => kind === 'service').map(({ id }) => id) ?? []),
    ...savedTargets.filter(({ kind }) => kind === 'service').map(({ id }) => id),
  ]);
  for (const id of missing) {
    if (rows.some((row) => row.id === id)) continue;
    rows.push({
      id,
      label: text(labelOf({ kind: 'service', id }, listing)),
      task: 'Saved or retired tools',
      source: '',
      state: catalog === 'current' ? 'unavailable' : 'unverified',
      reason:
        catalog === 'current'
          ? 'Not in the current catalog.'
          : 'No current catalog could verify this saved tool.',
    });
  }
  const query = text(filter).toLowerCase();
  const shown = rows.filter((row) =>
    [row.label, row.task, row.source, row.state, row.reason].some((part) =>
      part.toLowerCase().includes(query),
    ),
  );
  shown.sort(
    (a, b) =>
      a.task.localeCompare(b.task) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
  const header = [
    catalog === 'current'
      ? 'Current catalog · enabled and disabled by your settings.'
      : catalog === 'cached'
        ? 'Cached catalog · current availability is unverified.'
        : 'Catalog unavailable · no tool availability could be verified.',
    `${shown.length} of ${rows.length} tools${query ? ` matching “${text(filter)}”` : ''}.`,
    `Tenjin ${router.enabled.value ? 'on' : 'paused'} · ${router.enabled.source} settings.`,
    ...(router.policy.status === 'invalid' ? [POLICY_INVALID_TEXT] : []),
    readback.data.replacement.text,
    readback.data.limits.text,
    ...readback.data.rules
      .filter(({ kind }) => kind === 'prefer')
      .map(({ text, inactive }) => `${text}${inactive ? ` ${inactive}` : ''}`),
    'Enabled describes settings permission. Host support, account checks and spending limits still apply when a tool runs.',
    'Ask your agent to change a setting with tenjin config. This view changes nothing.',
  ].map(text);
  const lines = shown.map(
    (row) =>
      `${row.task} · ${row.label} — ${row.state}${row.source ? ` · ${row.source}` : ''}. ${row.reason}`,
  );
  const data: ToolsView = {
    catalog,
    ...(listing ? { revision: listing.revision } : {}),
    filter: text(filter),
    enabled: router.enabled,
    rows: shown,
    header,
    lines,
  };
  return { data, humanLines: [...header, '', ...(lines.length ? lines : ['No matching tools.'])] };
}
