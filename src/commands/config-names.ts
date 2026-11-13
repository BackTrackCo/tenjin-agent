import { CliError } from '../lib/errors';
import { paint, sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';
import { closenessTo, closestNames, SEARCH_CLOSENESS, type Named } from '../lib/name-match';
import {
  cachedIdentities,
  entriesOf,
  fetchIdentities,
  KIND_NOUN,
  type Identities,
} from '../router/identities';
import { personalSettingsAt } from '../router/settings';
import type { TargetKind } from '../router/settings-wire';
import { resolveFromContext } from './config';
import { either, KIND_FLAG } from './config-readback';

/**
 * `tenjin config names [word] [--kind <kind>]`: EVERY NAME A RULE CAN USE,
 * like `kubectl api-resources`. It lists the identities the rules resolve
 * against, so a name found here is one `block`, `prefer` and `only` take:
 * the label a person reads and the id to type after its flag. A word filters
 * them loosely (case, spaces, hyphens and a typo set aside); `--kind` keeps
 * one kind. The router's free identities read first, then the copy the last
 * read kept, so it works offline once any command has read them.
 */

/** Test seams: the identities read's transport. */
export interface ConfigNamesDeps {
  fetchImpl?: typeof fetch;
}

/** The kinds in the order they print, each under the heading a person reads. */
const GROUPS: readonly { kind: TargetKind; heading: string }[] = [
  { kind: 'task', heading: 'Tasks' },
  { kind: 'category', heading: 'Categories' },
  { kind: 'provider', heading: 'Providers' },
  { kind: 'seller', heading: 'Sellers' },
  { kind: 'service', heading: 'Services' },
  { kind: 'source', heading: 'Accounts' },
];

/** What `--kind` takes, plurals too; an account is the `--source` kind. */
const KIND_WORDS: Readonly<Record<string, TargetKind>> = {
  task: 'task',
  tasks: 'task',
  category: 'category',
  categories: 'category',
  provider: 'provider',
  providers: 'provider',
  seller: 'seller',
  sellers: 'seller',
  service: 'service',
  services: 'service',
  account: 'source',
  accounts: 'source',
  source: 'source',
  sources: 'source',
};

/** One name as `--json` carries it. */
export interface NameRow {
  id: string;
  label: string;
  /** A task's category id. */
  category?: string;
  /** An account connected on this machine. */
  connected?: true;
}

export interface NameGroup {
  kind: TargetKind;
  flag: string;
  names: NameRow[];
}

/** Under this heading, a task with no category the read lists. */
const OTHER_TASKS = 'Other tasks';

/** The widest label column; a longer label pushes its id along. */
const MAX_LABEL_WIDTH = 44;

export async function runConfigNames(
  args: { search?: string; kind?: string },
  ctx: CommandContext,
  deps: ConfigNamesDeps = {},
): Promise<CommandResult> {
  const kind = args.kind === undefined ? undefined : kindOf(args.kind);
  const search = args.search?.trim() ?? '';
  const read = await readNames(ctx, deps);
  const { connected } = (await personalSettingsAt(ctx.dataDir)).accounts;
  const groups = GROUPS.filter((group) => kind === undefined || group.kind === kind).flatMap(
    ({ kind: groupKind }): NameGroup[] => {
      const names = entriesOf(read.identities, groupKind)
        .filter((entry) => search.length === 0 || closenessTo(search, entry) >= SEARCH_CLOSENESS)
        .map((entry) => rowOf(groupKind, entry, read.identities, connected));
      return names.length > 0 ? [{ kind: groupKind, flag: KIND_FLAG[groupKind], names }] : [];
    },
  );
  const total = groups.reduce((sum, group) => sum + group.names.length, 0);
  return {
    data: {
      ...(search.length > 0 ? { search } : {}),
      ...(kind !== undefined ? { kind } : {}),
      live: read.live,
      ...(read.reason !== undefined ? { reason: read.reason } : {}),
      total,
      groups,
    },
    humanLines: humanLines(ctx, groups, read, search, kind),
  };
}

/** The kinds `--kind` names, as a person types them. */
const KIND_CHOICES = ['task', 'category', 'provider', 'seller', 'service', 'account'];

function kindOf(word: string): TargetKind {
  const kind = KIND_WORDS[word.trim().toLowerCase()];
  if (kind !== undefined) return kind;
  const [near] = closestNames(
    KIND_CHOICES.map((choice) => ({ id: choice, label: choice })),
    word,
  );
  throw new CliError('USAGE', `--kind is one of ${either.format(KIND_CHOICES)}; got "${word}".`, {
    fix: `tenjin config names --kind ${near?.id ?? 'task'}`,
  });
}

interface NamesRead {
  identities: Identities;
  live: boolean;
  /** Why the live read failed, when the saved copy answered. */
  reason?: string;
}

/** The router's identities now, else the copy the last read kept, else why neither. */
async function readNames(ctx: CommandContext, deps: ConfigNamesDeps): Promise<NamesRead> {
  const { baseUrl } = await resolveFromContext(ctx);
  const read = await fetchIdentities(ctx, {
    baseUrl: baseUrl.value,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (read.ok) return { identities: read.identities, live: true };
  const saved = await cachedIdentities(ctx.dataDir);
  if (saved !== undefined) return { identities: saved, live: false, reason: read.reason };
  throw new CliError(
    read.unreachable === true ? 'API_UNREACHABLE' : 'NETWORK_ERROR',
    `Tenjin couldn't look up the names right now, and has none saved from before. (${read.reason})`,
    { fix: 'Try again once this machine is online: tenjin config names' },
  );
}

/** A task's category: its own, else the category that lists it. */
function categoryOf(task: string, identities: Identities): string | undefined {
  return (
    identities.tasks.find(({ id }) => id === task)?.category ??
    identities.categories.find(({ tasks }) => tasks.includes(task))?.id
  );
}

function rowOf(
  kind: TargetKind,
  { id, label }: Named,
  identities: Identities,
  connected: readonly string[],
): NameRow {
  const category = kind === 'task' ? categoryOf(id, identities) : undefined;
  return {
    id,
    label,
    ...(category !== undefined ? { category } : {}),
    ...(kind === 'source' && connected.includes(id) ? { connected: true as const } : {}),
  };
}

/** A line to print: indented, a label, and the id to type beside it. */
interface Line {
  indent: number;
  label: string;
  id?: string;
  note?: string;
}

/** A group's lines; tasks sit under their categories. */
function groupLines(group: NameGroup, identities: Identities): Line[] {
  if (group.kind !== 'task') {
    return group.names.map(({ id, label, connected }) => ({
      indent: 2,
      label,
      id,
      ...(connected === true ? { note: 'connected' } : {}),
    }));
  }
  const known = new Set(identities.categories.map(({ id }) => id));
  const under = (category: string | undefined) =>
    group.names
      .filter((row) =>
        category === undefined ? !known.has(row.category ?? '') : row.category === category,
      )
      .map(({ id, label }): Line => ({ indent: 4, label, id }));
  const headed = (label: string, tasks: Line[]): Line[] =>
    tasks.length > 0 ? [{ indent: 2, label }, ...tasks] : [];
  return [
    ...identities.categories.flatMap(({ id, label }) => headed(label, under(id))),
    ...headed(OTHER_TASKS, under(undefined)),
  ];
}

function humanLines(
  ctx: CommandContext,
  groups: readonly NameGroup[],
  read: NamesRead,
  search: string,
  kind: TargetKind | undefined,
): string[] {
  const dim = (text: string) => paint(ctx.io, 'dim', text);
  const stale = read.live
    ? []
    : [
        '',
        dim(
          "Tenjin couldn't reach its router just now, so these are the names it saved last time.",
        ),
      ];
  if (groups.length === 0) {
    const what = kind === undefined ? 'name' : KIND_NOUN[kind];
    const every =
      kind === undefined ? 'tenjin config names' : `tenjin config names --kind ${KIND_NOUN[kind]}`;
    if (search.length === 0) return [`Tenjin's router lists no ${what}s right now.`, ...stale];
    return [
      `No ${what} matches "${sanitizeForTerminal(search)}".`,
      dim(`Every ${what}: ${every}`),
      ...stale,
    ];
  }
  const sections = groups.map((group) => ({
    group,
    lines: groupLines(group, read.identities).map((line) => ({
      ...line,
      label: sanitizeForTerminal(line.label),
      ...(line.id !== undefined ? { id: sanitizeForTerminal(line.id) } : {}),
    })),
  }));
  const headings = groups.map(
    ({ kind: groupKind }) => GROUPS.find((g) => g.kind === groupKind)!.heading,
  );
  const width =
    Math.min(
      MAX_LABEL_WIDTH,
      Math.max(
        ...headings.map((heading) => heading.length),
        ...sections.flatMap(({ lines }) =>
          lines
            .filter((line) => line.id !== undefined)
            .map((line) => line.indent + line.label.length),
        ),
      ),
    ) + 2;
  const out: string[] = [];
  sections.forEach(({ group, lines }, index) => {
    if (index > 0) out.push('');
    out.push(`${headings[index]!.padEnd(width)}${dim(`(use with ${group.flag})`)}`);
    const idWidth = Math.max(...lines.map((line) => line.id?.length ?? 0));
    for (const line of lines) {
      const left = `${' '.repeat(line.indent)}${line.label}`;
      if (line.id === undefined) {
        out.push(left);
        continue;
      }
      const pad = left.length < width ? left.padEnd(width) : `${left}  `;
      out.push(
        line.note === undefined
          ? `${pad}${line.id}`
          : `${pad}${line.id.padEnd(idWidth)}   ${paint(ctx.io, 'green', line.note)}`,
      );
    }
  });
  return [...out, ...stale];
}
