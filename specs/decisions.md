# Decisions

A log of high-level design decisions, oldest first. Append, don't rewrite: when a decision is reversed, add a new entry that says so.

What was **chosen** is short, because the code and CLAUDE.md show it. What was **rejected** carries the reason, because nothing else records it.

## 2026-11-18

### The parser runs on the page, next to the AST

- **Chosen:** our own TypeScript and parser run on the page, in one thread with the AST and the running code.
- **Rejected:** reusing the parser inside ts-code's service worker. Another thread means serializing trees and keeping two copies in sync.

### ESTree behind a parser adapter

- **Chosen:** the parser sits behind an adapter and ESTree is the contract. Today the adapter is `@typescript-eslint/typescript-estree`, loaded from esm.sh.
- **Rejected:** converting `ts.SourceFile` straight into our format. It ties the format to one parser, and it means writing 80 to 170 node kinds by hand.
- **Rejected:** bundling typescript-estree ourselves with esbuild. esm.sh's `bundle&external=typescript` does the same with nothing to maintain.

### `read` keeps TS types

- **Chosen:** `read` returns everything ESTree carries, types included. Removing types is a transform, not the reader's job.
- **Rejected:** dropping types inside `read` (the first plan). The project still targets JS; a TS-first tool would be a separate project.

### Comments are nodes in lists, one rule, no flags

- **Chosen:** a comment is a node in the nearest enclosing list, right before its owner.
- **Rejected:** Babel-style `leadingComments` / `trailingComments`. A comment between `a` and `b` can be trailing on one or leading on the other, so one text gives two trees. `walk` does not see them either.
- **Rejected:** a separate `comments` array beside the tree. Homoiconic means a program can generate any JS, comments included.
- **Rejected:** layout flags such as `sameLine`. Line position is used once, at read time, to pick the owner, and never stored.
- **Rejected for now (reversed for block comments on 2026-11-20):** keeping the exact place of a comment that is not in a list (`if (/* c */ x)`, `a + /* c */ b`). The two candidates were a wrapper node `{ type: 'Commented', comments, node }`, which breaks `node.right.type === 'Identifier'`, and a per-field comment map, which `walk` would have to know about. Such comments are hoisted before the enclosing list element. Known cost: positional comments (`/* @__PURE__ */`, bundler magic comments in `import()`, JSDoc casts) move away from what they annotate.

### AST only, no CST

- **Rejected:** a CST as the main format. `a+b` and `a + b` would be different trees, generated code has no layout to keep, and every transform would have to preserve trivia.
- **Rejected:** recast-style output, where untouched nodes are printed verbatim from the source. It gives a byte-exact round trip but brings re-indentation and parenthesis problems. `emit` always reprints in the canonical style.

### Positions live in a side table

- **Chosen:** `originOf(node)`, a WeakMap.
- **Rejected:** `range` / `loc` on nodes. They break structural equality: `read('a+b')` must equal `read('a + b')`.

## 2026-11-19

### Our own printer, one style, no options

- **Chosen:** a printer of our own with one canonical style, like gofmt: no semicolons, no line wrapping, literals from `raw`.
- **Rejected:** astring (no TS or JSX), recast and prettier (they want their own trees), `ts.createPrinter` (needs a TS AST), esrap (comments only as `leadingComments`).

### Data form: `{ type, ...attrs, children }`

- **Chosen:** type plus attributes plus ordered children, as in JSX, DOM and unist. Order lives in the structure, so `walk` needs no key table.
- **Rejected:** reflection ("any field that holds a node is a child"). Traversal order would follow object key order, so a hand-built `{ operator, right, left }` is walked backwards.
- **Rejected:** a visitor-keys table consulted by `walk`. Order would live beside the data, not in it. The table survives in one place only, the ESTree conversion.
- **Rejected:** Lisp / hiccup arrays `[type, attrs, ...children]`. Closest to Clojure, but a niche form in JS, and `node[3]` is unreadable. The early idea of keeping both an object form and a list form (`toList` / `fromList`) was dropped with it.

