import { z } from 'zod';
import { sha256Hex } from '../lib/hash';

/**
 * THE USER'S SETTINGS AS THE ROUTER READS THEM (plan 36). What Tenjin may use
 * (`block`, `only`), what it tries first (`prefer`), whether it offers paid
 * tools that are only faster (`preferSpeed`), and whether a host may run its
 * pick in place of a native search or fetch (`replacement`). The server is
 * the only place these rules are applied and ranked; this client validates
 * their shape, stores canonical ids, sends them on every routing call and
 * checks, before any call runs, that the offer was decided under the rules
 * saved now (`settings-check.ts`). It keeps no copy of the rule logic.
 *
 * The shapes and bounds are the contract's (`settings` request field, v1):
 * a typed target `{kind, id}`, a scope, and the limits on each collection.
 * This client is stricter than the server in two places, never looser: an
 * `only` rule is scoped globally or to one task, and a capability rule only
 * globally, because no command writes anything else.
 *
 * Hook-safe: node (through `lib/hash`) and zod only.
 */

/** The `accepts` token for this feature, and the field's own version. */
export const SETTINGS_ACCEPT = 'settings';
export const SETTINGS_VERSION = 1;
/** The saved `router.policy` version this build reads. */
export const POLICY_VERSION = 1;

/** Tenjin's own catalog, the one source every machine has. */
export const BUILT_IN_SOURCE = 'tenjin';

export const TARGET_KINDS = [
  'category',
  'task',
  'provider',
  'seller',
  'service',
  'source',
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const ONLY_DIMENSIONS = ['capability', 'provider', 'seller', 'service'] as const;
export type OnlyDimension = (typeof ONLY_DIMENSIONS)[number];

export const REPLACEMENT_MODES = ['off', 'when-routed'] as const;
export type ReplacementMode = (typeof REPLACEMENT_MODES)[number];

/** The contract's bounds: past one, the server ignores the whole field. */
export const SETTINGS_LIMITS = {
  block: 64,
  only: 32,
  prefer: 64,
  targets: 16,
  sources: 16,
} as const;

/** The hash the CLI computes and the server echoes, never recomputes. */
const SETTINGS_HASH = /^sha256:[0-9a-f]{64}$/;
export const SettingsHashSchema = z.string().regex(SETTINGS_HASH);

/** A canonical id: 1 to 120 characters, one plain line. Task ids carry spaces. */
export const TargetIdSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((id) => id.trim() === id && !/[\p{Cc}\p{Cf}]/u.test(id), 'one plain line, trimmed');

export const TargetSchema = z.strictObject({ kind: z.enum(TARGET_KINDS), id: TargetIdSchema });
export type Target = z.infer<typeof TargetSchema>;

export const ScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('task'), id: TargetIdSchema }),
  z.strictObject({ kind: z.literal('category'), id: TargetIdSchema }),
]);
export type Scope = z.infer<typeof ScopeSchema>;

const Targets = z.array(TargetSchema).min(1).max(SETTINGS_LIMITS.targets);

export const OnlyRuleSchema = z.strictObject({
  scope: ScopeSchema,
  dimension: z.enum(ONLY_DIMENSIONS),
  targets: Targets,
});
export type OnlyRule = z.infer<typeof OnlyRuleSchema>;

export const PreferRuleSchema = z.strictObject({ scope: ScopeSchema, targets: Targets });
export type PreferRule = z.infer<typeof PreferRuleSchema>;

/** The rules alone, as a request carries them: every collection omitted when empty. */
export interface WirePolicy {
  block?: Target[];
  only?: OnlyRule[];
  prefer?: PreferRule[];
  preferSpeed?: true;
}

/** Automatic use, as a request carries it: omitted when off. */
export interface WireReplacement {
  mode: 'when-routed';
  /** Absent: every eligible provider. */
  providers?: Target[];
}

/** The `settings` request field, exactly. */
export interface WireSettings {
  version: typeof SETTINGS_VERSION;
  hash: string;
  policy: WirePolicy;
  replacement?: WireReplacement;
  sources: string[];
}

/** One structural key per target, scope and rule. */
export const targetKey = (target: Target): string => `${target.kind}:${target.id}`;
export const scopeKey = (scope: Scope): string =>
  scope.kind === 'global' ? 'global' : `${scope.kind}:${scope.id}`;
