# js-meta

A homoiconic runtime for JavaScript: code is data the program can read, change and print back.

## Pieces

- **read** (`src/read/`, done): `read(source, { sourceType, filename })` returns an AST.
  - The parser sits behind an adapter (`Parser`). Today it is `@typescript-eslint/typescript-estree`; it can be swapped for another JS parser.
  - The output is ESTree (JS, JSX, TS types) as plain objects with no `range`/`loc`/`parent`. Positions live in a side table: `originOf(node)`.
  - Comments are nodes (`{type:'Comment', kind, value}`) placed in the nearest list, right before their owner. There is one canonical rule and no layout flags.
  - `filename` is a module URL.
- **emit** (`src/emit/`, done): `emit(ast)` returns code in one canonical style: no semicolons (ASI-safe), no line wrapping, literals printed from `raw`. It is round-trip stable: `read(emit(ast))` deep-equals `ast`, and `emit` reaches a fixed point after one pass.
- **Client API with `walk`** (planned): traversing and transforming the AST.
- **Module system** (planned): a module cache that starts out loaded from ESM, then mirrors the loaded modules live at runtime.
- **Loader** (planned): rewrites the imports in each `.js` file to point at our module system.

## Constraints

- Everything runs on the page, in the browser, in one thread, so the AST always matches the live code. The same code also runs in Node for tests.
- The dev server is `ts-code` (`pnpm dev`, port 3000). It transpiles TS→JS in a service worker and does livereload. Don't touch its runtime.
- Packages listed under `dependencies` are mapped to esm.sh by ts-code. Build options go in `package.json` → `"ts-code"."esm.sh"`. TypeScript is shared with the parser through `external=typescript`.
- The project targets JS. TS is supported only as far as ESTree carries it. A separate project may handle TS later.

## Dev

- Install: `pnpm i`. npm is blocked by `devEngines`.
- Tests: `pnpm test` (`node --test`; Node runs `.ts` directly). Imports use explicit `.ts` extensions. Don't add vitest.
- Type-check: `pnpm exec tsc` (`noEmit`, `erasableSyntaxOnly`).
- Discuss design with the user before coding new pieces.