### Named access through classes

- **Chosen:** one class per node type, with getters and setters over the slots.
- **Rejected:** free accessor functions (`left(node)`, `setLeft(node, x)`): wordy and not JS-like.
- **Rejected:** ESTree named fields as the stored form with a computed `children` view. That brings the key table back into `walk`.

### Immutable values, mutation inside `edit`

- **Chosen:** immutable trees with structural sharing; JS-style mutation inside `edit(ast, draft => ...)`, like Clojure transients.
- **Rejected:** mutable nodes (Babel, ESLint). One node placed in two spots changes in both, and finding what changed for live modules would need observers or dirty flags. With sharing it is a `===` check.
- **Rejected:** a purely immutable API (`node.with({ ... })`): deep edits by hand are a chore.
- **Rejected:** `Object.freeze` (a cost on every node) and an Immer-style Proxy (not needed, we own the setters).

### Context comes from the traversal

- **Chosen:** `walk` passes a light `ctx`. Scope analysis is a separate, lazy `scope(ast)`.
- **Rejected:** `node.parent`. With structural sharing a node has several parents.
- **Rejected:** estraverse-style positional arguments `(node, parent, key, index)`: one level up only, and hard to extend.
- **Rejected:** a Babel-style `NodePath`: an object per node, scope computed whether needed or not, mutation methods that fight "return a node to replace", stale paths after edits.
- **Deferred:** a zipper (`cursor(ast)`), selectors, visitor merging.

### Printer on a Doc IR, source maps from a separate function

- **Chosen:** printers return a Doc (plain data) and one renderer lays it out. `emitWithMap` is a separate function.
- **Rejected:** invisible marker characters inside printed strings. Smallest change, but `.length` and `startsWith` on a child's output would silently lie to anyone writing a printer for their own node type.
- **Rejected:** an imperative writer (`w.write(...)`). A printer becomes a sequence of side effects that cannot be inspected or tested as a value, and line wrapping stays hard.
- **Rejected:** `emit(ast, { sourceMap: true })` (the return type would depend on a flag) and an inline `sourceMappingURL` comment in `emit`'s output.
- **Rejected:** a mapping per token. Node starts plus identifier names are close enough.
- **Principle from this decision:** choose by what is convenient for us and for the client, not by the amount of work.

### Source maps before the loader

- **Chosen:** build source maps first. The loader runs `emit` output, and without maps the first real module would already show rewritten code in DevTools.

### Own module format and runtime

