/**
 * The files the Claude Code mod (`hosts/claude/tenjin/hooks/register.tsx`)
 * reads through `$.fs.read`; it writes none. Each is a contract versioned by
 * one field, and the mod treats an unknown version as absent, so a row says
 * less rather than something it did not read.
 *
 * | File | Writer | Version field | What the mod reads |
 * | --- | --- | --- | --- |
 * | `progress/specs/<sha256(id)>.json` | `specs.ts` `storeSpecs` | the spec's own schema | `id`, `label`, `priceAtomic`, `maxAmountAtomic`, `priceVaries`, `shown` (the one input a row may show, or null) |
 * | `progress/specs/<sha256(id)>.choices.json` | `specs.ts` `storeChoices` | the set's own schema | `choices.options[].key`, `.label`, `.id`: a choice call's name and its option's spec |
 * | `progress/specs/<sha256(id)>.label.json` | `specs.ts` `storeLabel` | none: `{id, label}`, `id` must be the call's | `label`: a free lookup's name, which has no spec |
 * | `progress/<sha256(session)>/offer-<sha256(tool_use_id)>.json` | `progress.ts` `markOffered` | `version: 1` | `offerId`, `label` |
 *
 * It also reads the request tool's result envelope (`tool.ts`) in the
 * transcript: `status`, `label`, `cost`, `reason`, and, for the expanded row,
 * `savedFiles` and `result` where `fullResultPath` says the CLI cut it to the
 * spec's fields. `mod-state.test.ts` pins the fields through each writer.
 */
export const MOD_STATE_FILES = ['spec', 'choices', 'label', 'offer'] as const;
