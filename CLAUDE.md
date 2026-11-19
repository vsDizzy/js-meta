# js-meta

A homoiconic runtime for JavaScript: code is data the program can read, change and print back.

**Guiding principle:** client ergonomics first. Working with code-as-data should feel like a breath of fresh air, not a chore. Clojure is the reference for homoiconicity, translated into what is canonical for JS.

## Pieces

- **read** (`src/read/`, done): `read(source, { sourceType, filename })` returns an AST.
  - The parser sits behind an adapter (`Parser`). Today it is `@typescript-eslint/typescript-estree`; it can be swapped for another JS parser.
  - The output is ESTree (JS, JSX, TS types) as plain objects with no `range`/`loc`/`parent`. Positions live in a side table: `originOf(node)`.
  - Comments are nodes (`{type:'Comment', kind, value}`) placed in the nearest list, right before their owner. There is one canonical rule and no layout flags.
  - `filename` is a module URL.
- **emit** (`src/emit/`, done): `emit(ast)` returns code in one canonical style: no semicolons (ASI-safe), no line wrapping, literals printed from `raw`. It is round-trip stable: `read(emit(ast))` deep-equals `ast`, and `emit` reaches a fixed point after one pass.
  - Printers return a Doc IR (`src/emit/doc.ts`): strings, arrays, `hardline`, `indent`, `mark(node, doc)`. It is plain data that one renderer lays out, Wadler/Prettier-style. Nothing wraps lines yet; `group`/`line` can be added later without touching printers. Decide formatting from the AST, not by inspecting printed text (`head(doc, n)` only where unavoidable).
  - `emitWithMap(ast)` returns `{ code, map }`, a Source Map v3 with `sourcesContent`. Each node start gets a segment at its origin, and Identifiers carry `names` (the source spelling, even after a rename). A node without an origin maps to its nearest ancestor that has one. `walk` gives a replacement without an origin the origin of the node it replaces, so a macro expansion maps to its call site. The loader decides how to attach the map.
  - Later: an API for printing user-defined node types (e.g. `define(type, slots, { print })`).
- **Client API with `walk`** (`src/ast/`, done; public entry `src/index.ts`): nodes, `edit`, `walk`, `b` builders, `toNode`/`toEstree`, `define(type, slots)`. The slot table lives in `src/ast/slots.ts` (seeded from visitor-keys, ours now). `read` throws on a node type or node-holding field missing from the table. A JSX `children` slot is accessed as `content`. Template literal lists (quasis/expressions) aren't interleaved, so they're the one place where slot order isn't source order.
  - Data form: an object `{ type, ...attrs, children }`, in the JS-canonical model of type + attributes + ordered children (JSX/DOM/unist). Children are positional slots: `null` for an empty slot, an array for a list of nodes (`children: [id, [a, b], body]`). Order lives in the structure, so `walk` is generic and needs no visitor-keys table.
  - Named access: one class per node type, with getters/setters mapping names to slots (`node.left` ↔ `children[0]`). `JSON.stringify` still gives the plain form. Builders (`b.binary('+', a, b)`) create class instances; `walk` also accepts bare objects, since it only needs `children`.
  - Immutable values outside, JS-style mutation inside a scoped `edit(ast, draft => { ... })` (like Clojure transients / Immer). Setters copy-on-write the node and its path to the root inside `edit`, and throw a helpful error outside it. Untouched subtrees stay `===` (structural sharing → cheap change detection and per-subtree `emit` caching). Copies inherit `originOf`. No `Object.freeze`.
  - Transform `walk` is postwalk-style: return a node to replace, `null` to remove, nothing to keep.
  - No `node.parent`: with structural sharing a node can have several parents, so context comes from the traversal. The callback gets `(node, ctx)`: `ctx.parent`, `ctx.key` (slot name), `ctx.index`, `ctx.ancestors`, `ctx.prev`/`ctx.next` (list siblings, handy for comments), `ctx.skip()`. Scope analysis is separate and lazy. A zipper (`cursor(ast)`) is possible later.
  - Visitor: `walk(ast, fn | visitor)`. A function is enter-for-all. An object has keys by type, group aliases (`Function` first, defined in the slot table), `{ enter, leave }` per key, and generic `enter`/`leave`. `walk` returns the new root (`===` if unchanged). A replacement from `leave` is postwalk; one from `enter` is prewalk (descend into the replacement's children without re-entering it, so nested macros expand with no loops). Selectors and visitor merging come later.
  - ESTree objects stay as the boundary with the outside world: the parser produces them and `emit` consumes them. The ESTree ↔ children conversion holds the only per-type slot table.
  - `walk` visits comments too.
  - Later: an optional JSX API layer for building nodes, and a tagged-template quasiquote (`` js`${a} + ${b}` ``, parsed by our `read`) for macros.
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