- **Chosen:** modules are records in a registry and exports are getters (like Vite SSR and SystemJS). Every import goes through the runtime, so the import graph is live. Modules we do not parse (esm.sh, bare specifiers, `.ts`) are native imports wrapped as records.
- **Rejected:** native ESM through `blob:` URLs. Cycles are impossible (each blob needs the other's URL first), `import.meta.url` becomes `blob:...`, and ESM instances are immutable, so a module cannot be redefined live.
- **Rejected:** our own service worker serving rewritten modules. A scope has one service worker and ts-code owns it. It is also another thread, the sync problem again.
- **Accepted cost:** code runs through `eval`, which a strict CSP forbids. Fine for a dev runtime.

### The per-module object is `import.meta`

- **Chosen:** `import.meta.import()` / `import.meta.export()`, lowered to a hygienically named wrapper parameter. No globals. The global runtime API is exported from the package.
- **Rejected:** a global `__meta`, or separate `__import` / `__export` functions as in Vite SSR. `import` is a reserved word, so the names must be mangled, and each needs its own hygiene.
- **Rejected:** `ns`. In ESM a "namespace" is the exports object of another module, so `ns.import('./b.js')` reads wrong.
- **Rejected:** `module` (with `module.define` for exports). Good meaning, but it echoes CommonJS and AMD. Dropped once `import.meta` came up: that is the object the host already gives each module.
- **Rejected:** `runtime.import` / `js.import`. They suggest one global object, but the object is per module (relative resolution, its own URL).
- **Known risk:** TC39 could one day define `import.meta.import`. The rename would be mechanical.

### Lowering is a compile step

- **Chosen:** users, macros and the live graph see canonical `import` / `export`. The lowered form exists only in generated code and source maps hide it.
- **Rejected:** treating the rewritten module as the form people and macros work on.

### Our own `scope()`

- **Rejected:** eslint-scope. It needs ESTree with parent links, mutates the tree, and its results would have to be mapped back to our nodes.

### Live redefinition per top-level form

- **Chosen:** Clojure-var style. Top-level bindings are cells in the module's env, and `redefine` re-runs only the forms whose canonical `emit` text changed.
- **Rejected:** HMR-style re-run of the whole module as the model. State resets on every edit, side effects repeat, and callbacks already handed out stay old.
- **Accepted cost:** no TDZ for top-level `let` / `const`, and env access is slower than a local.

### No file-change trigger yet

- **Chosen:** a full page reload on save. Revisit after ts-code is redesigned.
- **Rejected for now:** a hook in ts-code's livereload client. The client always reloads and has no extension point, and its design is about to change.
- **Rejected:** replacing `window.EventSource` before livereload loads (fragile, order-dependent) and our own file watcher (ts-code reloads the page anyway).

### Quasiquote and `match`

- **Chosen:** `${value}` always means "a value from JS". Pattern variables are written in the text: `$a`, `$$a`, `$_`.
- **Rejected:** a string in a hole as a capture name (`` js`${'a'} + ${'b'}` ``). `${}` would mean different things in templates and in patterns.
- **Rejected:** marker objects (`const a = hole()`): unambiguous but wordy.
- **Chosen:** `js` reads an expression first, then a statement; `js.stmt` and `js.stmts` are strict.
- **Rejected:** program-first parsing: `{ a }` would become a block, a trap in patterns like `{ $$props }`.
- **Rejected:** explicit tags only, as in `@babel/template`: the caller thinks about grammar at every call.
- **Rejected:** `js` returning an array for several statements. One tag, one result type; several statements are an error that points to `js.stmts`.
- **Chosen:** a string in expression position is a string literal, so data never turns into code. `js.id(name)` makes an identifier.
- **Rejected:** plain objects and arrays as data literals in holes. An array already means "splice".

### Macros stay inside valid JS

- **Chosen:** macros are calls and other valid syntax, expanded by rules through the runtime's `transform` hook. Rules fire outer form first, like macroexpand.
- **Rejected:** extending the parser for new syntax (the META II direction). Not needed yet, and it would tie us to one parser's plugin system.

### Dependencies come through ts-code's generated import map

- **Chosen:** ts-code builds the import map from `dependencies`. Per-package esm.sh build options are a raw query string in `package.json` under `"ts-code"."esm.sh"`.
- **Rejected:** a hand-written import map in `index.html`. It worked only because of the order in which ts-code inserts its own map.
- **Rejected:** marking every dependency `external` for every other one automatically. Adding any dependency would change every URL, which drops the browser cache and makes esm.sh rebuild.
- **Rejected:** structured options (`"bundle": [...]`, `"external": {...}`). ts-code would have to support each esm.sh option separately.
- **Rejected:** `deps=typescript@x` in the query. It bakes the version into the esm.sh build; `external` lets the import map supply it.
- **Reverted:** installing ts-code from git. Node refuses to strip types under `node_modules`, so it stays a `link:` dependency.

## 2026-11-20

### Block comments outside lists stay in place

Reverses "Rejected for now" in the 2026-11-18 comments entry. The trigger: hoisting moved `/* @__PURE__ */` and bundler magic comments off the call they annotate (`const x = /* @__PURE__ */ f()` printed as `const /* @__PURE__ */ x = f()`).

- **Chosen:** a block comment in no list is a leading comment of the node after it, kept in that node's `comments` attribute. The owner is the outermost node starting there, so one text still gives one tree. `walk` visits these comments, and a replacement inherits them like the origin.
- **Rejected:** the comment inside the slot, next to its node (`children[0]` holds `[comment, expr]`, the getter returns `expr`). It breaks "a slot is a node, null or a list", which `walk`, `match`, quasiquote, `scope` and `lower` all rely on, and every reader of raw `children` would meet a third shape.
- **Rejected again:** the wrapper node, for the same reason as before.
- **Rejected:** making every comment a leading comment and dropping Comment nodes from lists (the Babel model made canonical). It would fix `arguments.length` seeing comments, but a comment at the end of a block has no node to lead, and `ctx.prev` / `ctx.next` for JSDoc would go.
- **Rejected for now:** line comments in place. `//` inside an expression needs a forced line break, and after `return` / `throw` that changes the meaning. They are still hoisted.
- **Accepted cost:** two homes for comments (list sibling, `comments` attribute). Parentheses are not kept, so a JSDoc cast `/** @type {T} */ (x)` keeps its comment but loses the parentheses tsc needs.

### Line comments outside lists stay in place

Reverses "Rejected for now: line comments in place" in the entry above.

- **Chosen:** a `//` comment in no list leads the node after it, like a block comment. `emit` prints it, breaks the line and indents the continuation. After `return` / `throw` / `yield` the argument goes in parentheses (`return (// c`). A name after a dot gets the comment before the dot, because TS does not parse `a.` + newline + `b as T`.
- **Chosen:** where a line break would change the meaning and parentheses cannot help, `read` still hoists and `emit` throws for hand-built trees. One table (`sameLine()` in `src/read/comments.ts`): the label of `break` / `continue`, a member key after `async` / `accessor` / a TS modifier, the name after `asserts`, type parameters of an `async` arrow, a parameter property, the id of `type` / `interface` / `namespace`.
- **Rejected:** turning such a line comment into a block comment. It changes the comment's kind, and `*/` in the text cannot be kept.

### JSDoc casts keep their parentheses, nothing else does

- **Chosen:** a block comment that starts with `* @type` or `* @satisfies` and is followed on the same line by a grouping `(` is a leading comment of the expression inside the parentheses (`a` in `/** @type {T} */ (a).b`). `emit` always prints such a node as `/** … */ (node)`.
- **Rejected:** a `parenthesized` attribute on every node. `a+b` and `(a+b)` would be different trees, and `match` and `redefine` would have to ignore it.
- **Rejected:** the comment on the outermost node that starts there, with parentheses around it. `/** @type {T} */ (a).b` would come back as a cast of `a.b`.
- **Rejected:** any whitespace between the comment and `(`. A JSDoc comment printed on its own line before a statement or element that starts with `(` would read back as a cast. `emit` keeps a line break between a non-cast JSDoc and a following `(`.
- **Accepted cost:** `x = /** @type {T} */ a` gets parentheses after `emit` and becomes a cast. A cast written with a line break before `(` is not kept.

### A comment in a pattern is a requirement

- **Chosen:** comments in the target are ignored unless the pattern has some. A pattern comment must be found in front of the node it leads (its `comments` plus the Comment siblings before it): same kind and trimmed text, or a variable (`/* $c */`, `/** $doc */` for JSDoc only, `/* $$cs */` for all). In a replacement template the same forms put the captures back; `/* ${c} */` is a comment hole in `js`. `match(node, pattern, ctx)` takes the walk `ctx` for the siblings before the root.
- **Chosen:** a `$$a` run is the real slice of the list, comments included. Comments go with the element they are in front of; the last run also takes the list's trailing comments.
- **Chosen:** a value put into a list through a hole brings its `comments` along as siblings before it, the form `read` gives.
- **Rejected:** waiting for predicates in patterns. The text form reads as code and needs no new API.
- **Rejected:** `$$a` as code only (the old behaviour). A rule `{ $$body }` → `{ $$body }` stripped the comments from the body.
- **Rejected:** a greedy `$$` comment variable. It takes the gap between its neighbours' matches, so `/* $$a */ /* @x */ /* $$b */` has one answer.
- **Rejected:** an error when a replacement moves a sibling comment. It is a documented copy until `walk` can replace the comments before a node.