/** An only rule's slot: one per scope and dimension. */
export const onlyKey = (rule: Pick<OnlyRule, 'scope' | 'dimension'>): string =>
  `${scopeKey(rule.scope)}|${rule.dimension}`;

/** A problem a check found, at its path inside the policy. */
export interface Problem {
  path: (string | number)[];
  message: string;
}

/** The target kinds an `only` dimension takes. */
const DIMENSION_KINDS: Record<OnlyDimension, readonly TargetKind[]> = {
  capability: ['category', 'task'],
  provider: ['provider'],
  seller: ['seller'],
  service: ['service'],
};

/** The kinds a preference may list. A global one lists sources alone, which
 *  {@link policyProblems} checks on its own. */
const PREFER_KINDS: readonly TargetKind[] = ['provider', 'service', 'source'];

function duplicates<T>(values: readonly T[], key: (value: T) => string): number[] {
  const seen = new Set<string>();
  const at: number[] = [];
  values.forEach((value, index) => {
    const k = key(value);
    if (seen.has(k)) at.push(index);
    seen.add(k);
  });
  return at;
}

/**
 * EVERY CHECK BEYOND SHAPE, as this client writes rules. Duplicates are
 * refused, never resolved first-wins or last-wins: a duplicate `only` entry
 * for one scope and dimension, a duplicate `prefer` entry for one scope, and
 * a target named twice in one list. Each list is homogeneous: an `only` rule's
 * targets are its dimension's kind (categories and tasks for `capability`); a
 * preference's are all one kind of provider, service or source, and a global
 * preference holds sources only. There is no source `only`: "only use my
 * account for X" is a preference.
 */
export function policyProblems(policy: Pick<SavedPolicy, 'block' | 'only' | 'prefer'>): Problem[] {
  const problems: Problem[] = [];
  const block = policy.block ?? [];
  const only = policy.only ?? [];
  const prefer = policy.prefer ?? [];
  for (const index of duplicates(block, targetKey))
    problems.push({ path: ['block', index], message: 'this target is already blocked' });
  for (const index of duplicates(only, onlyKey))
    problems.push({
      path: ['only', index],
      message: 'a second only rule for the same scope and dimension',
    });
  for (const index of duplicates(prefer, (rule) => scopeKey(rule.scope)))
    problems.push({ path: ['prefer', index], message: 'a second preference for the same scope' });
  only.forEach((rule, index) => {
    const kinds = DIMENSION_KINDS[rule.dimension];
    if (rule.scope.kind === 'category')
      problems.push({
        path: ['only', index, 'scope'],
        message: 'an only rule is global or a task',
      });
    if (rule.dimension === 'capability' && rule.scope.kind !== 'global')
      problems.push({
        path: ['only', index, 'scope'],
        message: 'a task and category limit is global',
      });
    rule.targets.forEach((target, at) => {
      if (!kinds.includes(target.kind))
        problems.push({
          path: ['only', index, 'targets', at],
          message: `a ${rule.dimension} rule names ${kinds.join(' or ')} targets`,
        });
    });
    for (const at of duplicates(rule.targets, targetKey))
      problems.push({ path: ['only', index, 'targets', at], message: 'a target named twice' });
  });
  prefer.forEach((rule, index) => {
    const kinds = new Set(rule.targets.map((target) => target.kind));
    if (kinds.size > 1)
      problems.push({
        path: ['prefer', index, 'targets'],
        message: 'a preference lists one kind: providers, services or accounts',
      });
    rule.targets.forEach((target, at) => {
      if (!PREFER_KINDS.includes(target.kind))
        problems.push({
          path: ['prefer', index, 'targets', at],
          message: 'a preference names providers, services or accounts',
        });
      else if (rule.scope.kind === 'global' && target.kind !== 'source')
        problems.push({
          path: ['prefer', index, 'targets', at],
          message: 'an every-task preference names accounts only',
        });
    });
    for (const at of duplicates(rule.targets, targetKey))
      problems.push({ path: ['prefer', index, 'targets', at], message: 'a target named twice' });
  });
  return problems;
}

