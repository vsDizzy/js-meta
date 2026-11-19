# js-meta

A homoiconic runtime for JavaScript: code is data the program can read, change and print back, while it runs.

Clojure is the model, translated into what is canonical for JS: ESTree-shaped nodes, template literals as quasiquote, ES modules as namespaces.

```js
import { read, emit, walk, js, rule } from 'js-meta'

const ast = read('const total = add(price, add(tax, 1))')
const out = walk(ast, rule(js`add($a, $b)`, js`($a + $b)`))
emit(out) // 'const total = price + (tax + 1)\n'
```

## Code as data

- **`read(source, { filename })`** parses JS (and JSX) into nodes. Positions live in a side table (`originOf(node)`), and comments are nodes too.
- **`emit(ast)`** prints in one canonical style: no semicolons, ASI-safe. `read(emit(ast))` gives the same tree back. `emitWithMap(ast)` also returns a Source Map v3.
- **Nodes** are `{ type, ...attrs, children }`, with named accessors (`node.left` is `children[0]` of a `BinaryExpression`). `JSON.stringify` gives the plain form, and `toEstree` / `toNode` convert to and from ESTree.
- **Immutable values, JS-style edits.** Outside `edit()` nodes don't change. Inside, you assign as usual, and the copies share every untouched subtree:

  ```js
  const next = edit(ast, (draft) => {
    draft.body[0].declarations[0].id.name = 'sum'
  })
  ```

- **`walk(ast, fn | visitor)`** visits every node, comments included. A visitor has keys by type or alias (`Function`) and `enter` / `leave`. Return a node to replace the current one, `null` to remove it, nothing to keep it. The callback's context gives `parent`, `key`, `index`, `ancestors`, `prev` / `next` and `skip()`.
- **`scope(ast)`** gives bindings, references, free names, and `freshName` for hygiene.

## Quasiquote, patterns, rules

```js
const sum = js`${a} + ${b}`          // values go in by position
const call = js`f(${args})`          // an array splices into a list
const named = js.stmt`function ${'f'}() {}`  // a string is a name where only a name goes, else a string literal

const m = match(node, js`$a + $b`)   // { a, b } or null
match(node, js`f($$args)`)           // $$ captures a run of list elements
```

- **`js`** reads its template once per call site. It parses as an expression first, else as one statement. Use `js.stmt` (where `{}` is a block) and `js.stmts` (an array) when you need them, and `js.id(name)` for an identifier.
- **`match`** ignores comments, layout and literal spelling. A repeated variable must match equal code. `$_` and `$$_` match without capturing.
- **`rule(pattern, replacement)`** is a `walk` handler. The replacement is a template with the same `$` variables, a function of the captures, or `null` to remove the node. A rule fires outer forms first, like macroexpand, and nested forms expand inside the replacement. `rules(r1, r2, …)`: the first rule that fires wins.

Replacements carry no positions of their own, so a source map points an expansion at its call site.

## Live modules

```js
import { bootstrap, runtime, walk, rules } from 'js-meta'

const main = await bootstrap('./main.js', { transform: (ast) => walk(ast, macros) })

await runtime().redefine(url, newSource) // re-runs only the changed top-level forms
await runtime().eval(url, 'count')       // a REPL inside the module
runtime().records                        // url -> record: the live module graph
```

- **The module runtime** reads, expands (`transform`), lowers and runs every module of the app itself. It keeps a live registry of records with dependencies and importers.
  - Top-level bindings are cells in the module's `env`, like Clojure vars, and exports are getters over them.
  - Modules it doesn't read (bare specifiers, other origins, `.ts`) are loaded with native `import()`.
- **`redefine(url, source | ast)`** compares top-level forms by canonical text and runs only the new or changed ones in the same env.
  - State stays, and every caller by name reaches the new definition.
  - Removed bindings go away, and new imports are loaded.
- **`eval(url, code)`** runs code inside a module, with its bindings and imports in scope, and returns the last expression's value. `function inc() {}` there redefines `inc` for every caller by name.
- **`import.meta`** works as usual (`url`, `resolve`, `import()`). Lowering is a compile step that only generated code sees: users and macros work on plain ESM.

## Limits (v1)

- The browser and Node, single thread. Plain JS and JSX in modules the runtime reads; `.ts` files are loaded natively.
- Lowering of JSX and TS syntax before `eval` isn't there yet.
- No TDZ for top-level `let` / `const` in lowered modules: a cell reads `undefined` before its initializer runs.
- A saved file reloads the page: there is no file-change trigger for `redefine` yet.
- Side effects of a re-run form aren't disposed (no `import.meta.hot.dispose` yet).
- Macros must be valid JS syntax: no new operators or forms.

## Development

```bash
pnpm i
```

```bash
pnpm dev
```

```bash
pnpm test
```

```bash
pnpm exec tsc
```

- `pnpm dev` runs the demo (`src/app.ts`) on ts-code at http://localhost:3000. It boots `src/demo/main.js` with an `assert` macro, redefines a function live and evaluates code inside a module. The runtime is on `globalThis.meta` in the DevTools console.
- `pnpm test` runs the tests with `node --test`. `pnpm exec tsc` type-checks.
- Design notes and decisions are in [CLAUDE.md](CLAUDE.md).
