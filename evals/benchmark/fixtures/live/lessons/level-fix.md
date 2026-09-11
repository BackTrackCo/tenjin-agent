# level: replace the enum with a const object so Node can strip the file

`src/level.ts` declares `enum Level`, and the CLI test spawns `node src/cli.ts`, where Node's type stripping refuses an enum (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Keep the `Level` export and the `levelOf` rule; only the declaration changes:

    export const Level = { Low: 'low', High: 'high' } as const;
    export type Level = (typeof Level)[keyof typeof Level];

Re-run the one file with `pnpm exec vitest run tests/level.test.mjs`.