/** The providers automatic use is narrowed to: never empty, providers only, each once. */
export const ReplacementProvidersSchema = z
  .array(TargetSchema)
  .min(1)
  .max(SETTINGS_LIMITS.targets)
  .superRefine((targets, ctx) => {
    targets.forEach((target, at) => {
      if (target.kind !== 'provider')
        ctx.addIssue({ code: 'custom', path: [at], message: 'a provider target' });
    });
    for (const at of duplicates(targets, targetKey))
      ctx.addIssue({ code: 'custom', path: [at], message: 'a provider named twice' });
  });

/**
 * JSON WITH ITS KEYS SORTED AT EVERY DEPTH, no whitespace, arrays in their
 * order: the one form the hash is taken over. An undefined value is left out,
 * as `JSON.stringify` leaves it out.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** `"sha256:" + hex(sha256(canonical JSON of {version, policy, replacement, sources}))`. */
export function settingsHash(fields: Omit<WireSettings, 'hash'>): string {
  const { version, policy, replacement, sources } = fields;
  const canonical = canonicalJson({ version, policy, replacement, sources });
  return `sha256:${sha256Hex(canonical)}`;
}

/**
 * THE SAVED `router.policy` (plan 36): what Tenjin may use, what it tries
 * first, and whether it offers paid tools that are only faster. The global
 * file's alone, like `improve`: a project file never reads it, so a cloned
 * repository cannot change what Tenjin may use on this machine. An emptied
 * collection is allowed and means no rules (a reset can leave one); an empty
 * target list is not. Every check beyond shape is {@link policyProblems}.
 */
export const SavedPolicyShapeSchema = z.strictObject({
  version: z.number().int(),
  block: z.array(TargetSchema).max(SETTINGS_LIMITS.block).optional(),
  only: z.array(OnlyRuleSchema).max(SETTINGS_LIMITS.only).optional(),
  prefer: z.array(PreferRuleSchema).max(SETTINGS_LIMITS.prefer).optional(),
  preferSpeed: z.boolean().optional(),
});
export const SavedPolicySchema = SavedPolicyShapeSchema.superRefine((policy, ctx) => {
  if (policy.version !== POLICY_VERSION) {
    ctx.addIssue({
      code: 'custom',
      path: ['version'],
      message: `version ${policy.version} is not one this build reads (${POLICY_VERSION})`,
    });
  }
  for (const { message, path } of policyProblems(policy))
    ctx.addIssue({ code: 'custom', message, path });
});
/** The saved rules, as `router.policy` holds them. */
export type SavedPolicy = z.infer<typeof SavedPolicyShapeSchema>;

/** Automatic use as it is saved: the mode and, when narrowed, its providers. */
export interface SavedReplacement {
  mode: ReplacementMode;
  providers?: Target[];
}

/** The rules as they go out: every empty collection and a false switch dropped. */
export function wirePolicy(saved: SavedPolicy | undefined): WirePolicy {
  if (saved === undefined) return {};
  return {
    ...(saved.block?.length ? { block: saved.block } : {}),
    ...(saved.only?.length ? { only: saved.only } : {}),
    ...(saved.prefer?.length ? { prefer: saved.prefer } : {}),
    ...(saved.preferSpeed === true ? { preferSpeed: true as const } : {}),
  };
}

/** True when the rules say anything at all. */
export function hasRules(policy: WirePolicy): boolean {
  return Object.keys(policy).length > 0;
}

/**
 * THE `settings` FIELD every routing call sends, also when the user has no
 * rules: the normalized policy, automatic use when it is on, the sources
 * usable on this machine (exactly Tenjin's own until accounts land), and
 * their hash.
 */
export function wireSettings(
  saved: SavedPolicy | undefined,
  replacement: SavedReplacement,
  sources: readonly string[] = [BUILT_IN_SOURCE],
): WireSettings {
  const fields: Omit<WireSettings, 'hash'> = {
    version: SETTINGS_VERSION,
    policy: wirePolicy(saved),
    ...(replacement.mode === 'when-routed'
      ? {
          replacement: {
            mode: 'when-routed' as const,
            ...(replacement.providers !== undefined ? { providers: replacement.providers } : {}),
          },
        }
      : {}),
    sources: [...sources],
  };
  return { ...fields, hash: settingsHash(fields) };
}
