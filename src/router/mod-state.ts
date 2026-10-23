/**
 * WHAT THE CLAUDE CODE MOD READS, AND NOTHING IT WRITES. The mod
 * (`hosts/claude/tenjin/hooks/register.tsx`) draws from three files the CLI
 * already keeps under its data dir, through `$.fs.read`, reads the
 * automatic-use switch from the global config, and reads the request tool's
 * own result envelope in the transcript. Each file is a contract between the
 * two, versioned by one field, and the mod reads a file whose version it does
 * not know as absent: a row then says less, never something it did not read.
 *
 * | File | Writer | Version field | What the mod reads |
 * | --- | --- | --- | --- |
 * | `progress/specs/<sha256(id)>.json` | `specs.ts` `storeSpecs` | the spec's own schema | `id`, `label`, `priceAtomic`, `maxAmountAtomic`, `priceVaries`, `shown` (the one input a row may show, or null) |
 * | `progress/specs/<sha256(id)>.choices.json` | `specs.ts` `storeChoices` | the set's own schema | `choices.options[].key`, `.label`, `.id`: a choice call's name and its option's spec |
 * | `progress/<sha256(session)>/offer-<sha256(tool_use_id)>.json` | `progress.ts` `markOffered` | `version: 1` | `offerId`, `label`, `priceAtomic`, `swap` (the call was answered in place) |
 * | `config.json` | `commands/config.ts` `persist` | none: a value it does not know is off | `router.nativeReplacement` (`when-routed` is on) and `router.enabled` (`false` is paused): whether to ask the request tool's `decide` form at all. The CLI reads both again before anything runs. |
 *
 * From the envelope (`tool.ts`): `status`, `label`, `cost`, `reason`, `via`
 * (`swap` on a lookup run in a native call's place), and, for the expanded
 * row, `savedFiles` and `result` where `fullResultPath` says the CLI cut it
 * to the spec's fields. `mod-state.test.ts` writes each file through its CLI
 * writer and pins the fields.
 */
export const MOD_STATE_FILES = ['spec', 'choices', 'offer', 'config'] as const;
