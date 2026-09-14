# Node runs TypeScript by stripping types, and refuses an `enum`

Node 24 runs a `.ts` file directly by erasing type syntax; it does not compile. Syntax that needs generated code is refused at load time: `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode`, and the same goes for `namespace`, parameter properties, and `const enum`. Vitest transpiles through esbuild, so an `enum` runs fine under the test runner and fails only where the file meets Node itself, such as a CLI the test spawns.

Replace the enum with a constant object and a type derived from it, which erases cleanly and keeps the same names:

    export const Level = { Low: 'low', High: 'high' } as const;
    export type Level = (typeof Level)[keyof typeof Level];
